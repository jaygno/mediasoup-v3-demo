#!/usr/bin/env node

process.title = 'v3-demo-server';
process.env.DEBUG = process.env.DEBUG || '*INFO* *WARN* *ERROR* *DEBUG*';
process.on('uncaughtException', (err) => {
    console.log(err);
});

const config = require('./config');

/* eslint-disable no-console */
console.log('- config.mediasoup.numWorkers:', config.mediasoup.numWorkers);
console.log('- process.env.DEBUG:', process.env.DEBUG);
console.log(
	'- config.mediasoup.workerSettings.logLevel:',
	config.mediasoup.workerSettings.logLevel);
console.log(
	'- config.mediasoup.workerSettings.logTags:',
	config.mediasoup.workerSettings.logTags);
/* eslint-enable no-console */

const fs = require('fs');
const https = require('https');
const url = require('url');
const socketio = require('socket.io');
const mediasoup = require('mediasoup');
const express = require('express');
const bodyParser = require('body-parser');
const AwaitQueue = require('awaitqueue');
const Logger = require('./lib/Logger');
const Room = require('./lib/Room');

const logger = new Logger();

// Async queue to manage rooms.
// @type {AwaitQueue}
const queue = new AwaitQueue();

// Map of Room instances indexed by roomId.
// @type {Map<Number, Room>}
const rooms = new Map();

const sockets = new Map();

// HTTPS server.
// @type {https.Server}
let httpsServer;

let io;

// Express application.
// @type {Function}
let expressApp;

// Protoo WebSocket server.
// @type {protoo.WebSocketServer}
let protooWebSocketServer;

// mediasoup Workers.
// @type {Array<mediasoup.Worker>}
const mediasoupWorkers = [];

// Index of next mediasoup Worker to use.
// @type {Number}
let nextMediasoupWorkerIdx = 0;

run();

async function run()
{
	// Run a mediasoup Worker.
	await runMediasoupWorkers();

	// Run HTTPS server.
	await runHttpsServer();
    
    await runSocketIo();

	// Log rooms status every 30 seconds.
	setInterval(() =>
	{
		for (const room of rooms.values())
		{
			room.logStatus();
		}
	}, 120000);
}

/**
 * Launch as many mediasoup Workers as given in the configuration file.
 */
async function runMediasoupWorkers()
{
	const { numWorkers } = config.mediasoup;

	logger.info('running %d mediasoup Workers... version is %s', numWorkers, mediasoup.version);
    
    mediasoup.observer.on("newworker", (worker) => {

        logger.info("observer new worker created [pid:%d']", worker.pid);

        worker.observer.on("newrouter", (router) => {
            logger.info("observer new router create [id:%s]", router.id);

            router.observer.on("close", () => {
                logger.info("observer router close [id:%s]", router.id);
            });

            router.observer.on("newtransport", (transport) => {
                logger.info("observer new transport create [id:%s]", transport.id);
            });
        });

        worker.observer.on("close", () => {
            logger.info("observer worker closed [pid:%d]", worker.id);
        });
    }); 

	for (let i = 0; i < numWorkers; ++i)
	{
		const worker = await mediasoup.createWorker(
			{
				logLevel   : config.mediasoup.workerSettings.logLevel,
				logTags    : config.mediasoup.workerSettings.logTags,
				rtcMinPort : config.mediasoup.workerSettings.rtcMinPort,
				rtcMaxPort : config.mediasoup.workerSettings.rtcMaxPort
			});

		worker.on('died', () =>
		{
			logger.error(
				'mediasoup Worker died, exiting  in 2 seconds... [pid:%d]', worker.pid);

			setTimeout(() => process.exit(1), 2000);
		});

		mediasoupWorkers.push(worker);
	}
}

/**
 * Create a Node.js HTTPS server. It listens in the IP and port given in the
 * configuration file and reuses the Express application as request listener.
 */
async function runHttpsServer()
{

	// HTTPS server for the protoo WebSocket server.
	const tls =
	{
		cert : fs.readFileSync(config.https.tls.cert),
		key  : fs.readFileSync(config.https.tls.key)
	};

    expressApp = express();

	httpsServer = https.createServer(tls, expressApp);

    try {
        expressApp.use('/', express.static(__dirname + '/public'));
    } catch (error) {
        logger.info(error);
    }
	await new Promise((resolve) =>
	{
		httpsServer.listen(config.https.listenPort, config.https.listenIp, resolve);
	    logger.info('running an HTTPS server...https://%s:%s/index.html', config.https.listenIp, config.https.listenPort);
	});
}

async function runSocketIo()
{
    io = socketio(httpsServer);
    logger.info('init socketio event.');
    io.on('connection', function(socket) {
        logger.info('Socket io connection.');

        socket.on('join', async function(msg) {
            logger.info('Socket io recv join info.');
            const room = await getOrCreateRoom({ roomId:msg.roomId, forceH264:msg.forceH264, forceVP9:msg.forceVP9 });

            sockets.set(socket, room);

            room.handlePeer(socket, msg.peerId);

            socket.emit('joinsuccess');
        });

        socket.on('disconnect', function(msg) {
             logger.info("socket io disconnect.", msg);
             let room = sockets.get(socket);
             sockets.delete(socket);
             if (room) {
                 room.removePeer(socket);
                 if(sockets.size === 0) {
                   logger.info("destroy room");
                   room.close();
                 }
             }
        });
    });

}

/**
 * Get next mediasoup Worker.
 */
function getMediasoupWorker()
{
	const worker = mediasoupWorkers[nextMediasoupWorkerIdx];

	if (++nextMediasoupWorkerIdx === mediasoupWorkers.length)
		nextMediasoupWorkerIdx = 0;

	return worker;
}

/**
 * Get a Room instance (or create one if it does not exist).
 */
async function getOrCreateRoom({ socket, roomId, forceH264 = false, forceVP9 = false })
{
	let room = rooms.get(roomId);

	// If the Room does not exist create a new one.
	if (!room)
	{
		logger.info('creating a new Room [roomId:%s]', roomId);

		const mediasoupWorker = getMediasoupWorker();

		room = await Room.create({ socket, mediasoupWorker, roomId, forceH264, forceVP9 });

		rooms.set(roomId, room);
		room.on('close', () => rooms.delete(roomId));
	}

	return room;
}
