const EventEmitter = require('events').EventEmitter;
const throttle = require('@sitespeed.io/throttle');
const Logger = require('./Logger');
const config = require('../config');
const Bot = require('./Bot');

const logger = new Logger('Room');

class Peer extends EventEmitter
{
    constructor(peerId, socket, mediasoupRouter)
    {
        super();
        this._peerId = peerId;
        this._socket = socket;
        
        this._transports = new Map();
        this._producers = new Map();
        this._consumers = new Map();
        this._mediasoupRouter = mediasoupRouter;
        logger.info("constructor Peer [id:%s]", peerId);
    }

    notifyRoom(event, data)
    {
        this.emit(event, data);
    }
    
    notifyClient(event, data)
    {
        this._socket.emit(event, data);
    }

    get socket()
    {
        return this._socket;
    }

    get id()
    {
        return this._peerId;
    }

    get transportId()
    {
        logger.info("call transportId start");
        for (let [id, transport] of this._transports) 
        {
            if (transport.appData.producing) {
                return id;
            }
        }
        logger.info("call transportId finish");
    }

    get producers()
    {
        let data = [];

        logger.info("call producers start");
        for (let [id, producer] of this._producers) 
        {
            if (producer.kind) {
                data.push(id);
            }
        }
        logger.info("call producers finish");
        return data;
    }

    init()
    {
        this._socket.on('rtpcapabilities', () => {
            logger.info('request rtpcapabilities');
            this._socket.emit('rtpcapabilities', this._mediasoupRouter.rtpCapabilities);
        });

        this._socket.on('createTransport', async (msg) => {
            logger.info('createTransport:', msg);
   
            const {
                forceTcp,
                producing,
                consuming,
                sctpCapabilities,
                appData
            } = msg;

            let transport = await this.createTransport(forceTcp, producing, consuming, (sctpCapabilities || {}).numStreams);
            let even;
            if (producing) {
                even = 'producerTransport';
            } else {
                even = 'consumerTransport';
                logger.info("======================consumerTransport ", appData);
            }

            this.notifyRoom('notify-' + even, {id : transport.id,
                                                  iceParameters: transport.iceParameters,
                                                  iceCandidates: transport.iceCandidates,
                                                  dtlsParameters: transport.dtlsParameters,
                                                  sctpParameters: transport.sctpParameters,
                                                  appData} );
    

            this._socket.emit(even, {id : transport.id,
                                                  iceParameters: transport.iceParameters,
                                                  iceCandidates: transport.iceCandidates,
                                                  dtlsParameters: transport.dtlsParameters,
                                                  sctpParameters: transport.sctpParameters,
                                                  appData});
            logger.info("emit event " ,even);
 
            this._transports.set(transport.id, transport);
        });

        this._socket.on('transport-connect', async (msg) => {
            logger.info('transport-connect:', msg);
            const { transportId, dtlsParameters } = msg;
            const transport = this._transports.get(transportId);
            if (!transport)
                throw new Error(`transport with id "${transportId}" not found`);
            await transport.connect({ dtlsParameters });
        });

        this._socket.on('transport-produce', async (msg) => {
            logger.info('transport-produce:', msg);
            const { transportId, kind, rtpParameters } = msg;
            let { appData } = msg;
            const transport = this._transports.get(transportId);
            if (!transport)
                throw new Error(`transport with id "${transportId}" not found`);

            // Add peerId into appData to later get the associated Peer during
            // the 'loudest' event of the audioLevelObserver.
            //appData = { ...appData, peerId: 99999 };
            const producer = await transport.produce({ kind, rtpParameters, appData });
            
            // Set Producer events.
            producer.on('score', (score) =>
            {
                logger.info(
                'producer "score" event [producerId:%s, score:%o]',
                producer.id, score);

            });
              
            this._socket.emit('transport-produce', {id : producer.id, appData});

            this.notifyRoom('notify-transport-produce', {id : producer.id, appData});

            this._producers.set(producer.id, producer);
        });

        this._socket.on('createConsumer', async (msg) => {
            const { transportId, producerId, rtpCapabilities, appData } = msg;
            logger.info('recv consume:', producerId);

            if (this._mediasoupRouter.canConsume( {producerId, rtpCapabilities} )) {
                logger.info("can consume produerce : ", producerId);
            }
            
            // Create the Consumer in paused mode.
            let consumer;

            try
            {
                const transport = this._transports.get(transportId);
                if (!transport)
                    throw new Error(`transport with id "${transportId}" not found`);
                consumer = await transport.consume(
                    {
                        producerId      : producerId,
                        rtpCapabilities : rtpCapabilities,
                        paused          : false 
                    });

                logger.info("create consumer success [id:%s]", consumer.id);

                this._socket.emit('newConsumer', {
                    producerId     : producerId,
                    id             : consumer.id,
                    kind           : consumer.kind,
                    rtpParameters  : consumer.rtpParameters,
                    type           : consumer.type,
                    appData        : appData,
                    producerPaused : consumer.producerPaused
                });
            }
            catch (error)
            {
                logger.warn('_createConsumer() | transport.consume():%o', error);

                return;
            }  
        });
    }

