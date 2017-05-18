/*jslint node: true */
"use strict";
var moment = require('moment');
var request = require('request');
var _ = require('lodash');
var conf = require('byteballcore/conf.js');
var db = require('byteballcore/db.js');
var eventBus = require('byteballcore/event_bus.js');
var headlessWallet = require('headless-byteball');
var desktopApp = require('byteballcore/desktop_app.js');
var objectHash = require('byteballcore/object_hash.js');
var notifications = require('./notifications.js');

if (conf.bRunWitness)
	require('byteball-witness');

const RETRY_TIMEOUT = 5*60*1000;
var assocQueuedDataFeeds = {};
var assocDeviceAddressesByFeedName = {};

const WITNESSING_COST = 600; // size of typical witnessing unit
var my_address;
var count_witnessings_available = 0;

if (!conf.bSingleAddress)
	throw Error('oracle must be single address');

if (!conf.bRunWitness)
	headlessWallet.setupChatEventHandlers();

// this duplicates witness code if we are also running a witness
function readNumberOfWitnessingsAvailable(handleNumber){
	count_witnessings_available--;
	if (count_witnessings_available > conf.MIN_AVAILABLE_WITNESSINGS)
		return handleNumber(count_witnessings_available);
	db.query(
		"SELECT COUNT(*) AS count_big_outputs FROM outputs JOIN units USING(unit) \n\
		WHERE address=? AND is_stable=1 AND amount>=? AND asset IS NULL AND is_spent=0", 
		[my_address, WITNESSING_COST], 
		function(rows){
			var count_big_outputs = rows[0].count_big_outputs;
			db.query(
				"SELECT SUM(amount) AS total FROM outputs JOIN units USING(unit) \n\
				WHERE address=? AND is_stable=1 AND amount<? AND asset IS NULL AND is_spent=0 \n\
				UNION \n\
				SELECT SUM(amount) AS total FROM witnessing_outputs \n\
				WHERE address=? AND is_spent=0 \n\
				UNION \n\
				SELECT SUM(amount) AS total FROM headers_commission_outputs \n\
				WHERE address=? AND is_spent=0", 
				[my_address, WITNESSING_COST, my_address, my_address], 
				function(rows){
					var total = rows.reduce(function(prev, row){ return (prev + row.total); }, 0);
					var count_witnessings_paid_by_small_outputs_and_commissions = Math.round(total / WITNESSING_COST);
					count_witnessings_available = count_big_outputs + count_witnessings_paid_by_small_outputs_and_commissions;
					handleNumber(count_witnessings_available);
				}
			);
		}
	);
}


// make sure we never run out of spendable (stable) outputs. Keep the number above a threshold, and if it drops below, produce more outputs than consume.
function createOptimalOutputs(handleOutputs){
	var arrOutputs = [{amount: 0, address: my_address}];
	readNumberOfWitnessingsAvailable(function(count){
		if (count > conf.MIN_AVAILABLE_WITNESSINGS)
			return handleOutputs(arrOutputs);
		// try to split the biggest output in two
		db.query(
			"SELECT amount FROM outputs JOIN units USING(unit) \n\
			WHERE address=? AND is_stable=1 AND amount>=? AND asset IS NULL AND is_spent=0 \n\
			ORDER BY amount DESC LIMIT 1", 
			[my_address, 2*WITNESSING_COST],
			function(rows){
				if (rows.length === 0){
					notifications.notifyAdminAboutPostingProblem('only '+count+" spendable outputs left, and can't add more");
					return handleOutputs(arrOutputs);
				}
				var amount = rows[0].amount;
			//	notifications.notifyAdminAboutPostingProblem('only '+count+" spendable outputs left, will split an output of "+amount);
				arrOutputs.push({amount: Math.round(amount/2), address: my_address});
				handleOutputs(arrOutputs);
			}
		);
	});
}



////////


