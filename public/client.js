'use strict';

var device;
var sendTransport;
var stream;

var recvTransports = new Map();

var socket = io.connect('10.1.133.155:3333');
var joinBtn=document.getElementById('joinBtn');

var peerId = parseInt(Math.random()*100000);

var userList;

var remoteVideo;

joinBtn.addEventListener('click', start);

async function start() {
    await observer();

    await init();
    await join();
    await publish();
    await subscribe();
}

async function init() {
    stream = await navigator.mediaDevices.getUserMedia({ video: true , audio: true});
    const video = document.getElementById('local');
    video.srcObject = stream;
    video.autoplay = true;

    device = new mclient.Device();
}

async function join() {
    return new Promise((resolve, reject) => {

        socket.on('joinsuccess', async () => {
            console.log('====   response join success.');
            const routerRtpCapabilities = await getRouterRtpCapabilities();
            await device.load({ routerRtpCapabilities });
        
            if (!device.canProduce('video')) {
                alert('cannot  produce video');
            }
            if (!device.canProduce('audio')) {
                alert('cannot  produce audio');
            }
        
            sendTransport = await createSendTransport();

            resolve();
        });


        socket.emit('join', {roomId:1111, forceH264:false, forceVP9:false, peerId: peerId});
        console.log('====   request to join room, peerId:', peerId);
    });
}


function getRouterRtpCapabilities() {
    console.log('goto get rtp capabilities');

    return new Promise((resolve, reject) => {
        socket.on('rtpcapabilities', (rtpCapabilities) => {
            console.log('recv rtpcapabilities', rtpCapabilities);
            resolve(rtpCapabilities);    
        });

        socket.emit('rtpcapabilities');
        //setTimeout for rtpCapabilities
    });
}

async function createSendTransport() {
    console.log('====   request to create sendtransport');

    return new Promise((resolve, reject) => {
        socket.on('producerTransport', async (data) => {

            console.log("====    response on create sendtransport success", data);
            const { 
              id, 
              iceParameters, 
              iceCandidates, 
              dtlsParameters,
              sctpParameters
            } = data; 
        
            sendTransport = device.createSendTransport({id, iceParameters, iceCandidates, dtlsParameters, sctpParameters});

            resolve(sendTransport);
        });

        socket.emit('createTransport', { forceTcp: false, producing: true, consuming: false, sctpCapabilities : device.sctpCapabilities, appData:{peerId : peerId, type:"produce"} });
    });
}

async function publish() {
    console.log('====   request to publish stream');

    sendTransport.on("connect", ({ dtlsParameters }, callback, errback) =>
    {
        console.log('==== local response on connect', dtlsParameters);
        // Signal local DTLS parameters to the server side transport.
        try
        {
            socket.emit("transport-connect",{ transportId    : sendTransport.id, dtlsParameters : dtlsParameters});

            //// Tell the transport that parameters were transmitted.
            callback();
        }
        catch (error)
        {
            // Tell the transport that something was wrong.
            errback(error);
        }
    });

    sendTransport.on("produce", (parameters, callback, errback) =>
    {
        console.log('==== local response on produce', parameters);
        try
        {
             socket.on('transport-produce', async (data) => {
                 console.log('recv transport produce.', data);
                 const producerId = data.id;
                 // Tell the transport that parameters were transmitted and provide it with the
                 // server side producer's id.
                 callback({ producerId });
             }); 
             // Let's assume the server included the created producer id in the response
             // data object.
             socket.emit('transport-produce', { transportId   : sendTransport.id,
                                                kind          : parameters.kind,
                                                rtpParameters : parameters.rtpParameters,
                                                appData       : {peerId : peerId} 
                                               });
        }
        catch (error)
        {
             errback(error);
        }
    });

    console.log('==== sendTransport produce video/audio');
    const webcamTrack = stream.getVideoTracks()[0];
    const webcamProducer = await sendTransport.produce({ track: webcamTrack });

    const webmicTrack = stream.getAudioTracks()[0];
    const webmicProducer = await sendTransport.produce({ track: webmicTrack});
}

