var bencode = require('bencode'),
    dgram = require('dgram'),
    hat = require('hat'),
    _ = require('lodash');

// Put in a function. The returned function won't ever throw an error. This is
// quite useful for malformed messages.
var makeSafe = function (fn, onFuckedUp) {
  return function () {
    try {
      return fn.apply(null, arguments);
    } catch (e) {
      // console.log(e);
      return onFuckedUp;
    }
  };
};

// See https://github.com/bencevans/node-compact2string.
var compact2string = makeSafe(require('compact2string'));

// Necessary formatting for the protocols we are using.
var transactionIdToBuffer = makeSafe(function (transactionId) {
  var buf = new Buffer(2);
  buf.writeUInt16BE(transactionId, 0);
  return buf;
});

// Necessary formatting for the protocols we are using.
var idToBuffer = makeSafe(function (id) {
  return new Buffer(id, 'hex');
});

// Time in ms for a crawlJob to live.
var ttl = 60*1000;

var decode = makeSafe(bencode.decode, {}),
    encode = makeSafe(bencode.encode, {});

var ROUTERS = [
  'router.bittorrent.com:6881',
  'router.utorrent.com:6881',
  'dht.transmissionbt.com:6881'
  ],
  BOOTSTRAP_NODES = ROUTERS.slice();

var nodeID = hat(160),
    port = process.env.UDP_PORT || 6881,
    socket = dgram.createSocket('udp4');

// Update our id once in a while, since we are esentially spamming the DHT
// network and this might prevent other nodes from blocking us.
setInterval(function () {
  nodeID = hat(160);
}, 10000);

// Key: infoHash; Value: Object representing the current results of this crawl
// job (peers and nodes set using object).
var jobs = {};

// Key: transactionId; Value: infoHash
var transactions = {};

// This function will be invoked as soon as a node/peer sends a message. It does
// a lot of formatting for the protocols.
socket.on('message', function (msg, rinfo) {
  // console.log('Received message from ' + rinfo.address);
  msg = decode(msg);
  var transactionId = Buffer.isBuffer(msg.t) && msg.t.length === 2 && msg.t.readUInt16BE(0);
  var infoHash = transactions[transactionId];
  if (transactionId === false) {
    // console.log('Malformed message from ' + rinfo.address + ':' + rinfo.port + '.');
    // console.log(msg);
    return;
  }
  if (infoHash === undefined) {
    // console.log('Unknown transaction for ' + transactionId + ' from ' + rinfo.address + ':' + rinfo.port + '.');
    // console.log(msg);
    return;
  }
  if (msg.r && msg.r.values) {
    _.each(msg.r.values, function (peer) {
      peer = compact2string(peer);
      if (peer && jobs[infoHash]) {
        console.log('Found new peer ' + node + ' for ' + infoHash);
        jobs[infoHash].peers[peer] = true;
        setImmediate(function () {
          getPeers(infoHash, peer);
        });
      }
    });
  }
  if (msg.r && msg.r.nodes && Buffer.isBuffer(msg.r.nodes)) {
    for (var i = 0; i < msg.r.nodes.length; i += 26) {
      var node = compact2string(msg.r.nodes.slice(i + 20, i + 26));
      if (node && jobs[infoHash]) {
        console.log('Found new node ' + node + ' for ' + infoHash);
        jobs[infoHash].nodes[node] = true;
        setImmediate(function () {
          getPeers(infoHash, node);
        });
      }
    }
  }
});

// Sends the get_peers request to a node.
var getPeers = function (infoHash, addr) {
  // console.log('Sending get_peers to ' + addr + ' for ' + infoHash);
  addr = addr.split(':');
  var ip = addr[0],
      port = parseInt(addr[1]);
  if (port <= 0 || port >= 65536) {
    return;
  }
  // var transactionId = _.random(Math.pow(2, 16));
  var transactionId = _.random(Math.pow(2, 12));
  transactions[transactionId] = infoHash;
  var message = encode({
    t: transactionIdToBuffer(transactionId),
    y: 'q',
    q: 'get_peers',
    a: {
      id: idToBuffer(nodeID),
      info_hash: idToBuffer(infoHash)
    }
  });
  socket.send(message, 0, message.length, port, ip);
};

var crawl = function (infoHash, callback) {
  console.log('Crawling ' + infoHash + '...');

  if (jobs[infoHash]) {
    return callback(new Error('Crawljob already in progress'));
  }

  jobs[infoHash] = {
    peers: {},
    nodes: {}
  };

  setTimeout(function () {
    console.log('Done crawling ' + infoHash + '.');

    var peers = _.keys(jobs[infoHash].peers);
    var nodes = _.keys(jobs[infoHash].nodes);

    console.log('Found ' + peers.length + ' peers for ' + infoHash + '.');
    console.log('Found ' + nodes.length + ' nodes for ' + infoHash + '.');

    delete jobs[infoHash];
    console.log('Successfully deleted crawl job for ' + infoHash + '.');

    callback(null, {
      peers: peers,
      nodes: nodes
    });
  }, ttl);

  // Packages might get lost. This sends each get_peers request multiple times.
  // Routers provided by BitTorrent, Inc. are sometimes down. This way we
  // ensure that we corrently enter the DHT network. Otherwise, we might not get
  // a single peer/ node.
  var kickedOff = 0;
  var kickOff = setInterval(function () {
    _.each(BOOTSTRAP_NODES, function (addr) {
        getPeers(infoHash, addr);
    });
    if (kickedOff++ === 5) {
      clearInterval(kickOff);
    }
  }, 1);
};

module.exports = exports = crawl;
module.exports.init = function (callback) {
  socket.bind(port, callback);
};

// Example usage:
// var crawl = require('./crawl');
// crawl.init(function () {
//   crawl('8CA378DBC8F62E04DF4A4A0114B66018666C17CD', function (err, result) {
//     console.log(result);
//     process.exit(1);
//   });
// });