function postDataFeed(datafeed, onDone){
	function onError(err){
		notifications.notifyAdminAboutFailedPosting(err);
		onDone(err);
	}
	var network = require('byteballcore/network.js');
	var composer = require('byteballcore/composer.js');
	createOptimalOutputs(function(arrOutputs){
		let params = {
			paying_addresses: [my_address], 
			outputs: arrOutputs, 
			signer: headlessWallet.signer, 
			callbacks: composer.getSavingCallbacks({
				ifNotEnoughFunds: onError,
				ifError: onError,
				ifOk: function(objJoint){
					network.broadcastJoint(objJoint);
					onDone();
				}
			})
		};
		if (conf.bPostTimestamp)
			datafeed.timestamp = Date.now();
		let objMessage = {
			app: "data_feed",
			payload_location: "inline",
			payload_hash: objectHash.getBase64Hash(datafeed),
			payload: datafeed
		};
		params.messages = [objMessage];
		composer.composeJoint(params);
	});
}

function reliablyPostDataFeed(datafeed, device_address){
	var feed_name;
	for(var key in datafeed){
		feed_name = key;
		break;
	}
	if (!feed_name)
		throw Error('no feed name');
	if (device_address){
		if (!assocDeviceAddressesByFeedName[feed_name])
			assocDeviceAddressesByFeedName[feed_name] = [device_address];
		else
			assocDeviceAddressesByFeedName[feed_name].push(device_address);
	}
	if (assocQueuedDataFeeds[feed_name]) // already queued
		return console.log(feed_name+" already queued");
	assocQueuedDataFeeds[feed_name] = datafeed;
	var onDataFeedResult = function(err){
		if (err){
			console.log('will retry posting the data feed later');
			setTimeout(function(){
				postDataFeed(datafeed, onDataFeedResult);
			}, RETRY_TIMEOUT + Math.round(Math.random()*3000));
		}
		else
			delete assocQueuedDataFeeds[feed_name];
	};
	postDataFeed(datafeed, onDataFeedResult);
}


function readExistingData(feed_name, device_address, handleResult){
	if (assocQueuedDataFeeds[feed_name]){
		assocDeviceAddressesByFeedName[feed_name].push(device_address);
		return handleResult(true, 0);
	}
	db.query(
		"SELECT feed_name, is_stable \n\
		FROM data_feeds CROSS JOIN unit_authors USING(unit) CROSS JOIN units USING(unit) \n\
		WHERE address=? AND feed_name=?", 
		[my_address, feed_name],
		function(rows){
			if(rows.length === 0) return handleResult(false);
			if (!rows[0].is_stable){
				if (!assocDeviceAddressesByFeedName[feed_name])
					assocDeviceAddressesByFeedName[feed_name] = [device_address];
				else
					assocDeviceAddressesByFeedName[feed_name].push(device_address);
			}
			return handleResult(true, rows[0].is_stable);
		}
	);
}

function getInstruction(){
	return "Please write the team names in the format: \n name1 / name2 \nExample: Manchester City / West Bromwich Albion";
}

eventBus.on('paired', function(from_address){
	var device = require('byteballcore/device.js');
	device.sendMessageToDevice(from_address, 'text', getInstruction());
});

function removeAbreviaturas(text) {
	return text.replace(/\b(FC|AS|CF|RC)\b/g, '').trim();
}