async function observer() {
    console.log("==== ready to observer other user join room");

    socket.on('consumerTransport', async (data) => {
        remoteVideo = document.getElementById('remote');
        remoteVideo.srcObject = new MediaStream();
        remoteVideo.autoplay = true;

        const { 
          id, 
          iceParameters, 
          iceCandidates, 
          dtlsParameters,
          sctpParameters,
          appData
        } = data; 
        console.log("====   response on create recv transport success", appData);
        
        let recvTransport = device.createRecvTransport({id, iceParameters, iceCandidates, dtlsParameters, sctpParameters});
        recvTransports.set(appData.peerId, recvTransport);
        
        recvTransport.on("connect", ({ dtlsParameters }, callback, errback) =>
        {
            console.log('==== local recv transport on connect');
            // Signal local DTLS parameters to the server side transport.
            try
            {
                socket.emit("transport-connect",{ transportId    : recvTransport.id, dtlsParameters : dtlsParameters});

                //// Tell the transport that parameters were transmitted.
                callback();
            }
            catch (error)
            {
                // Tell the transport that something was wrong.
                errback(error);
            }
        });

        recvTransport.on("connectionstatechange", (state) => {
            console.log("recv transport connectionstatechange", state);
        });

        if (appData.type === "subscribe") {
            
            for ( let i = 0; i < appData.producers.length; i++ ) {
                 console.log("====  request to create consumer for subscribe", appData.producers[i]);
                 socket.emit("createConsumer", { transportId: recvTransport.id, producerId : appData.producers[i], rtpCapabilities : device.rtpCapabilities, appData}); 
            } 
        }
    });

    socket.on('newConsumer', async (data) => {
        console.log("====   response on create consumer success", data);
        let { appData } = data;
        let recvTransport = recvTransports.get(appData.peerId);
 
        const consumer = await recvTransport.consume(
                         {
                           id        : data.id,
                           producerId: data.producerId,
                           kind      : data.kind,
                           rtpParameters : data.rtpParameters
                         });
 
         const { track } = consumer;

         remoteVideo.srcObject.addTrack(track);

 
         consumer.on("transportclose", () =>
         {
             console.log("transport closed so consumer closed");
         });
 
         consumer.on("trackended", () => 
         {
             console.log("transport ended so consumer closed");
         }); 
 
         setInterval(async () => { 
             let results = await consumer.getStats();
             let statsString = '';
              results.forEach(res => {
                statsString += '<h3>Report type=';
                statsString += res.type;
                statsString += '</h3>\n';
                statsString += `id ${res.id}<br>`;
                statsString += `time ${res.timestamp}<br>`;
                Object.keys(res).forEach(k => {
                  if (k !== 'timestamp' && k !== 'type' && k !== 'id') {
                    statsString += `${k}: ${res[k]}<br>`;
                  }
                });
              }); 
              console.log(statsString);
         }, 15000);
         
    });

    socket.on("notify-producerTransport", observerTransport);
    socket.on("notify-transport-produce", observerProducer);
    return;
}

async function observerProducer(producer) {
    console.log("observer new producer create:", producer);
    let { appData } = producer;

    let recvTransport = recvTransports.get(appData.peerId);
    if (recvTransport) {
        socket.emit("createConsumer", { transportId: recvTransport.id, producerId : producer.id, rtpCapabilities : device.rtpCapabilities, appData }); 
    }
}

async function observerTransport(transport) {
    console.log("observer remote new send transport create:", transport);
    let { appData } = transport;

    socket.emit('createTransport', { forceTcp: false, producing: false, consuming: true, sctpCapabilities : device.sctpCapabilities, appData: {peerId: transport.appData.peerId, type:"observer"}});
}

async function subscribe()
{
    socket.on('userList', async (data) => {
        userList = data;
        console.log("userList : ", data);
        for ( let i = 0; i < userList.length; i++ ) {
            console.log(data[i]);
            if (data[i].peerId !== peerId) {
                subscribeRemote(data[i].peerId, data[i].transportId, data[i].producers);
                break;
            }
        }
    });
    socket.emit('getUserList');
}

async function subscribeRemote(peerId, transpotId, producers)
{
    console.log("subscribe remote peerid , create recv transport", peerId);
    socket.emit('createTransport', { forceTcp: false, producing: false, consuming: true, sctpCapabilities : device.sctpCapabilities, appData:{peerId, type:"subscribe", producers} });
}
