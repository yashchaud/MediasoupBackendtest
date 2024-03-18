process.env.DEBUG = "mediasoup*";
const mediasoup = require("mediasoup");
const { AwaitQueue } = require("awaitqueue");
const os = require("os");
const promClient = require("prom-client");
const axios = require("axios");
const { createWorker } = require("./LogicalFunctions/Basicfunctions");

function getCpuInfo() {
  return os.cpus().map((cpu) => {
    const times = cpu.times;
    return {
      idle: times.idle,
      total: Object.keys(times).reduce((acc, key) => acc + times[key], 0),
    };
  });
}

function calculateCpuUsage(startMeasurements, endMeasurements) {
  return startMeasurements.map((start, i) => {
    const end = endMeasurements[i];
    const idleDiff = end.idle - start.idle;
    const totalDiff = end.total - start.total;
    const usagePercentage =
      totalDiff === 0 ? 0 : 100 * (1 - idleDiff / totalDiff);
    return Number(usagePercentage.toFixed(2));
  });
}

// Sample usage
let startMeasurements = getCpuInfo();

setInterval(() => {
  let endMeasurements = getCpuInfo();
  let usagePercentages = calculateCpuUsage(startMeasurements, endMeasurements);

  console.log("CPU Usage (%):", usagePercentages);

  // Send this data to your broker here
  // e.g., sendCpuUsageData(usagePercentages);

  startMeasurements = endMeasurements; // Prepare for the next interval
}, 1000); // Every second

// function generatePrimes(n) {
//   const primes = [];
//   for (let num = 2; num <= n; num++) {
//       let isPrime = true;
//       for (let i = 2; i <= Math.sqrt(num); i++) {
//           if (num % i === 0) {
//               isPrime = false;
//               break;
//           }
//       }
//       if (isPrime) {
//           primes.push(num);
//       }
//   }
//   return primes;
// }

// const n = 100000; // Adjust the range as per your requirement
// setInterval(() => {
//     generatePrimes(n);
//     generatePrimes(n);
//     generatePrimes(n);
//     generatePrimes(n);
//     generatePrimes(n);

// }, 100);

