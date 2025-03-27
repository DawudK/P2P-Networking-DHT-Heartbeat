let net = require("net");
singleton = require("./Singleton");
kadPTPpacket = require("./kadPTPmessage");
let os = require("os");

singleton.init();
let peersList = [];
const MSG_TYPE_WELCOME = 2;
const MSG_TYPE_HELLO = 4;
const MSG_TYPE_HEARTBEAT = 6;
const MSG_TYPE_HEARTBEAT_RESPONSE = 8;

// get current folder name
let HOST = "127.0.0.1";
let PORT = getPort(); //get random port number
let serverID = singleton.getPeerID(HOST, PORT);

let firstFlag = process.argv[4]; // should be -p

if (firstFlag === "-p") {
  // ---------- CLIENT MODE ----------
  let myName = process.argv[3];
  let hostserverIPandPort = process.argv[5].split(":");
  let knownHOST = hostserverIPandPort[0];
  let knownPORT = hostserverIPandPort[1];

  let clientSocket = new net.Socket();
  let port = getPort();
  clientSocket.connect(
    { port: knownPORT, host: knownHOST, localPort: port },
    () => {
      // Initialize client DHT table
      let clientID = singleton.getPeerID(clientSocket.localAddress, port);
      let clientPeer = {
        peerName: myName,
        peerIP: clientSocket.localAddress,
        peerPort: port,
        peerID: clientID,
      };

      let clientDHTtable = {
        owner: clientPeer,
        table: [],
      };

      peerconnections(clientSocket, myName, clientDHTtable);
    }
  );
} else {
  // ---------- SERVER MODE ----------
  let myName = process.argv[3];
  let serverSocket = net.createServer();
  serverSocket.listen(PORT, HOST);

  console.log(
    `This peer address is ${HOST}:${PORT} located at ${myName} [${serverID}]`
  );

  // Initialize server DHT table
  let serverPeer = {
    peerName: myName,
    peerIP: HOST,
    peerPort: PORT,
    peerID: serverID,
  };

  let serverDHTtable = {
    owner: serverPeer,
    table: [],
  };

  // START HEARTBEAT LOOP (for server)
  sendHeartbeats(serverDHTtable);

  // Listen for incoming connections
  serverSocket.on("connection", function (sock) {
    handleClient(sock, serverDHTtable);
  });
}

function getPort() {
  return Math.floor(Math.random() * 55500) + 1000;
}

