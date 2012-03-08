var dgram  = require('dgram')
  , util    = require('util')
  , net    = require('net')
  , config = require('./config')
  , fs     = require('fs')
  , base64     = require('base64')
  , https      = require('https');


var keyCounter = {};
var counters = {};
var timers = {};
var debugInt, flushInt, keyFlushInt, server, mgmtServer;
var startup_time = Math.round(new Date().getTime() / 1000);

var stats = {
  graphite: {
    last_flush: startup_time,
    last_exception: startup_time
  },
  messages: {
    last_msg_seen: startup_time,
    bad_lines_seen: 0,
  }
};

config.configFile(process.argv[2], function (config, oldConfig) {
  if (! config.debug && debugInt) {
    clearInterval(debugInt); 
    debugInt = false;
  }

  if (config.debug) {
    if (debugInt !== undefined) { clearInterval(debugInt); }
    debugInt = setInterval(function () { 
      util.log("Counters:\n" + util.inspect(counters) + "\nTimers:\n" + util.inspect(timers));
    }, config.debugInterval || 10000);
  }

  if (server === undefined) {

    // key counting
    var keyFlushInterval = Number((config.keyFlush && config.keyFlush.interval) || 0);

    server = dgram.createSocket('udp4', function (msg, rinfo) {
      if (config.dumpMessages) { util.log(msg.toString()); }
      var bits = msg.toString().split(':');
      var key = bits.shift()
                    .replace(/\s+/g, '_')
                    .replace(/\.\//g, '-')
                    .replace(/[^a-zA-Z_\-0-9]/g, '');

      if (keyFlushInterval > 0) {
        if (! keyCounter[key]) {
          keyCounter[key] = 0;
        }
        keyCounter[key] += 1;
      }

      if (bits.length == 0) {
        bits.push("1");
      }

      for (var i = 0; i < bits.length; i++) {
        var sampleRate = 1;
        var fields = bits[i].split("|");
        if (fields[1] === undefined) {
            util.log('Bad line: ' + fields);
            stats['messages']['bad_lines_seen']++;
            continue;
        }
        if (fields[1].trim() == "ms") {
          if (! timers[key]) {
            timers[key] = [];
          }
          timers[key].push(Number(fields[0] || 0));
        } else {
          if (fields[2] && fields[2].match(/^@([\d\.]+)/)) {
            sampleRate = Number(fields[2].match(/^@([\d\.]+)/)[1]);
          }
          if (! counters[key]) {
            counters[key] = 0;
          }
          counters[key] += Number(fields[0] || 1) * (1 / sampleRate);
        }
      }

      stats['messages']['last_msg_seen'] = Math.round(new Date().getTime() / 1000);
    });

    mgmtServer = net.createServer(function(stream) {
      stream.setEncoding('ascii');

      stream.on('data', function(data) {
        var cmdline = data.trim().split(" ");
        var cmd = cmdline.shift();

        switch(cmd) {
          case "help":
            stream.write("Commands: stats, counters, timers, delcounters, deltimers, quit\n\n");
            break;

          case "stats":
            var now    = Math.round(new Date().getTime() / 1000);
            var uptime = now - startup_time;

            stream.write("uptime: " + uptime + "\n");

            for (group in stats) {
              for (metric in stats[group]) {
                var val;

                if (metric.match("^last_")) {
                  val = now - stats[group][metric];
                }
                else {
                  val = stats[group][metric];
                }

                stream.write(group + "." + metric + ": " + val + "\n");
              }
            }
            stream.write("END\n\n");
            break;

          case "counters":
            stream.write(util.inspect(counters) + "\n");
            stream.write("END\n\n");
            break;

          case "timers":
            stream.write(util.inspect(timers) + "\n");
            stream.write("END\n\n");
            break;

          case "delcounters":
            for (index in cmdline) {
              delete counters[cmdline[index]];
              stream.write("deleted: " + cmdline[index] + "\n");
            }
            stream.write("END\n\n");
            break;

          case "deltimers":
            for (index in cmdline) {
              delete timers[cmdline[index]];
              stream.write("deleted: " + cmdline[index] + "\n");
            }
            stream.write("END\n\n");
            break;

          case "quit":
            stream.end();
            break;

          default:
            stream.write("ERROR\n");
            break;
        }

      });
    });

    server.bind(config.port || 8125, config.address || undefined);
    mgmtServer.listen(config.mgmt_port || 8126, config.mgmt_address || undefined);

    util.log("server is up");

    var flushInterval = Number(config.flushInterval || 10000);

    flushInt = setInterval(function () {
      var stats = {};
      stats["gauges"] = {};
      stats["counters"] = {};
      var ts = Math.round(new Date().getTime() / 1000);
      var numStats = 0;
      var key;

      for (key in counters) {
        var value = counters[key];
        var valuePerSecond = value / (flushInterval / 1000); // calculate "per second" rate

        stats["counters"][key] = {};
        stats["counters"][key]["value"] = valuePerSecond;

        counters[key] = 0;
        numStats += 1;
      }

      for (key in timers) {
        if (timers[key].length > 0) {
          var values = timers[key].sort(function (a,b) { return a-b; });
          var count = values.length;
          var min = values[0];
          var max = values[count - 1];

          var sum = 0;
          var sumOfSquares = 0;
          for (var i = 0; i < count; i++) {
            sum += values[i];
            sumOfSquares += values[i] * values[i];
          }

          timers[key] = [];
          stats["gauges"][key] = {};
          stats["gauges"][key]["count"] = count;
          stats["gauges"][key]["sum_squares"] = sumOfSquares;
          stats["gauges"][key]["sum"] = sum;
          stats["gauges"][key]["min"] = min;
          stats["gauges"][key]["max"] = max;

          numStats += 1;
        }
      }


      stats["counters"]["numStats"] = {};
      stats["counters"]["numStats"]["value"] = numStats;

      var stats_str = JSON.stringify(stats);

      var options = {
        host: 'metrics-api.librato.com',
        port: 443,
        path: '/v1/metrics.json',
        method: 'POST',
        headers: {
          "Authorization": 'Basic ' + base64.encode(new Buffer(config.libratoUser + ':' + config.libratoApiKey)),
          "Content-Length": stats_str.length,
          "Content-Type": "application/json"
        }
      };

      var req = https.request(options, function(res) {
        res.on('data', function(d) {
          process.stdout.write(d);
        });
      });
      req.write(stats_str);
      req.end();
4
      req.on('error', function(e) {
        console.error("There was an error");
        console.error(e);
      });

    }, flushInterval);

    if (keyFlushInterval > 0) {
      var keyFlushPercent = Number((config.keyFlush && config.keyFlush.percent) || 100);
      var keyFlushLog = (config.keyFlush && config.keyFlush.log) || "stdout";

      keyFlushInt = setInterval(function () {
        var key;
        var sortedKeys = [];

        for (key in keyCounter) {
          sortedKeys.push([key, keyCounter[key]]);
        }

        sortedKeys.sort(function(a, b) { return b[1] - a[1]; });

        var logMessage = "";
        var timeString = (new Date()) + "";

        // only show the top "keyFlushPercent" keys
        for (var i = 0, e = sortedKeys.length * (keyFlushPercent / 100); i < e; i++) {
          logMessage += timeString + " " + sortedKeys[i][1] + " " + sortedKeys[i][0] + "\n";
        }

        var logFile = fs.createWriteStream(keyFlushLog, {flags: 'a+'});
        logFile.write(logMessage);
        logFile.end();

        // clear the counter
        keyCounter = {};
      }, keyFlushInterval);
    }

  }
});

