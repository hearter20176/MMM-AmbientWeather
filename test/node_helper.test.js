/* Tests for node_helper.js
 *
 * node_helper.js requires "node_helper" (MagicMirror core) and "logger" (MagicMirror core),
 * neither of which resolve outside a running MagicMirror install. Rather than depending on the
 * whole MagicMirror runtime, this loads node_helper.js's source through a hand-built CommonJS
 * wrapper with a fake `require` that substitutes those (plus socket.io-client and https) with
 * in-memory test doubles. socket.io-client's real transport is intentionally not exercised here;
 * only node_helper.js's own reaction to socket/https events is under test.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("module");
const EventEmitter = require("node:events");

const HELPER_PATH = path.join(__dirname, "..", "node_helper.js");

function loadNodeHelperDefinition({ ioImpl, httpsImpl, logImpl }) {
  const src = fs.readFileSync(HELPER_PATH, "utf8");
  const wrapper = Module.wrap(src);
  const script = vm.runInThisContext(wrapper, { filename: HELPER_PATH });
  const fakeModule = { exports: {} };
  const fakeRequire = (request) => {
    // the helper imports built-ins with the node: scheme (node:https); match them by bare name
    const name = request.replace(/^node:/, "");
    if (name === "node_helper") return { create: (obj) => obj };
    if (name === "socket.io-client") return ioImpl;
    if (name === "suncalc") return require("suncalc");
    if (name === "https") return httpsImpl;
    if (name === "logger") return logImpl;
    return require(name);
  };
  script(fakeModule.exports, fakeRequire, fakeModule, HELPER_PATH, path.dirname(HELPER_PATH));
  return fakeModule.exports;
}

function makeHelper({ httpsImpl } = {}) {
  const notifications = [];
  const sockets = [];
  const ioImpl = (url, opts) => {
    const socket = new EventEmitter();
    socket.url = url;
    socket.opts = opts;
    socket.disconnect = () => socket.emit("disconnect", "io client disconnect");
    sockets.push(socket);
    return socket;
  };
  const logImpl = {
    info() {},
    log() {},
    warn() {},
    error() {}
  };
  const defaultHttps = { get: () => ({ on() { return this; }, setTimeout() {}, destroy() {} }) };

  const definition = loadNodeHelperDefinition({
    ioImpl,
    httpsImpl: httpsImpl || defaultHttps,
    logImpl
  });

  const helper = Object.assign({}, definition, {
    name: "MMM-AmbientWeather",
    sendSocketNotification(notification, payload) {
      notifications.push({ notification, payload });
    }
  });
  helper.start();
  return { helper, notifications, sockets };
}

function lastSocket(sockets) {
  return sockets[sockets.length - 1];
}

test("connectAmbient sends AMBIENT_ERROR/CONFIG when apiKey is missing", () => {
  const { helper, notifications } = makeHelper();
  helper.connectAmbient({ apiKey: "", applicationKey: "app", macAddress: "AA:BB:CC:DD:EE:FF" });
  const err = notifications.find((n) => n.notification === "AMBIENT_ERROR");
  assert.ok(err, "expected an AMBIENT_ERROR notification");
  assert.equal(err.payload.code, "CONFIG");
});

test("connectAmbient sends AMBIENT_ERROR/CONFIG when applicationKey is missing", () => {
  const { helper, notifications } = makeHelper();
  helper.connectAmbient({ apiKey: "key", applicationKey: "", macAddress: "AA:BB:CC:DD:EE:FF" });
  const err = notifications.find((n) => n.notification === "AMBIENT_ERROR");
  assert.ok(err);
  assert.equal(err.payload.code, "CONFIG");
});

test("connectAmbient does not open a socket when keys are missing", () => {
  const { helper, sockets } = makeHelper();
  helper.connectAmbient({ apiKey: "", applicationKey: "" });
  assert.equal(sockets.length, 0);
});

test("a sustained connect_error sends AMBIENT_ERROR/CONNECT with the underlying message", () => {
  const { helper, notifications, sockets } = makeHelper();
  helper.connectAmbient({ apiKey: "key", applicationKey: "app", macAddress: "AA:BB:CC:DD:EE:FF" });
  lastSocket(sockets).emit("connect_error", new Error("auth failed"));

  const err = notifications.find((n) => n.notification === "AMBIENT_ERROR" && n.payload.code === "CONNECT");
  assert.ok(err, "expected an AMBIENT_ERROR/CONNECT notification");
  assert.match(err.payload.message, /auth failed/);
});

test("no matching-MAC packet within the watchdog window sends AMBIENT_ERROR/NO_DATA", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { helper, notifications, sockets } = makeHelper();
  helper.connectAmbient({ apiKey: "key", applicationKey: "app", macAddress: "AA:BB:CC:DD:EE:FF" });
  lastSocket(sockets).emit("subscribed", { devices: [{ macAddress: "AA:BB:CC:DD:EE:FF" }] });

  t.mock.timers.tick(3 * 60 * 1000 + 1);

  const err = notifications.find((n) => n.notification === "AMBIENT_ERROR" && n.payload.code === "NO_DATA");
  assert.ok(err, "expected an AMBIENT_ERROR/NO_DATA notification");
  assert.match(err.payload.message, /EE:FF|ee:ff/i);
});

test("a matching-MAC packet clears the NO_DATA watchdog and forwards AMBIENT_DATA", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { helper, notifications, sockets } = makeHelper();
  helper.connectAmbient({ apiKey: "key", applicationKey: "app", macAddress: "AA:BB:CC:DD:EE:FF" });
  const socket = lastSocket(sockets);
  socket.emit("subscribed", { devices: [{ macAddress: "AA:BB:CC:DD:EE:FF" }] });
  socket.emit("data", { macAddress: "AA:BB:CC:DD:EE:FF", tempf: 71.2 });

  t.mock.timers.tick(3 * 60 * 1000 + 1);

  const noDataErr = notifications.find((n) => n.notification === "AMBIENT_ERROR" && n.payload.code === "NO_DATA");
  assert.equal(noDataErr, undefined, "NO_DATA should not fire once real data has arrived");
  const data = notifications.find((n) => n.notification === "AMBIENT_DATA");
  assert.ok(data);
  assert.equal(data.payload.lastData.tempf, 71.2);
});

test("an empty device list on subscribe sends AMBIENT_ERROR/AUTH immediately (bad/unknown key)", () => {
  const { helper, notifications, sockets } = makeHelper();
  helper.connectAmbient({ apiKey: "bad", applicationKey: "bad", macAddress: "AA:BB:CC:DD:EE:FF" });
  lastSocket(sockets).emit("subscribed", { devices: [] });

  const err = notifications.find((n) => n.notification === "AMBIENT_ERROR" && n.payload.code === "AUTH");
  assert.ok(err, "expected an AMBIENT_ERROR/AUTH notification");
});

test("the NO_DATA watchdog is armed even when no macAddress filter is configured", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { helper, notifications, sockets } = makeHelper();
  helper.connectAmbient({ apiKey: "key", applicationKey: "app" });
  lastSocket(sockets).emit("subscribed", { devices: [{ macAddress: "AA:BB:CC:DD:EE:FF" }] });

  t.mock.timers.tick(3 * 60 * 1000 + 1);

  const err = notifications.find((n) => n.notification === "AMBIENT_ERROR" && n.payload.code === "NO_DATA");
  assert.ok(err, "expected an AMBIENT_ERROR/NO_DATA notification even without a configured macAddress");
});

test("with no macAddress configured, the first device on the subscribe response is used as the filter", () => {
  const { helper, notifications, sockets } = makeHelper();
  helper.connectAmbient({ apiKey: "key", applicationKey: "app" });
  const socket = lastSocket(sockets);
  socket.emit("subscribed", { devices: [{ macAddress: "11:22:33:44:55:66" }, { macAddress: "AA:BB:CC:DD:EE:FF" }] });

  // A packet from the second (non-first) device should now be ignored...
  socket.emit("data", { macAddress: "AA:BB:CC:DD:EE:FF", tempf: 99 });
  assert.equal(notifications.find((n) => n.notification === "AMBIENT_DATA"), undefined);

  // ...while a packet from the first device is forwarded.
  socket.emit("data", { macAddress: "11:22:33:44:55:66", tempf: 71.2 });
  const data = notifications.find((n) => n.notification === "AMBIENT_DATA");
  assert.ok(data);
  assert.equal(data.payload.lastData.tempf, 71.2);
});

test("a packet for a different MAC address is dropped silently (no AMBIENT_DATA)", () => {
  const { helper, notifications, sockets } = makeHelper();
  helper.connectAmbient({ apiKey: "key", applicationKey: "app", macAddress: "AA:BB:CC:DD:EE:FF" });
  lastSocket(sockets).emit("data", { macAddress: "11:22:33:44:55:66", tempf: 71.2 });

  const data = notifications.find((n) => n.notification === "AMBIENT_DATA");
  assert.equal(data, undefined);
});

test("forecast fetch failure (non-invalid-point) reports the error and any cached forecast", () => {
  const failingHttps = {
    get(url, opts, cb) {
      const res = new EventEmitter();
      res.statusCode = 500;
      process.nextTick(() => {
        cb(res);
        res.emit("data", JSON.stringify({ title: "Internal Server Error" }));
        res.emit("end");
      });
      return { on() { return this; }, setTimeout() {}, destroy() {} };
    }
  };
  const { helper, notifications } = makeHelper({ httpsImpl: failingHttps });

  return new Promise((resolve) => {
    helper.sendSocketNotification = (notification, payload) => {
      notifications.push({ notification, payload });
      if (notification === "NWS_FORECAST") {
        assert.ok(payload.error, "expected an error field on the forecast payload");
        assert.deepEqual(payload.forecast, []);
        resolve();
      }
    };
    helper.fetchNwsForecast({ lat: 40.0, lon: -74.0, days: 3 });
  });
});

test("fetchNwsForecast sends a separate 'tonight' condition distinct from forecast[0] (tomorrow's day period)", () => {
  const now = Date.now();
  const period = (offsetStartHrs, offsetEndHrs, isDaytime, name, shortForecast, temperature) => ({
    startTime: new Date(now + offsetStartHrs * 3600e3).toISOString(),
    endTime: new Date(now + offsetEndHrs * 3600e3).toISOString(),
    isDaytime,
    name,
    shortForecast,
    temperature
  });
  const periods = [
    period(-2, 10, true, "Today", "Sunny", 75),
    period(10, 22, false, "Tonight", "Rain Likely", 50),
    period(22, 34, true, "Tuesday", "Sunny", 78)
  ];

  const pointsResponse = JSON.stringify({
    properties: { forecast: "https://api.weather.gov/gridpoints/XXX/1,2/forecast" }
  });
  const forecastResponse = JSON.stringify({ properties: { periods } });

  const okHttps = {
    get(url, opts, cb) {
      const res = new EventEmitter();
      res.statusCode = 200;
      const body = url.includes("/points/") ? pointsResponse : forecastResponse;
      process.nextTick(() => {
        cb(res);
        res.emit("data", body);
        res.emit("end");
      });
      return { on() { return this; }, setTimeout() {}, destroy() {} };
    }
  };
  const { helper, notifications } = makeHelper({ httpsImpl: okHttps });

  return new Promise((resolve) => {
    helper.sendSocketNotification = (notification, payload) => {
      notifications.push({ notification, payload });
      if (notification === "NWS_FORECAST") {
        assert.equal(payload.forecast[0].cond, "clear", "forecast[0] should be the Today/Sunny daytime period");
        assert.ok(payload.tonight, "expected a tonight field");
        assert.equal(payload.tonight.cond, "rain", "tonight should be the Tonight/Rain Likely night period");
        assert.notEqual(payload.tonight.cond, payload.forecast[0].cond);
        resolve();
      }
    };
    helper.fetchNwsForecast({ lat: 40.0, lon: -74.0, days: 3 });
  });
});

test("_conditionFromText maps common NWS phrases to condition keys", () => {
  const { helper } = makeHelper();
  assert.equal(helper._conditionFromText("Mostly Clear"), "clear");
  assert.equal(helper._conditionFromText("Chance Thunderstorms"), "thunderstorm");
  assert.equal(helper._conditionFromText("Overcast"), "cloud");
  assert.equal(helper._conditionFromText(""), null);
});