function handleClient(socket, dhtTable) {
  let packet = null; // Used to store Kad protocol packet
  let peerAddress = socket.remoteAddress + ":" + socket.remotePort; // Concatenating remote address and port

  // Initialize client DHT table
  let peerID = singleton.getPeerID(socket.remoteAddress, socket.remotePort); // Getting the unique peer ID
  let newPeer = {
    // Creating a new peer object
    peerName: "",
    peerIP: socket.remoteAddress,
    peerPort: socket.remotePort,
    peerID: peerID,
  };

  // Triggered when the client sends a kadPTP message
  socket.on("data", (message) => {
    packet = parseMessage(message);

    if (packet.msgType == 6) {
      const senderName = packet.senderName || "unknown";
      const senderIP = socket.remoteAddress;
      const senderPort = socket.remotePort;
      const senderID = singleton.getPeerID(senderIP, senderPort);
      const currentTime = singleton.getTimestamp();

      console.log(
        `Received heartbeat from ${senderName}[${senderID}] at time ${currentTime}`
      );
      console.log(`Message Type: HEARTBEAT (${packet.msgType})`);
      console.log(`Version: 18`);
      console.log(`Sender Name: ${senderName}`);
      console.log(`Content: ${senderIP}:${senderPort}`);
      console.log();

      // Update last seen and send response
      let peer = dhtTable.table.find((p) => p.node.peerID === senderID);
      if (peer) peer.node.lastSeen = currentTime;

      console.log(
        `Updated last seen ${senderID} to ${currentTime} sending response`
      );
      console.log(`Message Type: HEARTBEAT_RESPONSE (8)`);
      console.log(`Version: 18`);
      console.log(`Sender Name: ${dhtTable.owner.peerName}`);
      console.log(`Sender ID: ${dhtTable.owner.peerID}`);
      console.log(
        `Contents: ${dhtTable.owner.peerIP}:${dhtTable.owner.peerPort}`
      );
      console.log();

      if (socket.writable) {
        kadPTPpacket.init(18, 8, dhtTable);
        socket.write(kadPTPpacket.getPacket());
      } else {
        console.log("Socket already closed — cannot send heartbeat response.");
      }
    } else if (packet.msgType == 8) {
      // Heartbeat response
      console.log(
        `Received heartbeat response from ${socket.remoteAddress}:${socket.remotePort}`
      );
    } else if (packet.msgType == 2) {
      // Hello message
      console.log("Received Hello Message from " + packet.senderName);

      if (packet.peersList.length > 0) {
        let peersListStr = "along with DHT: ";
        newPeer.peerName = packet.senderName;
        for (var i = 0; i < packet.peersList.length; i++) {
          peersListStr +=
            "[" +
            packet.peersList[i].peerIP +
            ":" +
            packet.peersList[i].peerPort +
            ", " +
            packet.peersList[i].peerID +
            "]\n                  ";
        }
        console.log(peersListStr);
      }

      let existingPeer = dhtTable.table.find(
        (e) => e.node.peerPort == newPeer.peerPort
      );
      if (existingPeer) {
        let bucketIndex = getPrefix(dhtTable, newPeer);
        console.log(
          `Bucket P${bucketIndex} is full, checking if we need to change the stored value \n Current value is closest, no update needed \n\n`
        );
        existingPeer.node.peerName = newPeer.peerName;
      } else {
        pushBucket(dhtTable, newPeer);
      }

      updateDHTtable(dhtTable, packet.peersList);
    } else if (packet.msgType == 7) {
      // Bootstrap request
      console.log("Connected from peer " + peerAddress + "\n");
      pushBucket(dhtTable, newPeer);
      let output = "My DHT: \n";
      for (var i = 0; i < dhtTable.table.length; i++) {
        output +=
          "[" +
          "P" +
          dhtTable.table[i].prefix +
          ", " +
          dhtTable.table[i].node.peerIP +
          ":" +
          dhtTable.table[i].node.peerPort +
          ", " +
          dhtTable.table[i].node.peerID +
          "]\n";
      }
      console.log(output);

      // Send Hello message as a response to bootstrap
      if (socket.writable) {
        kadPTPpacket.init(18, 1, dhtTable); // 18 = version, 1 = welcome
        socket.write(kadPTPpacket.getPacket());
      }
    }
  });

  socket.on("error", (err) => {
    console.log("Socket error:", err.message);
  });

  socket.on("end", () => {
    if (packet) {
      if (packet.msgType === 2) {
        // Hello message handling
        console.log("Received Hello Message from " + packet.senderName);

        if (packet.peersList.length > 0) {
          let peersListStr = "along with DHT: ";
          newPeer.peerName = packet.senderName;
          for (let i = 0; i < packet.peersList.length; i++) {
            peersListStr += `[${packet.peersList[i].peerIP}:${packet.peersList[i].peerPort}, ${packet.peersList[i].peerID}]\n                  `;
          }
          console.log(peersListStr);
        }

        let existingPeer = dhtTable.table.find(
          (e) => e.node.peerPort === newPeer.peerPort
        );
        if (existingPeer) {
          let bucketIndex = getPrefix(dhtTable, newPeer);
          console.log(
            `Bucket P${bucketIndex} is full, checking if we need to change the stored value \n Current value is closest, no update needed \n\n`
          );
          existingPeer.node.peerName = newPeer.peerName;
        } else {
          pushBucket(dhtTable, newPeer);
        }

        updateDHTtable(dhtTable, packet.peersList);
      }
    } else {
      // Handle bootstrap request
      console.log("Connected from peer " + peerAddress + "\n");
      pushBucket(dhtTable, newPeer);
      let output = "My DHT: \n";
      for (let i = 0; i < dhtTable.table.length; i++) {
        output += `[P${dhtTable.table[i].prefix}, ${dhtTable.table[i].node.peerIP}:${dhtTable.table[i].node.peerPort}, ${dhtTable.table[i].node.peerID}]\n`;
      }
      console.log(output);
    }
  });

  if (packet == null) {
    // Wait 2 seconds to see if data arrives before closing the socket.
    setTimeout(() => {
      // After 2 seconds, if still no valid packet, send the acknowledgment and close.
      kadPTPpacket.init(18, 2, dhtTable);
      socket.write(kadPTPpacket.getPacket());
      socket.end();
    }, 2000);
  }
}