    async createTransport(forceTcp, producing, consuming, numStreams)
    {
        const webRtcTransportOptions =
        {
           ...config.mediasoup.webRtcTransportOptions,
           enableSctp     : true,
           numSctpStreams : numStreams,
           appData        : { producing, consuming }
        };

        if (forceTcp)
        {
            webRtcTransportOptions.enableUdp = false;
            webRtcTransportOptions.enableTcp = true;
        }

        const transport = await this._mediasoupRouter.createWebRtcTransport(
            webRtcTransportOptions);


        transport.on('sctpstatechange', (sctpState) =>
        {
            logger.info('WebRtcTransport "sctpstatechange" event [sctpState:%s]', sctpState);
        });

        transport.on('icestatechange', (iceState) => {
            logger.info("ICE state changed to %s", iceState);
        });
 
        transport.on("dtlsstatechange", (dtlsState) => {
            logger.info("Dtls state changed to %s", dtlsState);
        });

   
        return transport;
    } 
    close ()
    {
        logger.info("peer call close");
        for (let [id, producer] of this._producers) 
        {
            producer.close();
        }

        for (let [id, transport] of this._transports) 
        {
            transport.close();
        }

        logger.info("peer close finish");
    }
}

/**
 * Room class.
 *
 * This is not a "mediasoup Room" by itself, by a custom class that holds
 * a protoo Room (for signaling with WebSocket clients) and a mediasoup Router
 * (for sending and receiving media to/from those WebSocket peers).
 */
class Room extends EventEmitter
{
	/**
	 * Factory function that creates and returns Room instance.
	 *
	 * @async
	 *
	 * @param {mediasoup.Worker} mediasoupWorker - The mediasoup Worker in which a new
	 *   mediasoup Router must be created.
	 * @param {String} roomId - Id of the Room instance.
	 * @param {Boolean} [forceH264=false] - Whether just H264 must be used in the
	 *   mediasoup Router video codecs.
	 * @param {Boolean} [forceVP9=false] - Whether just VP9 must be used in the
	 *   mediasoup Router video codecs.
	 */
	static async create({ mediasoupWorker, roomId, forceH264 = false, forceVP9 = false })
	{
		logger.info(
			'create() [roomId:%s, forceH264:%s, forceVP9:%s]',
			roomId, forceH264, forceVP9);

		// Router media codecs.
		let { mediaCodecs } = config.mediasoup.routerOptions;

		// If forceH264 is given, remove all video codecs but H264.
		if (forceH264)
		{
			mediaCodecs = mediaCodecs
				.filter((codec) => (
					codec.kind === 'audio' ||
					codec.mimeType.toLowerCase() === 'video/h264'
				));
		}
		// If forceVP9 is given, remove all video codecs but VP9.
		if (forceVP9)
		{
			mediaCodecs = mediaCodecs
				.filter((codec) => (
					codec.kind === 'audio' ||
					codec.mimeType.toLowerCase() === 'video/vp9'
				));
		}

		// Create a mediasoup Router.
		const mediasoupRouter = await mediasoupWorker.createRouter({ mediaCodecs });

		// Create a mediasoup AudioLevelObserver.
		const audioLevelObserver = await mediasoupRouter.createAudioLevelObserver(
			{
				maxEntries : 1,
				threshold  : -80,
				interval   : 800
			});

		return new Room(
			{
				roomId,
				mediasoupRouter,
				audioLevelObserver
			});
	}

