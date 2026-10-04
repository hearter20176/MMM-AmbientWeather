/* Tests for MMM-AmbientWeather.js
 *
 * The MagicMirror front-end module format relies on globals (Module.register, Log, document,
 * window) provided by MagicMirror's browser runtime. This stubs the minimum needed to capture the
 * object passed to Module.register and exercise its pure logic methods directly, without needing
 * a DOM. getDom()/rendering is intentionally out of scope here; the methods under test (error
 * message selection, night-condition classification, static icon fallback, unit conversion) do
 * not touch the DOM.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const MODULE_PATH = path.join(__dirname, "..", "MMM-AmbientWeather.js");

function loadModuleDefinition() {
  let captured = null;
  const context = {
    Module: {
      register(name, def) {
        captured = def;
      }
    },
    Log: {
      info() {},
      log() {},
      warn() {},
      error() {}
    },
    window: undefined,
    navigator: undefined,
    console
  };
  vm.createContext(context);
  const src = fs.readFileSync(MODULE_PATH, "utf8");
  vm.runInContext(src, context, { filename: MODULE_PATH });
  return captured;
}

function makeInstance(configOverrides = {}) {
  const def = loadModuleDefinition();
  const instance = Object.assign({}, def, {
    name: "MMM-AmbientWeather",
    identifier: "module_1_MMM-AmbientWeather",
    config: Object.assign({}, def.defaults, configOverrides),
    forecast: [],
    tonight: null
  });
  return instance;
}

test("_currentCondition falls back to the solar heuristic during the day", () => {
  const instance = makeInstance();
  const now = new Date();
  const sunrise = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString();
  const sunset = new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString();
  const cond = instance._currentCondition({
    sunrise,
    sunset,
    solarradiation: 400,
    uv: 5,
    humidity: 40,
    hourlyrainin: 0
  });
  assert.equal(cond, "clear");
});

test("_currentCondition does not classify night readings as cloud by default", () => {
  const instance = makeInstance();
  const now = new Date();
  // sunrise/sunset both in the past => currently night
  const sunrise = new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString();
  const sunset = new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString();
  const cond = instance._currentCondition({
    sunrise,
    sunset,
    solarradiation: 0,
    uv: 0,
    humidity: 50,
    hourlyrainin: 0
  });
  assert.notEqual(cond, "cloud");
  assert.equal(cond, "clear");
});

test("_currentCondition prefers this.tonight's condition at night when available (not forecast[0], which is tomorrow's daytime period)", () => {
  const instance = makeInstance();
  const now = new Date();
  const sunrise = new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString();
  const sunset = new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString();
  // forecast[0] is tomorrow's daytime period and must NOT be used as the night fallback.
  instance.forecast = [{ cond: "clear" }];
  instance.tonight = { cond: "rain", phrase: "Rain likely" };
  const cond = instance._currentCondition({
    sunrise,
    sunset,
    solarradiation: 0,
    uv: 0,
    humidity: 50,
    hourlyrainin: 0
  });
  assert.equal(cond, "rain");
});

test("_currentCondition lets the station's own measured rain win over a clear tonight forecast, day or night", () => {
  const instance = makeInstance();
  const now = new Date();
  const sunrise = new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString();
  const sunset = new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString();
  instance.forecast = [{ cond: "clear" }];
  instance.tonight = { cond: "clear", phrase: "Clear" };
  const cond = instance._currentCondition({
    sunrise,
    sunset,
    solarradiation: 0,
    uv: 0,
    humidity: 97,
    hourlyrainin: 0.5,
    tempf: 50
  });
  assert.equal(cond, "rain");
});

test("_currentCondition still classifies high-humidity nights as cloud", () => {
  const instance = makeInstance();
  const now = new Date();
  const sunrise = new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString();
  const sunset = new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString();
  const cond = instance._currentCondition({
    sunrise,
    sunset,
    solarradiation: 0,
    uv: 0,
    humidity: 95,
    hourlyrainin: 0
  });
  assert.equal(cond, "cloud");
});

test("_staticIconClass maps day/night conditions to distinct Font Awesome icons", () => {
  const instance = makeInstance();
  assert.equal(instance._staticIconClass("clear", true), "fa-sun");
  assert.equal(instance._staticIconClass("clear", false), "fa-moon");
  assert.equal(instance._staticIconClass("rain", true), "fa-cloud-rain");
  assert.equal(instance._staticIconClass("thunderstorm", false), "fa-bolt");
  assert.equal(instance._staticIconClass("unknown_condition", true), "fa-cloud-sun");
});

test("_temp converts Fahrenheit to Celsius only when units is metric", () => {
  const imperial = makeInstance({ units: "imperial" });
  assert.equal(imperial._temp(212), 212);

  const metric = makeInstance({ units: "metric" });
  assert.equal(Math.round(metric._temp(212)), 100);
  assert.equal(Math.round(metric._temp(32)), 0);
});

test("_windSpeed and _windUnit convert mph to km/h only when units is metric", () => {
  const imperial = makeInstance({ units: "imperial" });
  assert.equal(imperial._windSpeed(10), 10);
  assert.equal(imperial._windUnit(), "mph");

  const metric = makeInstance({ units: "metric" });
  assert.ok(Math.abs(metric._windSpeed(10) - 16.09344) < 0.001);
  assert.equal(metric._windUnit(), "km/h");
});

test("_esc escapes HTML-significant characters", () => {
  const instance = makeInstance();
  assert.equal(instance._esc('<script>alert("x")</script>'), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
});

test("_errorMessage renders a distinct, human-readable message per error code", () => {
  const instance = makeInstance();
  assert.match(instance._errorMessage({ code: "CONFIG" }), /apiKey|applicationKey/);
  assert.match(instance._errorMessage({ code: "CONNECT" }), /connect/i);
  assert.match(instance._errorMessage({ code: "NO_DATA" }), /no data|macAddress/i);
  assert.match(instance._errorMessage({ code: "AUTH" }), /key|device/i);
  assert.match(instance._errorMessage({ message: "weird" }), /weird/);
});

test("every default and resolved Lottie animation filename exists on disk", () => {
  const instance = makeInstance();
  const animationsDir = path.join(__dirname, "..", "animations");
  const conditions = Object.keys(instance.config.animations).filter((k) => k !== "default");

  for (const cond of [...conditions, "default"]) {
    for (const isDay of [true, false]) {
      const file = instance._resolveAnimationFile(cond, isDay);
      const full = path.join(animationsDir, file);
      assert.ok(
        fs.existsSync(full),
        `${cond} (${isDay ? "day" : "night"}) resolves to missing file: ${file}`
      );
    }
  }
});

test("updateInterval is not a module default (dead/never-read option, removed)", () => {
  const instance = makeInstance();
  assert.equal(Object.prototype.hasOwnProperty.call(instance.config, "updateInterval"), false);
});
