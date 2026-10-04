/* Lifecycle tests for MMM-AmbientWeather.js: Lottie players must be bound to the exact container
 * elements built by getDom(), never leak across re-renders, ignore stale timers, and honour
 * MagicMirror suspend()/resume(). Uses a minimal fake DOM, fake Lottie and a fake clock - there
 * is no browser here. document.getElementById deliberately throws: id lookups are the bug that
 * caused the leak (they bind to the outgoing DOM that MagicMirror keeps attached during a fade).
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const MODULE_PATH = path.join(__dirname, "..", "MMM-AmbientWeather.js");

class FakeElement {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.parentNode = null;
    this.attached = false; // only meaningful on a root node
    this.styleProps = {};
    this.style = { setProperty: (k, v) => (this.styleProps[k] = v) };
    this.className = "";
    this.classList = { add: () => {} };
    this.textContent = "";
    this.innerHTML = "";
    this.id = "";
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n.attached === true;
  }
  walk(fn) {
    fn(this);
    this.children.forEach((c) => c.walk(fn));
  }
}

function setup(configOverrides = {}) {
  const clock = { now: 0, timers: new Map(), seq: 0 };
  const live = new Set(); // every non-destroyed fake player
  const created = [];
  const warnings = [];
  const sandbox = {
    Module: { register: (name, def) => (sandbox.def = def) },
    Log: { info() {}, log() {}, warn: (...a) => warnings.push(a.join(" ")), error() {} },
    window: undefined,
    navigator: undefined,
    console,
    document: {
      createElement: (tag) => new FakeElement(tag),
      getElementById() {
        throw new Error("getElementById must not be used to bind players");
      }
    },
    setTimeout(fn, ms) {
      const id = ++clock.seq;
      clock.timers.set(id, { fn, at: clock.now + (ms || 0) });
      return id;
    },
    clearTimeout(id) {
      clock.timers.delete(id);
    },
    setInterval() {
      return ++clock.seq;
    },
    clearInterval() {},
    lottie: {
      loadAnimation(opts) {
        assert.ok(opts.container.isConnected, "player created for a detached container");
        const player = {
          container: opts.container,
          paused: opts.autoplay === false,
          destroyed: false,
          destroy() {
            // Real Lottie empties the container on destroy; this is what makes a destroyed-but-
            // still-visible player show up as a blank icon.
            this.container.cleared = true;
            this.destroyed = true;
            live.delete(this);
          },
          pause() {
            this.paused = true;
          },
          play() {
            this.paused = false;
          }
        };
        live.add(player);
        created.push(player);
        return player;
      }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(MODULE_PATH, "utf8"), sandbox, { filename: MODULE_PATH });
  const inst = Object.assign({}, sandbox.def, {
    name: "MMM-AmbientWeather",
    identifier: "module_1_MMM-AmbientWeather",
    config: Object.assign({ performanceProfile: "full" }, sandbox.def.defaults, configOverrides),
    file: (f) => `/modules/MMM-AmbientWeather/${f}`,
    sendSocketNotification() {},
    sendNotification() {},
    updateDom() {}
  });
  inst.start();
  inst.loaded = true;
  inst.weatherData = {
    tempf: 70,
    humidity: 50,
    uv: 5,
    winddir: 90,
    windspeedmph: 4,
    solarradiation: 500,
    hourlyrainin: 0.2,
    lightning_strike_count: 1
  };
  inst.forecast = [
    { date: "2026-10-02", high: 70, low: 50, phrase: "Sunny", cond: "clear", isDaytime: true },
    { date: "2026-10-03", high: 65, low: 48, phrase: "Rain", cond: "rain", isDaytime: true },
    { date: "2026-10-04", high: 60, low: 45, phrase: "Fog", cond: "fog", isDaytime: true }
  ];
  const tick = (ms) => {
    const end = clock.now + ms;
    for (;;) {
      let next = null;
      for (const [id, t] of clock.timers) {
        if (t.at <= end && (!next || t.at < next.t.at)) next = { id, t };
      }
      if (!next) break;
      clock.timers.delete(next.id);
      clock.now = Math.max(clock.now, next.t.at);
      next.t.fn();
    }
    clock.now = end;
  };
  return { inst, live, created, clock, tick, warnings };
}

function iconContainers(root) {
  const out = [];
  root.walk((n) => {
    if (/-anim-weather$|-uv-anim$|-forecast-anim-\d+$/.test(n.id)) out.push(n);
  });
  return out;
}

// Mimics MagicMirror updateDom: the new tree is built while the old one is attached, then swapped.
function swapIn(prev, next) {
  if (prev) prev.attached = false;
  next.attached = true;
}

test("after N re-renders live players equal icons on screen, none on detached containers", () => {
  const { inst, live, tick } = setup();
  let current = null;
  for (let i = 0; i < 8; i++) {
    const next = inst.getDom();
    tick(300); // old DOM still attached during the fade; new DOM not yet
    swapIn(current, next);
    tick(200);
    current = next;
  }
  const icons = iconContainers(current);
  assert.equal(icons.length, 5); // main + uv + 3 forecast
  assert.equal(live.size, icons.length);
  const bound = new Set();
  for (const p of live) {
    assert.ok(p.container.isConnected, "player bound to a detached container");
    assert.ok(icons.includes(p.container));
    assert.ok(!bound.has(p.container), "two players for one container");
    bound.add(p.container);
  }
});

test("players are not created before the new DOM is attached", () => {
  const { inst, live, created, tick } = setup();
  inst.getDom();
  tick(5000);
  assert.equal(created.length, 0);
  assert.equal(live.size, 0);
});

test("old players keep running during the fade and are destroyed once the swap happens", () => {
  const { inst, live, created, tick } = setup();
  const first = inst.getDom();
  swapIn(null, first);
  tick(200);
  assert.equal(live.size, 5);
  const second = inst.getDom();
  tick(300); // fade in progress: old tree still attached, icons must not blink out
  assert.equal(live.size, 5);
  assert.ok(created.every((p) => !p.container.cleared));
  swapIn(first, second);
  tick(200);
  assert.equal(live.size, 5);
  assert.equal(created.filter((p) => p.destroyed).length, 5);
  for (const p of live) assert.ok(p.container.isConnected);
});

test("when MagicMirror skips the swap the old players stay alive and nothing leaks", () => {
  const { inst, live, created, tick } = setup();
  const first = inst.getDom();
  swapIn(null, first);
  tick(200);
  for (let i = 0; i < 5; i++) {
    inst.getDom(); // new tree is never attached: MM saw identical markup and kept the old DOM
    tick(10000);
  }
  assert.equal(live.size, 5);
  assert.equal(created.length, 5);
  for (const p of live) {
    assert.ok(p.container.isConnected);
    assert.ok(!p.container.cleared, "visible icon was blanked");
  }
  // A later real swap recovers cleanly.
  const next = inst.getDom();
  swapIn(first, next);
  tick(200);
  assert.equal(live.size, 5);
  const icons = iconContainers(next);
  for (const p of live) assert.ok(icons.includes(p.container));
});

test("players left on a tree replaced by the loading/error view are reaped", () => {
  const { inst, live, tick } = setup();
  const first = inst.getDom();
  swapIn(null, first);
  tick(200);
  inst.weatherData = null;
  inst.loaded = false;
  const loading = inst.getDom();
  swapIn(first, loading);
  tick(300);
  assert.equal(live.size, 0);
});

test("pending timers from an older render do nothing", () => {
  const { inst, live, tick } = setup();
  const stale = inst.getDom(); // superseded before MagicMirror swapped it in
  tick(150);
  const fresh = inst.getDom();
  // Even if the stale tree becomes attached, its timers must not bind players to it.
  stale.attached = true;
  tick(1000);
  stale.attached = false;
  swapIn(null, fresh);
  tick(1000);
  assert.equal(live.size, 5);
  const freshIcons = iconContainers(fresh);
  for (const p of live) assert.ok(freshIcons.includes(p.container));
});

test("suspend pauses all players and stops pending timers; resume plays them", () => {
  const { inst, live, clock, tick } = setup();
  const dom = inst.getDom();
  swapIn(null, dom);
  tick(200);
  assert.equal(live.size, 5);
  inst.suspend();
  assert.ok([...live].every((p) => p.paused));
  assert.equal(clock.timers.size, 0);
  inst.resume();
  assert.ok([...live].every((p) => !p.paused));
});

test("suspend cancels a pending start timer", () => {
  const { inst, clock } = setup();
  inst.getDom();
  assert.ok(clock.timers.size >= 1);
  inst.suspend();
  assert.equal(clock.timers.size, 0);
});

test("renders while suspended create no players until resume", () => {
  const { inst, live, tick } = setup();
  inst.suspend();
  const dom = inst.getDom();
  swapIn(null, dom);
  tick(2000);
  assert.equal(live.size, 0);
  inst.resume();
  assert.equal(live.size, 5);
  assert.ok([...live].every((p) => p.container.isConnected && !p.paused));
});

test("resume after a DOM swap that happened while suspended binds to the new tree", () => {
  const { inst, live, tick } = setup();
  const a = inst.getDom();
  swapIn(null, a);
  tick(200);
  inst.suspend();
  const b = inst.getDom();
  swapIn(a, b);
  inst.resume();
  assert.equal(live.size, 5);
  const icons = iconContainers(b);
  for (const p of live) assert.ok(icons.includes(p.container));
});

test("static icon mode never creates players or timers", () => {
  const { inst, live, clock } = setup({ animateIcons: false });
  const dom = inst.getDom();
  swapIn(null, dom);
  assert.equal(live.size, 0);
  assert.equal(clock.timers.size, 0);
});

test("the start retry loop for a never-attached tree is bounded", () => {
  const { inst, clock, tick } = setup();
  inst.getDom();
  tick(60000);
  assert.equal(clock.timers.size, 0);
});

test("maxHeight defaults to null and sets --aw-max-height only when positive", () => {
  const def = setup();
  assert.equal(def.inst.config.maxHeight, null);
  assert.equal(def.inst.getDom().styleProps["--aw-max-height"], undefined);
  assert.equal(setup({ maxHeight: 0 }).inst.getDom().styleProps["--aw-max-height"], undefined);
  assert.equal(setup({ maxHeight: 400 }).inst.getDom().styleProps["--aw-max-height"], "400px");
});

test("exhausted attach retry logs a warning", () => {
  const { inst, tick, warnings } = setup();
  inst.getDom();
  tick(60000);
  assert.ok(warnings.some((w) => /Gave up waiting/.test(w)));
});

function findAll(root, cls) {
  const out = [];
  root.walk((n) => {
    if (n.className === cls) out.push(n);
  });
  return out;
}

test("forecast rows render text verbatim via textContent (no HTML injection)", () => {
  const { inst } = setup({ animateIcons: false });
  inst.forecast[0].phrase = "<b>Sunny</b> & warm";
  const dom = inst.getDom();
  const texts = findAll(dom, "forecast-text");
  assert.equal(texts.length, 3);
  assert.equal(texts[0].textContent, "<b>Sunny</b> & warm");
  assert.equal(findAll(dom, "hi")[0].textContent, "70°");
  assert.equal(findAll(dom, "lo")[0].textContent, "50°");
  const icons = findAll(dom, "forecast-icon");
  assert.equal(icons.length, 3);
  assert.equal(icons[0].children[0].className, "fa fa-sun forecast-static-icon");
  assert.equal(icons[1].children[0].className, "fa fa-cloud-rain forecast-static-icon");
  assert.equal(findAll(dom, "forecast-title")[0].textContent, "3-Day Forecast");
});

test("swap landing after the poll gives up is reaped and bound on MODULE_DOM_UPDATED", () => {
  const { inst, live, created, tick } = setup();
  const a = inst.getDom();
  swapIn(null, a);
  tick(200);
  const b = inst.getDom();
  tick(6000); // poll exhausted while the old tree is still attached
  swapIn(a, b);
  inst.notificationReceived("MODULE_DOM_UPDATED");
  assert.equal(live.size, 5);
  const icons = iconContainers(b);
  for (const p of live) {
    assert.ok(p.container.isConnected, "orphaned player on a detached container");
    assert.ok(icons.includes(p.container));
    assert.ok(!p.paused);
  }
  assert.equal(created.filter((p) => p.destroyed).length, 5);
});

test("resume plays previous-render players left on screen by a dropped swap", () => {
  const { inst, live, tick, warnings } = setup();
  const a = inst.getDom();
  swapIn(null, a);
  tick(200);
  inst.getDom(); // swap dropped (MMM-AmbientWeather hidden within the fade)
  tick(200);
  inst.suspend();
  assert.ok([...live].every((p) => p.paused));
  inst.resume();
  assert.equal(live.size, 5);
  assert.ok([...live].every((p) => !p.paused));
  tick(10000);
  assert.ok(!warnings.some((w) => /Gave up waiting/.test(w)), "spurious warning for a benign skipped swap");
});

test("a render during the show fade (resume() dropped by MM) still binds players once visible", () => {
  const { inst, live, tick } = setup();
  const a = inst.getDom();
  swapIn(null, a);
  tick(200);
  inst.suspend();
  inst.hidden = false; // MM started showing the module; its resume() call was then dropped
  const b = inst.getDom();
  swapIn(a, b);
  inst.notificationReceived("MODULE_DOM_UPDATED");
  tick(200);
  assert.equal(live.size, 5);
  assert.ok([...live].every((p) => p.container.isConnected && !p.paused));
});

test("hidden module stays suspended: no players are created while MM reports hidden", () => {
  const { inst, live, tick } = setup();
  inst.suspend();
  inst.hidden = true;
  const dom = inst.getDom();
  swapIn(null, dom);
  inst.notificationReceived("MODULE_DOM_UPDATED");
  tick(2000);
  assert.equal(live.size, 0);
});