	constructor({ roomId, mediasoupRouter, audioLevelObserver })
	{
		super();
		this.setMaxListeners(Infinity);

		// Room id.
		// @type {String}
		this._roomId = roomId;

		// Closed flag.
		// @type {Boolean}
		this._closed = false;

		// Map of broadcasters indexed by id. Each Object has:
		// - {String} id
		// - {Object} data
		//   - {String} displayName
		//   - {Object} device
		//   - {RTCRtpCapabilities} rtpCapabilities
		//   - {Map<String, mediasoup.Transport>} transports
		//   - {Map<String, mediasoup.Producer>} producers
		//   - {Map<String, mediasoup.Consumers>} consumers
		// @type {Map<String, Object>}
		this._broadcasters = new Map();

		// mediasoup Router instance.
		// @type {mediasoup.Router}
		this._mediasoupRouter = mediasoupRouter;

		// mediasoup AudioLevelObserver.
		// @type {mediasoup.AudioLevelObserver}
		this._audioLevelObserver = audioLevelObserver;


		// Network throttled.
		// @type {Boolean}
		this._networkThrottled = false;

		// For debugging.
		global.audioLevelObserver = this._audioLevelObserver;
		global.bot = this._bot;

        this._peers = new Map();
	}

	/**
	 * Closes the Room instance by closing the protoo Room and the mediasoup Router.
	 */
	close()
	{
		logger.debug('close()');

		this._closed = true;

		// Close the mediasoup Router.
		this._mediasoupRouter.close();


		// Emit 'close' event.
		this.emit('close');

		// Stop network throttling.
		if (this._networkThrottled)
		{
			throttle.stop({})
				.catch(() => {});
		}
	}

	logStatus()
	{
		logger.info(
			'logStatus() [roomId:%s, mediasoup Transports:%s]',
			this._roomId,
			this._mediasoupRouter._transports.size); // NOTE: Private API.
	}

    async removePeer(socket)
    {
        this._peers.delete(socket);
    }

    async handlePeer(socket, peerId)
    {
        let peer = new Peer(peerId, socket, this._mediasoupRouter);

        peer.init();

        this._peers.set(socket, peer);

        socket.on('getUserList', () => {
            let data = [];

            logger.info("call userListstart");
            for (let [socket, joinedPeer] of this._peers) {
                let peerInfo = { 
                    "peerId" : joinedPeer.id,
                    "transportId" : joinedPeer.transportId,
                    "producers" : joinedPeer.producers
                };
                data.push(peerInfo);
            }
            logger.info(data);
            socket.emit('userList', data);
        });


        peer.on('notify-producerTransport', (data) => {
            logger.info("call notify transport start");
            for (let [socket, joinedPeer] of this._peers) {
                if ( joinedPeer.id !== peer.id) {
                    joinedPeer.notifyClient('notify-producerTransport', data);
                }
            }
            logger.info("call notify transport finish");
        });

        peer.on('notify-transport-produce', (data) => {
            logger.info("call notify transport start");
            for (let [socket, joinedPeer] of this._peers) {
                if ( joinedPeer.id !== peer.id ) {
                    console.log("create consumer for ", peer.id); 
                    joinedPeer.notifyClient('notify-transport-produce', data);
                }
            }
            logger.info("call notify transport finish");
        });

    }

}

module.exports = Room;