function peerconnections(socket, peerName, dhtTable) {
  // Generate a unique ID for the connecting peer using their IP address and port
  let connectingPeerID = singleton.getPeerID(
    socket.remoteAddress,
    socket.remotePort
  );

  socket.on("data", (message) => {
    // Parse the incoming message to understand its structure and data
    let receivedPacket = parseMessage(message);

    // Extract the sender's information from the received packet
    let senderName = receivedPacket.senderName;
    let senderPeer = {
      peerName: senderName,
      peerIP: socket.remoteAddress,
      peerPort: socket.remotePort,
      peerID: connectingPeerID,
    };

    // Handle the message based on its type
    if (receivedPacket.msgType == 2) {
      console.log(
        `Connected to ${senderName}:${
          socket.remotePort
        } at timestamp: ${singleton.getTimestamp()}\n`
      );

      // Prepare to receive connections from other peers
      let listeningPort = socket.localPort;
      let localPeerID = singleton.getPeerID(socket.localAddress, listeningPort);
      let serverInstance = net.createServer();
      serverInstance.listen(listeningPort, socket.localAddress);
      console.log(
        `This peer address is ${socket.localAddress}:${listeningPort} located at ${peerName} [${localPeerID}]\n`
      );

      // Handle incoming peer connections
      serverInstance.on("connection", (peerSocket) => {
        handleClient(peerSocket, dhtTable);
      });

      console.log(`Received Welcome message from server ${connectingPeerID}\n`);
      // Display the peer list received from the server
      if (receivedPacket.peersList.length > 0) {
        let peerListStr = "along with DHT: ";
        for (var i = 0; i < receivedPacket.peersList.length; i++) {
          peerListStr += `[${receivedPacket.peersList[i].peerIP}:${receivedPacket.peersList[i].peerPort}, ${receivedPacket.peersList[i].peerID}]\n                  `;
        }
        console.log(peerListStr);
      } else {
        console.log("along with DHT: []\n");
      }

      // Add the bootstrap node to the DHT table if it doesn't already exist
      let existingPeer = dhtTable.table.find(
        (e) => e.node.peerPort == socket.remotePort
      );
      if (!existingPeer) {
        pushBucket(dhtTable, senderPeer);
      } else {
        console.log(`${senderPeer.peerPort} already exists in the DHT table`);
      }

      // Update the DHT table with the received list of peers
      updateDHTtable(dhtTable, receivedPacket.peersList);
    } else if (receivedPacket.msgType == 8) {
      console.log(
        `Received heartbeat response from ${
          senderPeer.peerName || senderPeer.peerID
        }`
      );
    } else {
      // Log unsupported message types for future implementation
      console.log(
        `The message type ${receivedPacket.msgType} is not supported yet`
      );
    }
  });
  socket.on("error", (err) => {
    console.log(`Socket error in peerconnections(): ${err.message}`);
  });

  socket.on("end", () => {
    // Handle disconnection from server
    sendHello(dhtTable);
    //sendHeartbeats(dhtTable);
  });
}

function updateDHTtable(DHTtable, list) {
  // Refresh the local k-buckets using the transmitted list of peers.

  refreshBucket(DHTtable, list);
  console.log("Refresh k-Bucket operation is performed.\n");

  if (DHTtable.table.length > 0) {
    let output = "My DHT: \n";
    for (var i = 0; i < DHTtable.table.length; i++) {
      output +=
        "[" +
        "P" +
        DHTtable.table[i].prefix +
        ", " +
        DHTtable.table[i].node.peerIP +
        ":" +
        DHTtable.table[i].node.peerPort +
        ", " +
        DHTtable.table[i].node.peerID +
        "]\n";
    }
    console.log(output);
  }
}