eventBus.on('text', function(from_address, text){
	var device = require('byteballcore/device.js');
	text = text.trim();
	let ucText = text.toUpperCase();
	
	if(ucText.indexOf('/') !== -1 || ucText.indexOf(' VS ') !== -1 || ucText.indexOf(' VS. ') !== -1 || ucText.indexOf(' - ') !== -1) {
		var splitText;
		if(ucText.indexOf('/') !== -1) splitText = ucText.split('/');
		else if(ucText.indexOf(' VS ') !== -1) splitText = ucText.split(' VS ');
		else if(ucText.indexOf(' VS. ') !== -1) splitText = ucText.split(' VS. ');
		else if(ucText.indexOf(' - ') !== -1) splitText = ucText.split( ' - ');
		
		if(splitText.length === 2) {
			var homeTeamName = removeAbreviaturas(splitText[0]).replace(/\s/g,'');
			var awayTeamName = removeAbreviaturas(splitText[1]).replace(/\s/g,'');
			
			request({
				url: 'http://api.football-data.org/v1/fixtures/?timeFrame=p3',
				headers:{
					'X-Auth-Token': conf.footballDataApiKey
				}
			}, function(error, response, body) {
				if (error || response.statusCode !== 200){
					notifications.notifyAdminAboutPostingProblem("getting football data failed: "+error+", status="+response.statusCode);
					return device.sendMessageToDevice(from_address, 'text', "Failed to fetch football data.");
				}
				console.log('response:\n'+body);
				var jsonResult = JSON.parse(body);
				var fixtures = jsonResult.fixtures;
				var result = '';
				
				for(var i = jsonResult.count - 1; i >= 0; i--) {
					var fixtureHomeTeamName = removeAbreviaturas(fixtures[i].homeTeamName).replace(/\s/g,'').toUpperCase();
					var fixtureAwayTeamName = removeAbreviaturas(fixtures[i].awayTeamName).replace(/\s/g,'').toUpperCase();
					
					if((fixtureHomeTeamName === homeTeamName && fixtureAwayTeamName  === awayTeamName) || (fixtureHomeTeamName === awayTeamName && fixtureAwayTeamName  === homeTeamName)) {
						if (fixtures[i].result.goalsHomeTeam === fixtures[i].result.goalsAwayTeam) {
							result = 'draw';
						} else if (fixtures[i].result.goalsHomeTeam > fixtures[i].result.goalsAwayTeam) {
							result = removeAbreviaturas(fixtures[i].homeTeamName);
						} else {
							result = removeAbreviaturas(fixtures[i].awayTeamName);
						}
						
						var feed_name = '_'+ fixtureHomeTeamName + '_' + fixtureAwayTeamName + '_' + moment.utc(fixtures[i].date).format("DD-MM-YYYY");
						db.query("INSERT INTO fd_responses (device_address, feed_name, response) VALUES(?,?,?)", [from_address, feed_name, body], function(){});
						
						readExistingData(feed_name, from_address, function(exists, is_stable) {
							if(!exists) {
								var datafeed = {};
								datafeed[feed_name] = result.toUpperCase();
								reliablyPostDataFeed(datafeed, from_address);
							}
							var message = removeAbreviaturas(fixtures[i].homeTeamName) + ' VS ' + removeAbreviaturas(fixtures[i].awayTeamName) + ' ' 
								+ moment.utc(fixtures[i].date).format("DD-MMMM-YYYY")+ ', ' 
								+ (result === 'draw' ? 'draw' : result + ' won') 
								+ (is_stable 
									? "\n\nThe data is already in the database, you can unlock your smart contract now."
									: "\n\nThe data will be added into the database, I'll let you know when it is confirmed and you are able to unlock your contract.");
							device.sendMessageToDevice(from_address, 'text', message)
						});
						return;
					}
				}
				return device.sendMessageToDevice(from_address, 'text', 'Not found');
			});
		}else{
			return device.sendMessageToDevice(from_address, 'text', getInstruction());
		}
		return;
	}
	
	return device.sendMessageToDevice(from_address, 'text', getInstruction());
});

eventBus.on('my_transactions_became_stable', function(arrUnits){
	var device = require('byteballcore/device.js');
	db.query("SELECT feed_name FROM data_feeds WHERE unit IN(?)", [arrUnits], function(rows){
		rows.forEach(row => {
			let feed_name = row.feed_name;
			if (!assocDeviceAddressesByFeedName[feed_name])
				return;
			let arrDeviceAddresses = _.uniq(assocDeviceAddressesByFeedName[feed_name]);
			arrDeviceAddresses.forEach(device_address => {
				device.sendMessageToDevice(device_address, 'text', "The data about your football "+feed_name+" is now in the database, you can unlock your contract.");
			});
			delete assocDeviceAddressesByFeedName[feed_name];
		});
	});
});


//////

eventBus.on('headless_wallet_ready', function(){
	if (!conf.admin_email || !conf.from_email){
		console.log("please specify admin_email and from_email in your "+desktopApp.getAppDataDir()+'/conf.json');
		process.exit(1);
	}
	if (!conf.footballDataApiKey){
		console.log("please specify footballDataApiKey in your "+desktopApp.getAppDataDir()+'/conf.json');
		process.exit(1);
	}
	headlessWallet.readSingleAddress(function(address){
		my_address = address;
	});
});