module.exports = async function (io) {
  const roomQueue = new AwaitQueue();

  let worker;
  let rooms = new Map(); // { roomName1: { Router, rooms: [ sicketId1, ... ] }, ...}
  let peers = new Map(); // { socketId1: { roomName1, socket, transports = [id1, id2,] }, producers = [id1, id2,] }, consumers = [id1, id2,], peerDetails }, ...}
  let transports = new Map(); // [ { socketId1, roomName1, transport, consumer }, ... ]
  let producers = []; // [ { socketId1, roomName1, producer, }, ... ]
  let consumers = []; // [ { socketId1, roomName1, consumer, }, ... ]
  let Peerstrack = [];

  const mediaCodecs = [
    {
      kind: "audio",
      mimeType: "audio/opus",
      clockRate: 48000,
      channels: 2,
    },
    {
      kind: "video",
      mimeType: "video/VP9",
      clockRate: 90000,
      parameters: {
        "x-google-start-bitrate": 1000,
      },
    },
  ];

  // const createWorker = async () => {
  //   const worker = await mediasoup.createWorker({
  //     logLevel: "debug",
  //     logTags: ["rtp", "srtp", "rtcp"],
  //     rtcMinPort: 2000,
  //     rtcMaxPort: 2100,
  //   });

  //   console.log(`worker pid ${worker.pid}`);

  //   worker.on("died", (error) => {
  //     console.error("mediasoup worker has died");
  //     setTimeout(() => process.exit(1), 2000);
  //   });

  //   return worker;
  // };
  worker = await createWorker();

  const createRoom = async (roomName, socketId) => {
    return roomQueue.push(async () => {
      let room = rooms.get(roomName);

      let peers = [];
      if (!room) {
        const router = await worker.createRouter({ mediaCodecs });
        room = { router, peers: new Set([socketId]) };
        rooms.set(roomName, room);
      } else {
        room.peers.add(socketId);
      }

      console.log(`This is Room Router ${room.router} ${rooms}`);

      return room.router;
    });
  };

  const createWebRtcTransport = async (router) => {
    return new Promise(async (resolve, reject) => {
      try {
        const webRtcTransport_options = {
          listenIps: [
            {
              ip: "127.0.0.1",
            },
          ],
          enableUdp: true,
          enableTcp: true,
          preferUdp: true,
        };

        let transport = await router.createWebRtcTransport(
          webRtcTransport_options
        );
        console.log(`transport id: ${transport.id}`);

        transport.on("dtlsstatechange", (dtlsState) => {
          if (dtlsState === "closed") {
            transport.close();
          }
        });

        transport.on("close", () => {
          console.log("transport closed");
        });

        resolve(transport);
      } catch (error) {
        reject(error);
      }
    });
  };

  const getTransport = (socketId) => {
    for (let [transportId, transportData] of transports.entries()) {
      if (transportData.socketId === socketId && !transportData.consumer) {
        return transportData.transport;
      }
    }
    console.error(`Transport not found for socket ID: ${socketId}`);
    return null;
  };
  const informConsumers = (roomName, socketId, id) => {
    console.log(`just joined, id ${id} ${roomName}, ${socketId}`);
    producers.forEach((producerData) => {
      if (
        producerData.socketId !== socketId &&
        producerData.roomName === roomName
      ) {
        if (peers.has(producerData.socketId)) {
          const producerSocket = peers.get(producerData.socketId).socket;
          producerSocket.emit("new-producer", { producerId: id });
        } else {
          console.log(`Producer not found in peers: ${producerData.socketId}`);
        }
      }
    });
  };

  io.on("connection", (socket) => {
    console.log(`peer joined ${socket.id}`);
    socket.emit("connection-success", { socketID: socket.id });

    const removeItems = (items, socketId, type) => {
      if (!Array.isArray(items)) {
        console.error("items is not an array");
        return items;
      }

      items.forEach((item) => {
        if (item.socketId === socket.id) {
          item[type].close();
        }
      });

      items = items.filter((item) => item.socketId !== socket.id);

      return items;
    };
    const addTransport = (transport, roomName, consumer) => {
      transports.set(transport.id, {
        socketId: socket.id,
        transport,
        roomName,
        consumer,
      });

      let peer = peers.get(socket.id);
      peer.transports.push(transport.id);
      peers.set(socket.id, peer);
    };
    const addProducer = (producer, roomName, kind) => {
      producers = [
        ...producers,
        { socketId: socket.id, producer, roomName, kind },
      ];

      let peer = peers.get(socket.id);
      peer.producers.push(producer.id);
      peers.set(socket.id, peer);
    };

    const addConsumer = (consumer, roomName) => {
      consumers = [...consumers, { socketId: socket.id, consumer, roomName }];

      let peer = peers.get(socket.id);
      peer.consumers.push(consumer.id);
      peers.set(socket.id, peer);
    };

    socket.on("joinRoom", async ({ roomName }, callback) => {
      const router1 = await createRoom(roomName, socket.id);

      peers.set(socket.id, {
        socket,
        roomName,
        transports: [],
        producers: [],
        consumers: [],
        peerDetails: {
          name: "",
          isAdmin: false,
        },
      });
      console.log(`peer has joined the room`);
      const rtpCapabilities = router1.rtpCapabilities;

      callback({ rtpCapabilities });
    });

    socket.on("transport-connect", ({ dtlsParameters }) => {
      console.log("DTLS PARAMS... ", { dtlsParameters });

      getTransport(socket.id).connect({ dtlsParameters });
    });

    socket.on("createWebRtcTransport", async ({ consumer }, callback) => {
      const roomName = peers.get(socket.id).roomName;

      let router = rooms.get(roomName).router;

      await createWebRtcTransport(router)
        .then(
          (transport) => {
            callback({
              params: {
                id: transport.id,
                iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters,
              },
            });

            // add transport to Peer's properties
            addTransport(transport, roomName, consumer);
          },
          (error) => {
            console.log(error);
          }
        )
        .then(
          console.log(`Transport Kind is ${consumer ? "Consumer" : "producer"}`)
        );
    });

    socket.on("getProducers", (callback) => {
      const roomName = peers.get(socket.id).roomName;

      let producerList = [];
      producers.forEach((producerData) => {
        if (
          producerData.socketId !== socket.id &&
          producerData.roomName === roomName
        ) {
          producerList = [...producerList, producerData.producer.id];
        }
      });

      callback(producerList);
    });

    socket.on(
      "transport-produce",
      async ({ kind, rtpParameters, appData }, callback) => {
        return roomQueue.push(async () => {
          try {
            let producer;

            producer = await getTransport(socket.id).produce({
              kind,
              rtpParameters,
            });

            const roomName = peers.get(socket.id).roomName;

            const transport = getTransport(socket.id);
            if (!transport) {
              console.error("Transport not found.");
              return;
            }

            addProducer(producer, roomName, kind);

            informConsumers(roomName, socket.id, producer.id);

            console.log("Producer ID: ", producer.id, producer.kind);

            producer.on("transportclose", () => {
              console.log("transport for this producer closed ");
              producer.close();
            });

            console.log(producers.length);

            callback({
              id: producer.id,
              producersExist: producers.length > 1 ? true : false,
            });
          } catch (error) {
            console.log(error);
          }
        });
      }
    );

    socket.on(
      "transport-recv-connect",
      async ({ dtlsParameters, serverConsumerTransportId }) => {
        const consumerTransport = transports.get(
          serverConsumerTransportId
        )?.transport;

        if (consumerTransport) {
          await consumerTransport.connect({ dtlsParameters });
        } else {
          console.log(`${consumerTransport} not a transport`);
        }
      }
    );

    socket.on(
      "consume",
      async (
        { rtpCapabilities, remoteProducerId, serverConsumerTransportId },
        callback
      ) => {
        try {
          const roomName = peers.get(socket.id).roomName;
          let router = rooms.get(roomName).router;

          let consumerTransport = transports.get(
            serverConsumerTransportId
          )?.transport;

          // check if the router can consume the specified producer
          if (
            router.canConsume({
              producerId: remoteProducerId,
              rtpCapabilities,
            })
          ) {
            console.log("consumercan consume");
            // transport can now consume and return a consumer
            const consumer = await consumerTransport.consume({
              producerId: remoteProducerId,
              rtpCapabilities,
              paused: true,
            });
            const consumerStats = consumer.getStats();

            socket.on("consumer-resume", async ({ serverConsumerId }) => {
              const { consumer } = consumers.find(
                (consumerData) => consumerData.consumer.id === serverConsumerId
              );

              await consumer.resume();
            });

            if (consumer.paused) {
              console.log("Consumer is currently paused");
            }

            if (consumer.closed) {
              console.log("Consumer is closed");
            }

            consumer.on("transportclose", () => {
              console.log("transport close from consumer");
            });

            consumer.on("producerclose", () => {
              console.log("producer of consumer closed");
              socket.emit("producer-closed", { remoteProducerId });

              consumerTransport.close([]);
              transports = transports.filter(
                (transportData) =>
                  transportData.transport.id !== consumerTransport.id
              );
              consumer.close();
              consumers = consumers.filter(
                (consumerData) => consumerData.consumer.id !== consumer.id
              );
            });

            addConsumer(consumer, roomName);

            const params = {
              id: consumer.id,
              producerId: remoteProducerId,
              kind: consumer.kind,
              rtpParameters: consumer.rtpParameters,
              serverConsumerId: consumer.id,
            };

            callback({ params });
          }
        } catch (error) {
          console.log(error.message);
          callback({
            params: {
              error: error,
            },
          });
        }
      }
    );

    socket.on("disconnect", () => {
      console.log("peer disconnected");
      consumers = removeItems(consumers, socket.id, "consumer");
      producers = removeItems(producers, socket.id, "producer");
      transports = removeItems(transports, socket.id, "transport");
      console.log(Peerstrack);
      if (peers.get(socket.id)) {
        const roomName = peers.get(socket.id).roomName;

        peers.delete(socket.id);
      }
    });
  });
};