function parseMessage(message) {
  let kadPacket = {};
  let peersList = [];
  kadPacket.peersList = peersList;
  let bitMarker = 0;

  // === field sizes ===
  kadPacket.version = parseBitPacket(message, 0, 5); // 5 bits
  bitMarker += 5;

  kadPacket.msgType = parseBitPacket(message, bitMarker, 8); // 8 bits
  bitMarker += 8;

  let numberOfPeers = parseBitPacket(message, bitMarker, 5); // 5 bits
  bitMarker += 5;

  let SenderNameSize = parseBitPacket(message, bitMarker, 14); // 14 bits
  bitMarker += 14;

  kadPacket.senderName = bytes2string(message.slice(4, SenderNameSize + 4));
  bitMarker += SenderNameSize * 8;

  if (numberOfPeers > 0) {
    for (let i = 0; i < numberOfPeers; i++) {
      let firstOctet = parseBitPacket(message, bitMarker, 8);
      bitMarker += 8;
      let secondOctet = parseBitPacket(message, bitMarker, 8);
      bitMarker += 8;
      let thirdOctet = parseBitPacket(message, bitMarker, 8);
      bitMarker += 8;
      let fourthOctet = parseBitPacket(message, bitMarker, 8);
      bitMarker += 8;
      let port = parseBitPacket(message, bitMarker, 16);
      bitMarker += 16;

      let IP = `${firstOctet}.${secondOctet}.${thirdOctet}.${fourthOctet}`;
      let peerID = singleton.getPeerID(IP, port);
      let aPeer = {
        peerIP: IP,
        peerPort: port,
        peerID: peerID,
        lastSeen: singleton.getTimestamp(),
      };
      peersList.push(aPeer);
    }
  }

  kadPacket.peersList = peersList;
  return kadPacket;
}

function refreshBucket(T, peersList) {
  peersList.forEach((P) => {
    pushBucket(T, P);
  });
}

function getPrefix(T, P) {
  let localID = singleton.Hex2Bin(T.owner.peerID);
  let receiverID = singleton.Hex2Bin(P.peerID);
  // Count how many bits match
  let i = 0;
  for (i = 0; i < localID.length; i++) {
    if (localID[i] != receiverID[i]) break;
  }

  let k_bucket = {
    prefix: i,
    node: P,
  };
  return k_bucket.prefix;
}

function pushBucket(dht, peer) {
  if (dht.owner.peerID !== peer.peerID) {
    const localIDBinary = singleton.Hex2Bin(dht.owner.peerID);
    const peerIDBinary = singleton.Hex2Bin(peer.peerID);

    // Determine prefix (shared bits)
    let prefixLength = 0;
    while (
      prefixLength < localIDBinary.length &&
      localIDBinary[prefixLength] === peerIDBinary[prefixLength]
    ) {
      prefixLength++;
    }

    // Ensure the peer has a lastSeen timestamp
    peer.lastSeen = singleton.getTimestamp();

    const existingBucket = dht.table.find(
      (entry) => entry.prefix === prefixLength
    );

    if (!existingBucket) {
      // No peer in this bucket yet
      dht.table.push({ prefix: prefixLength, node: peer });
      console.log(
        `Bucket P${prefixLength} has no value, adding ${peer.peerID}`
      );
    } else {
      const existingPeer = existingBucket.node;

      const xorExisting = singleton.XORing(
        localIDBinary,
        singleton.Hex2Bin(existingPeer.peerID)
      );
      const xorNew = singleton.XORing(localIDBinary, peerIDBinary);

      if (xorNew < xorExisting) {
        console.log(
          `Bucket P${prefixLength} is full, ${peer.peerID} is closer than current ${existingPeer.peerID}, replacing...`
        );
        existingBucket.node = peer;
      } else if (xorNew === xorExisting) {
        // Compare lastSeen timestamps
        if (peer.lastSeen > existingPeer.lastSeen) {
          console.log(
            `Bucket P${prefixLength} is full, distances equal — replacing older peer ${existingPeer.peerID} with newer ${peer.peerID}`
          );
          existingBucket.node = peer;
        } else {
          console.log(
            `Bucket P${prefixLength} is full, distances equal — keeping most recently seen peer ${existingPeer.peerID}`
          );
        }
      } else {
        console.log(
          `Bucket P${prefixLength} is full, current ${existingPeer.peerID} is closer, no update needed`
        );
      }
    }
  }
}

// The method scans the k-buckets of T and send hello message packet to every peer P in T, one at a time.
function sendHello(T) {
  let i = 0;
  // we use echoPeer method to do recursive method calls
  echoPacket(T, i);
}

