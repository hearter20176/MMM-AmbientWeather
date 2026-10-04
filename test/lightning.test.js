/* Lightning tests for MMM-AmbientWeather.js: strike detection from realtime packets, the
 * page-wide banner (appended to document.body), its refresh/cooldown/escalation rules, and the
 * tile row. Uses a minimal fake DOM, a fake clock (Date and timers) and no browser.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const MODULE_PATH = path.join(__dirname, "..", "MMM-AmbientWeather.js");
const MIN = 60 * 1000;
const T0 = Date.parse("2026-10-03T19:00:00Z");

class FakeElement {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this._classes = new Set();
    this.textContent = "";
    this.innerHTML = "";
    this.style = { setProperty() {} };
    const self = this;
    this.classList = {
      add: (c) => self._classes.add(c),
      contains: (c) => self._classes.has(c)
    };
  }
  get className() {
    return [...this._classes].join(" ");
  }
  set className(v) {
    this._classes = new Set(`${v}`.split(/\s+/).filter(Boolean));
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    this.children = this.children.filter((c) => c !== child);
    child.parentNode = null;
    return child;
  }
}

function setup(configOverrides = {}) {
  const clock = { now: T0, timers: new Map(), seq: 0 };
  class FakeDate extends Date {
    constructor(...args) {
      if (args.length) super(...args);
      else super(clock.now);
    }
    static now() {
      return clock.now;
    }
  }
  const body = new FakeElement("body");
  const notifications = [];
  const warnings = [];
  const sandbox = {
    Module: { register: (name, def) => (sandbox.def = def) },
    Log: { info() {}, log() {}, warn: (...a) => warnings.push(a.join(" ")), error() {} },
    window: undefined,
    navigator: undefined,
    console,
    Date: FakeDate,
    document: { body, createElement: (tag) => new FakeElement(tag) },
    setTimeout: (fn, ms) => {
      const id = ++clock.seq;
      clock.timers.set(id, { fn, at: clock.now + ms });
      return id;
    },
    clearTimeout: (id) => clock.timers.delete(id),
    setInterval: () => 0,
    clearInterval() {}
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(MODULE_PATH, "utf8"), sandbox, { filename: MODULE_PATH });
  const def = sandbox.def;
  const m = Object.assign({}, def, {
    name: "MMM-AmbientWeather",
    identifier: "module_1_MMM-AmbientWeather",
    config: Object.assign({}, def.defaults, { animateIcons: false }, configOverrides),
    sendNotification: (n, p) => notifications.push({ n, p }),
    sendSocketNotification() {},
    file: (f) => f
  });
  m.start();
  const advance = (ms) => {
    const end = clock.now + ms;
    for (;;) {
      const due = [...clock.timers.entries()]
        .filter(([, t]) => t.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      clock.timers.delete(due[0]);
      clock.now = due[1].at;
      due[1].fn();
    }
    clock.now = end;
  };
  const packet = (fields) => m._trackLightning(Object.assign({ tempf: 70 }, fields));
  const strikes = () => notifications.filter((x) => x.n === "AMBIENT_LIGHTNING");
  const banners = () => body.children.filter((c) => c.classList.contains("aw-lightning-alert"));
  return { m, clock, body, notifications, warnings, advance, packet, strikes, banners };
}

test("the first packet only sets the baseline, even with recent strikes", () => {
  const { packet, strikes, banners } = setup();
  packet({ lightning_day: 4, lightning_hour: 2, lightning_time: T0 - 2 * MIN, lightning_distance: 7 });
  assert.equal(strikes().length, 0);
  assert.equal(banners().length, 0);
});

test("a rise in lightning_day is a strike: notification and a page-wide banner", () => {
  const { packet, strikes, banners } = setup();
  packet({ lightning_day: 0, lightning_hour: 0 });
  packet({ lightning_day: 1, lightning_hour: 1, lightning_time: T0, lightning_distance: 7.46 });
  assert.equal(strikes().length, 1);
  const p = strikes()[0].p;
  assert.equal(p.distance, 7.5);
  assert.equal(p.unit, "mi");
  assert.equal(p.strikesHour, 1);
  assert.equal(p.strikesDay, 1);
  assert.equal(p.time, new Date(T0).toISOString());
  const [el] = banners();
  assert.ok(el, "banner appended to document.body");
  assert.equal(el.attrs.role, "alert");
  assert.match(el.innerHTML, /Lightning strike detected/);
  assert.match(el.innerHTML, /7\.5 mi away/);
  assert.match(el.innerHTML, /1 strike in the last hour/);
  assert.ok(el.classList.contains("aw-lightning-alert-bottom"));
  assert.ok(!el.classList.contains("aw-lightning-danger"));
});

test("a newer lightning_time alone is a strike", () => {
  const { packet, strikes } = setup();
  packet({ lightning_day: 3, lightning_time: T0 - 20 * MIN });
  packet({ lightning_day: 3, lightning_time: T0 - 1 * MIN });
  assert.equal(strikes().length, 1);
});

test("an unchanged packet, a midnight reset and a stale timestamp are not strikes", () => {
  const { packet, strikes, clock } = setup();
  packet({ lightning_day: 5, lightning_time: T0 - 5 * MIN });
  packet({ lightning_day: 5, lightning_time: T0 - 5 * MIN });
  packet({ lightning_day: 0, lightning_time: T0 - 5 * MIN }); // local midnight reset
  clock.now += 3 * 60 * MIN;
  packet({ lightning_day: 0, lightning_time: T0 - 1 * MIN }); // newer, but 3 h old now
  assert.equal(strikes().length, 0);
  packet({ lightning_day: 1 }); // first strike of the new day, no timestamp yet
  assert.equal(strikes().length, 1);
});

test("lightning_time accepts epoch ms, epoch seconds and ISO strings", () => {
  const { m } = setup();
  assert.equal(m._lightningTimeMs(T0), T0);
  assert.equal(m._lightningTimeMs(T0 / 1000), T0);
  assert.equal(m._lightningTimeMs(new Date(T0).toISOString()), T0);
  assert.equal(m._lightningTimeMs(`${T0}`), T0);
  assert.equal(m._lightningTimeMs(null), null);
  assert.equal(m._lightningTimeMs(0), null);
  assert.equal(m._lightningTimeMs("not a date"), null);
});

test("strikes while the banner is up refresh it in place and restart its timer", () => {
  const { packet, banners, advance } = setup({ lightningAlertDuration: 60 });
  packet({ lightning_day: 0 });
  packet({ lightning_day: 1, lightning_hour: 1, lightning_distance: 9 });
  advance(50 * 1000);
  packet({ lightning_day: 2, lightning_hour: 2, lightning_distance: 8 });
  assert.equal(banners().length, 1, "one element, reused");
  assert.match(banners()[0].innerHTML, /8\.0 mi away/);
  assert.match(banners()[0].innerHTML, /2 strikes in the last hour/);
  assert.ok(!banners()[0].classList.contains("aw-lightning-enter"), "no second entrance animation");
  advance(50 * 1000); // 100 s after the first strike, 50 s after the refresh
  assert.equal(banners().length, 1, "timer restarted by the refresh");
  advance(10 * 1000 + 600);
  assert.equal(banners().length, 0, "faded out and removed from the DOM");
});

test("after the banner closes, the cooldown suppresses it; strikes still notify", () => {
  const { packet, banners, strikes, advance } = setup({ lightningAlertDuration: 60, lightningAlertCooldown: 10 });
  packet({ lightning_day: 0 });
  packet({ lightning_day: 1, lightning_distance: 9 });
  advance(61 * 1000);
  assert.equal(banners().length, 0);
  packet({ lightning_day: 2, lightning_distance: 9 });
  assert.equal(banners().length, 0, "inside the cooldown");
  assert.equal(strikes().length, 2, "notification still sent");
  advance(10 * MIN);
  packet({ lightning_day: 3, lightning_distance: 9 });
  assert.equal(banners().length, 1, "cooldown over");
});

test("a strike that becomes dangerous skips the cooldown and uses the urgent style", () => {
  const { packet, banners, advance } = setup({ lightningAlertDuration: 60, lightningAlertCooldown: 10 });
  packet({ lightning_day: 0 });
  packet({ lightning_day: 1, lightning_distance: 12 });
  advance(61 * 1000);
  packet({ lightning_day: 2, lightning_distance: 4 });
  assert.equal(banners().length, 1);
  assert.ok(banners()[0].classList.contains("aw-lightning-danger"));
  assert.match(banners()[0].innerHTML, /Lightning strike nearby/);
  advance(61 * 1000);
  packet({ lightning_day: 3, lightning_distance: 3 });
  assert.equal(banners().length, 0, "already urgent: the cooldown applies again");
});

test("metric units convert the distance and compare the danger threshold in km", () => {
  const { packet, banners, strikes } = setup({ units: "metric", lightningDangerDistance: 10 });
  packet({ lightning_day: 0 });
  packet({ lightning_day: 1, lightning_distance: 5 }); // 8.0 km
  assert.equal(strikes()[0].p.unit, "km");
  assert.equal(strikes()[0].p.distance, 8);
  assert.match(banners()[0].innerHTML, /8\.0 km away/);
  assert.ok(banners()[0].classList.contains("aw-lightning-danger"));
});

test("lightningAlert: false keeps the notification but shows no banner; top position works", () => {
  const off = setup({ lightningAlert: false });
  off.packet({ lightning_day: 0 });
  off.packet({ lightning_day: 1 });
  assert.equal(off.strikes().length, 1);
  assert.equal(off.banners().length, 0);

  const top = setup({ lightningAlertPosition: "top" });
  top.packet({ lightning_day: 0 });
  top.packet({ lightning_day: 1 });
  assert.ok(top.banners()[0].classList.contains("aw-lightning-alert-top"));
});

test("the tile row: hidden without strikes in auto mode, counts and last strike when present", () => {
  const { m } = setup({ showLightning: "auto" });
  assert.equal(m._lightningRow({ lightning_day: 0, lightning_hour: 0 }), null);
  assert.equal(m._lightningRow({ tempf: 70 }), null, "no lightning sensor");
  const row = m._lightningRow({ lightning_day: 12, lightning_hour: 3, lightning_time: T0 - 5 * MIN, lightning_distance: 7.46 });
  assert.match(row.innerHTML, /fa-bolt/);
  assert.match(row.innerHTML, /Lightning: 12 today · 3 last hr/);
  assert.match(row.innerHTML, /Last .+ · 7\.5 mi/);
  assert.ok(row.classList.contains("aw-lightning-active"), "within 30 min of the last strike");
  const stale = m._lightningRow({ lightning_day: 12, lightning_hour: 0, lightning_time: T0 - 45 * MIN });
  assert.ok(!stale.classList.contains("aw-lightning-active"));
});

test("the tile row honours showLightning always/never", () => {
  const always = setup({ showLightning: "always" }).m;
  assert.match(always._lightningRow({ lightning_day: 0, lightning_hour: 0 }).innerHTML, /0 today · 0 last hr/);
  const never = setup({ showLightning: "never" }).m;
  assert.equal(never._lightningRow({ lightning_day: 5, lightning_hour: 5 }), null);
});

function renderedText(el) {
  let out = `${el.className} ${el.textContent} ${el.innerHTML}`;
  el.children.forEach((c) => (out += ` ${renderedText(c)}`));
  return out;
}

test("getDom shows the row in the card and the NEARBY badge only while a strike is recent", () => {
  const { m, clock } = setup({ showNwsForecast: false, showLightning: "auto" });
  m.loaded = true;
  m.isDomReady = false;
  m.weatherData = { tempf: 70, humidity: 50, windspeedmph: 3, winddir: 90, lightning_day: 2, lightning_hour: 1, lightning_time: T0 - 3 * MIN, lightning_distance: 10 };
  let html = renderedText(m.getDom());
  assert.match(html, /Lightning: 2 today · 1 last hr/);
  assert.match(html, /LIGHTNING NEARBY/);
  clock.now += 40 * MIN;
  html = renderedText(m.getDom());
  assert.match(html, /Lightning: 2 today/, "row stays for the day");
  assert.doesNotMatch(html, /LIGHTNING NEARBY/, "badge gone after lightningActiveMinutes");
  m.weatherData = Object.assign({}, m.weatherData, { lightning_day: 0, lightning_hour: 0 });
  html = renderedText(m.getDom());
  assert.doesNotMatch(html, /Lightning:/, "no row on a day without strikes");
});

test("a station clock ahead of the Pi does not drop strikes (age uses the packet's dateutc)", () => {
  const { packet, strikes, m } = setup();
  packet({ lightning_day: 0, dateutc: T0 + 2 * MIN });
  // Station clock 2 min ahead: the strike time is "in the future" for the Pi.
  packet({ lightning_day: 1, lightning_time: T0 + 2 * MIN, dateutc: T0 + 2 * MIN });
  assert.equal(strikes().length, 1);
  // Even without dateutc, a slightly-future timestamp counts as fresh rather than being rejected.
  packet({ lightning_day: 2, lightning_time: T0 + 5 * MIN });
  assert.equal(strikes().length, 2);
  assert.ok(m._lightningActive(T0 + 5 * MIN, T0));
});

test("a station clock behind the Pi does not mark live strikes as stale", () => {
  const { packet, strikes } = setup({ lightningActiveMinutes: 30 });
  packet({ lightning_day: 0, dateutc: T0 - 45 * MIN });
  packet({ lightning_day: 1, lightning_time: T0 - 44 * MIN, dateutc: T0 - 44 * MIN });
  assert.equal(strikes().length, 1, "44 min old by the Pi's clock, 0 min by the station's");
});

test("a day-count rise with an old, unchanged timestamp is still a strike (time not reported)", () => {
  const { packet, strikes } = setup();
  packet({ lightning_day: 3, lightning_time: T0 - 5 * 60 * MIN });
  packet({ lightning_day: 4, lightning_time: T0 - 5 * 60 * MIN, lightning_distance: 9 });
  assert.equal(strikes().length, 1);
  assert.equal(strikes()[0].p.time, null, "the 5 h old timestamp is not this strike's time");
});

test("string numbers from the station are parsed", () => {
  const { packet, strikes } = setup();
  packet({ lightning_day: "0", lightning_hour: "0" });
  packet({ lightning_day: "2", lightning_hour: "2", lightning_distance: "4.5", lightning_time: `${T0}` });
  assert.equal(strikes().length, 1);
  assert.equal(strikes()[0].p.distance, 4.5);
  assert.equal(strikes()[0].p.strikesDay, 2);
});

test("station values are escaped in the banner and the tile row", () => {
  const { packet, banners, m } = setup({ showLightning: "always" });
  const evil = "<img src=x onerror=alert(1)>";
  packet({ lightning_day: 0 });
  packet({ lightning_day: 1, lightning_hour: evil, lightning_distance: evil });
  assert.doesNotMatch(banners()[0].innerHTML, /<img/);
  const row = m._lightningRow({ lightning_day: evil, lightning_hour: 1 });
  assert.doesNotMatch(row.innerHTML, /<img/);
});

test("a close strike during the fade-out brings the banner back; a far one waits for the cooldown", () => {
  const { packet, banners, advance } = setup({ lightningAlertDuration: 60, lightningAlertCooldown: 10 });
  packet({ lightning_day: 0 });
  packet({ lightning_day: 1, lightning_distance: 15 });
  advance(60 * 1000 + 300); // fading
  assert.ok(banners()[0].classList.contains("aw-lightning-leave"));
  packet({ lightning_day: 2, lightning_distance: 15 });
  advance(400);
  assert.equal(banners().length, 0, "far strike in the fade: removed, cooldown running");

  const b = setup({ lightningAlertDuration: 60, lightningAlertCooldown: 10 });
  b.packet({ lightning_day: 0 });
  b.packet({ lightning_day: 1, lightning_distance: 15 });
  b.advance(60 * 1000 + 300);
  b.packet({ lightning_day: 2, lightning_distance: 3 });
  b.advance(400);
  assert.equal(b.banners().length, 1, "close strike in the fade: banner kept");
  assert.ok(!b.banners()[0].classList.contains("aw-lightning-leave"));
  assert.ok(b.banners()[0].classList.contains("aw-lightning-danger"));
});

test("an urgent banner stays urgent when a farther strike refreshes it", () => {
  const { packet, banners } = setup();
  packet({ lightning_day: 0 });
  packet({ lightning_day: 1, lightning_distance: 3 });
  packet({ lightning_day: 2, lightning_distance: 14 });
  assert.ok(banners()[0].classList.contains("aw-lightning-danger"));
  assert.match(banners()[0].innerHTML, /Lightning strike nearby/);
  assert.match(banners()[0].innerHTML, /14\.0 mi away/);
});

test("AMBIENT_DATA packets drive detection through socketNotificationReceived", () => {
  const { m, strikes, banners } = setup();
  m.safeUpdateDom = () => {};
  m.socketNotificationReceived("AMBIENT_DATA", { lastData: { tempf: 70, lightning_day: 0 } });
  m.socketNotificationReceived("AMBIENT_DATA", { lastData: { tempf: 70, lightning_day: 1, lightning_distance: 8 } });
  assert.equal(strikes().length, 1);
  assert.equal(banners().length, 1);
});

test("reduced motion: no entrance animation class and immediate removal", () => {
  const { packet, banners, advance } = setup({ reduceMotion: true, lightningAlertDuration: 10 });
  packet({ lightning_day: 0 });
  packet({ lightning_day: 1 });
  assert.ok(banners()[0].classList.contains("aw-lightning-reduced"));
  assert.ok(!banners()[0].classList.contains("aw-lightning-enter"));
  advance(10 * 1000);
  assert.equal(banners().length, 0);
});

test("invalid lightning options warn and fall back to defaults; valid aliases are accepted", () => {
  const bad = setup({
    showLightning: "sometimes",
    lightningActiveMinutes: -5,
    lightningAlertDuration: 1,
    lightningAlertCooldown: "soon",
    lightningDangerDistance: -1,
    lightningAlertPosition: "middle"
  });
  const c = bad.m.lightningCfg;
  assert.equal(c.show, "always");
  assert.equal(c.activeMs, 30 * MIN);
  assert.equal(c.durationMs, 60 * 1000);
  assert.equal(c.cooldownMs, 10 * MIN);
  assert.equal(c.dangerDistance, 6);
  assert.equal(c.position, "bottom");
  assert.equal(bad.warnings.filter((w) => /Invalid/.test(w)).length, 6);
  // the strike is not lost because of the bad activeMinutes value
  bad.packet({ lightning_day: 0 });
  bad.packet({ lightning_day: 1, lightning_time: T0 });
  assert.equal(bad.strikes().length, 1);

  const ok = setup({ showLightning: true, lightningAlertPosition: " Top ", lightningAlertCooldown: 0, lightningDangerDistance: 0 });
  assert.equal(ok.m.lightningCfg.show, "always");
  assert.equal(ok.m.lightningCfg.position, "top");
  assert.equal(ok.m.lightningCfg.cooldownMs, 0);
  assert.equal(ok.m.lightningCfg.dangerDistance, 0);
  assert.equal(ok.warnings.length, 0);
  assert.equal(setup({ showLightning: false }).m.lightningCfg.show, "never");
  assert.equal(setup({ showLightning: "AUTO" }).m.lightningCfg.show, "auto");
});

test("the default row shows on a quiet day with 'No strikes logged' when nothing is recorded", () => {
  const { m } = setup();
  const row = m._lightningRow({ lightning_day: 0, lightning_hour: 0 });
  assert.match(row.innerHTML, /fa-bolt/);
  assert.match(row.innerHTML, /Lightning: 0 today · 0 last hr/);
  assert.match(row.innerHTML, /No strikes logged/);
  const old = m._lightningRow({ lightning_day: 0, lightning_hour: 0, lightning_time: T0 - 3 * 24 * 60 * MIN, lightning_distance: 11 });
  assert.match(old.innerHTML, /Last .+ · 11\.0 mi/);
  assert.ok(!old.classList.contains("aw-lightning-active"));
});

test("row: counts above zero without time/distance yet show no 'No strikes logged' line", () => {
  const { m } = setup();
  const row = m._lightningRow({ lightning_day: 3, lightning_hour: 1 });
  assert.match(row.innerHTML, /Lightning: 3 today/);
  assert.doesNotMatch(row.innerHTML, /No strikes logged/);
  assert.doesNotMatch(row.innerHTML, /aw-lightning-last/);
});

test("lightningAlert accepts booleans and 'true'/'false' strings, warns on anything else", () => {
  assert.equal(setup({ lightningAlert: "false" }).m.lightningCfg.alert, false);
  assert.equal(setup({ lightningAlert: "true" }).m.lightningCfg.alert, true);
  const bad = setup({ lightningAlert: "nope" });
  assert.equal(bad.m.lightningCfg.alert, true);
  assert.ok(bad.warnings.some((w) => /Invalid lightningAlert/.test(w)));
});

test("a timestamp more than 15 min ahead of the station clock is not treated as active", () => {
  const { m } = setup();
  assert.ok(m._lightningActive(T0 + 10 * MIN, T0));
  assert.ok(!m._lightningActive(T0 + 24 * 60 * MIN, T0));
});

test("a corrupt far-future lightning_time neither swallows a day-count rise nor gets stored", () => {
  const { packet, strikes, m } = setup();
  packet({ lightning_day: 1, lightning_time: T0 - 10 * MIN, dateutc: T0 });
  packet({ lightning_day: 2, lightning_time: T0 + 24 * 60 * MIN, dateutc: T0 });
  assert.equal(strikes().length, 1, "the day-count rise still counts");
  assert.equal(strikes()[0].p.time, null, "the corrupt time is not reported");
  assert.equal(m.lightningState.time, T0 - 10 * MIN, "nor stored as the last strike");
  packet({ lightning_day: 2, lightning_time: T0 - 1 * MIN, dateutc: T0 });
  assert.equal(strikes().length, 2, "a later real timestamp still counts as new");
  packet({ lightning_day: 2, lightning_time: T0 + 48 * 60 * MIN, dateutc: T0 });
  assert.equal(strikes().length, 2, "a corrupt time alone is not a strike");
});

test("without dateutc, a station clock hours ahead still reports strikes via the day count", () => {
  const { packet, strikes } = setup();
  packet({ lightning_day: 0 });
  packet({ lightning_day: 1, lightning_time: T0 + 2 * 60 * MIN });
  assert.equal(strikes().length, 1);
});

test("reconnect-gap replay: day count rose and the time advanced to an old value - no strike", () => {
  const { packet, strikes, banners } = setup();
  packet({ lightning_day: 3, lightning_time: T0 - 5 * 60 * MIN, dateutc: T0 });
  packet({ lightning_day: 9, lightning_time: T0 - 90 * MIN, dateutc: T0 });
  assert.equal(strikes().length, 0, "strikes missed during the gap are not announced");
  assert.equal(banners().length, 0);
});