function echoPacket(dht, currentIndex, attempt = 1) {
  setTimeout(() => {
    const socket = new net.Socket(); // Create a new socket for the connection

    // Attempt to connect to the current peer in the DHT table
    socket.connect(
      {
        port: dht.table[currentIndex].node.peerPort,
        host: dht.table[currentIndex].node.peerIP,
        localAddress: dht.owner.peerIp,
        localPort: dht.owner.peerPort,
      },
      () => {
        // Connection successful, send the Hello packet
        kadPTPpacket.init(18, 4, dht);
        socket.write(kadPTPpacket.getPacket());
        setTimeout(() => {
          socket.end();
          socket.destroy(); // Ensure the socket is cleaned up after sending
          // Check if there's another peer to contact
          if (currentIndex < dht.table.length - 1) {
            echoPacket(dht, currentIndex + 1); // Recursively call for the next peer
          } else {
            // If this was the last peer, log completion
            console.log("Hello packet has been sent.\n");
          }
        }, 500); // Short delay to ensure the packet is fully sent
      }
    );

    // Error handler for the socket
    socket.on("error", (err) => {
      socket.destroy(); // Clean up the socket on error
      if (attempt <= 3) {
        // Retry the connection attempt, with a maximum of 3 retries
        echoPacket(dht, currentIndex, attempt + 1);
      } else {
        // After 3 attempts, move on to the next peer, if any
        if (currentIndex < dht.table.length - 1) {
          echoPacket(dht, currentIndex + 1);
        }
      }
    });

    socket.on("close", () => {});
  }, 500); // Delay before attempting to connect to manage resources
}

function sendHeartbeats(dht) {
  console.log("Starting heartbeat interval...");

  setInterval(() => {
    dht.table.forEach((entry) => {
      const peer = entry.node;
      const socket = new net.Socket();
      const peerName = peer.peerName || peer.peerID;

      // Initialize missed counter if not present
      if (peer.missed === undefined) {
        peer.missed = 0;
      }

      // If already missed 3 heartbeats, skip sending
      if (peer.missed >= 3) {
        console.log(`Peer ${peerName} already missed 3 heartbeats.`);
        return;
      }

      console.log(`Attempting heartbeat to ${peer.peerIP}:${peer.peerPort}`);

      // Set a timeout to detect missing heartbeat response
      const heartbeatTimeout = setTimeout(() => {
        peer.missed += 1;
        console.log(
          `No heartbeat response from ${peerName}. Missed count: ${peer.missed}`
        );
        if (peer.missed >= 3) {
          removePeerFromDHT(dht, peer);
        }
        socket.destroy();
      }, 5000); // 5-second wait for a response

      socket.connect(
        {
          port: peer.peerPort,
          host: peer.peerIP,
        },
        () => {
          console.log(
            `Connected for heartbeat to ${peer.peerIP}:${peer.peerPort}`
          );
          // Use version 18 for heartbeat messages
          kadPTPpacket.init(18, 6, dht);
          socket.write(kadPTPpacket.getPacket());
          console.log(`Sent heartbeat to ${peerName}:${peer.peerPort}`);
        }
      );

      socket.on("data", (data) => {
        clearTimeout(heartbeatTimeout); // Clear the heartbeat timeout on response
        const response = parseMessage(data);
        if (response.msgType === 8) {
          const responseTime = singleton.getTimestamp();
          const previousTime = peer.lastSeen;
          peer.missed = 0;
          peer.lastSeen = responseTime;

          console.log(
            `Received heartbeat response from ${peerName}[${peer.peerID}] at ${responseTime}, updated last seen for ${peerName}[${peer.peerID}] from ${previousTime} to ${responseTime}.`
          );
        }

        // Delay closing the socket to ensure the response is fully processed
        setTimeout(() => {
          if (!socket.destroyed && socket.writable) {
            socket.end();
          }
        }, 1000);
      });

      socket.on("error", (err) => {
        console.log(`Heartbeat socket error: ${err.message}`);
        peer.missed += 1;
        if (peer.missed >= 3) {
          removePeerFromDHT(dht, peer);
        }
        socket.destroy();
      });
    });
  }, 20000); // Heartbeat interval set to 20 seconds
}

function bytes2string(array) {
  var result = "";
  for (var i = 0; i < array.length; ++i) {
    if (array[i] > 0) result += String.fromCharCode(array[i]);
  }
  return result;
}

// return integer value of a subset bits
function parseBitPacket(packet, offset, length) {
  let number = "";
  for (var i = 0; i < length; i++) {
    let bytePosition = Math.floor((offset + i) / 8);
    let bitPosition = 7 - ((offset + i) % 8);
    let bit = (packet[bytePosition] >> bitPosition) % 2;
    number = (number << 1) | bit;
  }
  return number;
}
