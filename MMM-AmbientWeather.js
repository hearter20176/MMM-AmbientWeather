/* MMM-AmbientWeather.js
 * Animated 3D Lottie weather icons + liquid glass card
 * Humidity, wind, rain, lightning, UV + realtime Ambient data
 */
/* global lottie */

Module.register("MMM-AmbientWeather", {
  defaults: {
    debug: false, // log every realtime payload from the Ambient API
    title: "Home Weather",
    units: "imperial",
    offlineThreshold: 5 * 60 * 1000,
    animateIcons: true,
    performanceProfile: "auto", // auto | pi | full
    reduceMotion: false,
    minWidth: 260,
    maxHeight: null, // optional card height cap in px; null sizes the card to its content
    showSunTimes: true,
    showUV: true,
    showBarometer: true,
    pressureTrendThreshold: 0.01, // inHg delta to flag rising/falling
    showNwsForecast: true,
    forecastDays: 3,
    forecastCacheMinutes: 90,
    animations: {
      clear: { day: "clear_isDay.json", night: "clear_night.json" },
      partly_cloudy: {
        day: "partly-cloudy_isDay.json",
        night: "partly-cloudy-night.json"
      },
      cloud: { day: "overcast_isDay.json", night: "overcast-night.json" },
      rain: {
        day: "overcast-rain_isDay.json",
        night: "overcast-night-rain.json"
      },
      thunderstorm: {
        day: "thunderstorms-rain_isDay.json",
        night: "thunderstorms-night-rain.json"
      },
      fog: { day: "fog_isDay.json", night: "fog-night.json" },
      snow: {
        day: "overcast-snow_isDay.json",
        night: "overcast-night-snow.json"
      },
      sleet: {
        day: "overcast-sleet_isDay.json",
        night: "overcast-night-sleet.json"
      },
      freezing_rain: {
        // No dedicated freezing-rain animation ships in animations/; reuse the sleet icons,
        // which is the closest existing condition.
        day: "overcast-sleet_isDay.json",
        night: "overcast-night-sleet.json"
      },
      default: {
        day: "clear_isDay.json",
        night: "clear_night.json"
      }
    }
  },

  getScripts() {
    if (this._shouldUseLottie()) {
      return [this.file("vendor/lottie.min.js")];
    }
    return [];
  },

  getStyles() {
    return [this.file("MMM-AmbientWeather.css"), "font-awesome.css"];
  },

  start() {
    Log.info(`[${this.name}] Starting module`);
    this.loaded = false;
    this.weatherData = null;
    this.error = null;
    this.lastUpdate = null;
    this.offline = false;
    this.isDomReady = false;
    this.lottieInstances = []; // every live Lottie player this module owns
    this.pendingAnims = []; // containers from the latest getDom() awaiting a player
    this.renderGen = 0; // bumped on every getDom(); invalidates timers from older renders
    this.animTimer = null;
    this.suspended = false;
    this.lastPressure = null;
    this.pressureTrend = null;
    this.forecast = [];
    this.tonight = null;
    this.lastForecastFetch = 0;
    this.performanceProfile = this._resolvePerformanceProfile();
    this.reduceMotion =
      this.config.reduceMotion === true ||
      this.performanceProfile === "pi" ||
      (typeof window !== "undefined" &&
        window.matchMedia &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    this.enableLottie = this.config.animateIcons && !this.reduceMotion;

    this.sendSocketNotification("CONNECT_AMBIENT", {
      apiKey: this.config.apiKey,
      applicationKey: this.config.applicationKey,
      macAddress: this.config.macAddress,
      latitude: this.config.latitude,
      longitude: this.config.longitude,
      forecastCacheMinutes: this.config.forecastCacheMinutes,
      debug: this.config.debug
    });

    this.offlineTimer = setInterval(() => this._checkOffline(), 15000);
    this.forecastTimer = setInterval(
      () => this._maybeRequestForecast(),
      30 * 60 * 1000
    );
    this._maybeRequestForecast();
  },

  // System notification, fired once MagicMirror has attached this module's DOM node - the
  // correct signal to start calling updateDom(), rather than guessing with a fixed timeout.
  notificationReceived(notification) {
    if (notification === "DOM_OBJECTS_CREATED") {
      this.isDomReady = true;
      if (this.loaded || this.error) this.safeUpdateDom(0);
    }
    // MagicMirror sends this to the module after every updateDom() resolves (swapped or skipped),
    // so it is the deterministic moment to reap the outgoing tree and bind the new containers.
    // The bounded poll in _startAnimations() is only a fallback.
    if (notification === "MODULE_DOM_UPDATED") this._startAnimations();
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "AMBIENT_DATA") {
      const data = payload && payload.lastData ? payload.lastData : payload;
      if (this.config.debug) Log.log(`[${this.name}] Ambient realtime data:`, data);
      const pressure = this._extractPressure(data);
      if (pressure) this._updatePressureTrend(pressure.rawInHg);
      this.weatherData = data;
      this.error = null;
      this.lastUpdate = Date.now();
      this.loaded = true;
      this.offline = false;
      this._broadcastCurrentConditions(data);
      this.safeUpdateDom(500);
      this._maybeRequestForecast();
    }

    if (notification === "AMBIENT_ERROR") {
      this.error = payload;
      Log.error(`[${this.name}] ${payload?.code || "ERROR"}: ${payload?.message || "unknown error"}`);
      this.safeUpdateDom(0);
    }

    if (notification === "NWS_FORECAST") {
      if (payload && Array.isArray(payload.forecast)) {
        this.forecast = payload.forecast;
      }
      if (payload && payload.tonight !== undefined) {
        // Distinct from forecast[0], which is the next/current *daytime* period - this is used as
        // the night fallback in _currentCondition instead.
        this.tonight = payload.tonight;
      }
      if (payload && payload.error) {
        // Retry sooner than the full cache window instead of waiting out forecastCacheMinutes.
        const cacheMs = (this.config.forecastCacheMinutes || 90) * 60 * 1000;
        this.lastForecastFetch = Date.now() - cacheMs + 5 * 60 * 1000;
      }
      this.safeUpdateDom(0);
    }
  },

  _checkOffline() {
    if (!this.lastUpdate) return;
    const age = Date.now() - this.lastUpdate;
    const wasOffline = this.offline;
    this.offline = age > this.config.offlineThreshold;
    if (this.offline !== wasOffline && this.isDomReady) this.safeUpdateDom(0);
  },

  safeUpdateDom(speed = 1000) {
    if (this.isDomReady) this.updateDom(speed);
    else setTimeout(() => this.safeUpdateDom(speed), 700);
  },

  _formatTimeIso(iso) {
    if (!iso) return "N/A";
    const d = new Date(iso);
    if (isNaN(d)) return "N/A";
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  },

  _esc(s) {
    const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return `${s}`.replace(/[&<>"']/g, (c) => entities[c]);
  },

  _errorMessage(err) {
    const code = err?.code;
    if (code === "CONFIG") return "Ambient Weather: apiKey/applicationKey missing from config.";
    if (code === "CONNECT") return "Ambient Weather: unable to connect to the realtime service.";
    if (code === "NO_DATA") return "Ambient Weather: no data received. Check the macAddress config value.";
    if (code === "AUTH") return "Ambient Weather: API key returned no devices. Check apiKey/applicationKey.";
    return `Ambient Weather error: ${err?.message || "unknown error"}`;
  },

  _uvGradient(uv) {
    const clamped = Math.min(11, Math.max(0, uv));
    const ratio = clamped / 11;
    const r = Math.round(0 + (255 - 0) * ratio);
    const g = Math.round(228 - 228 * ratio);
    return `linear-gradient(90deg, #16a34a 0%, rgb(${r},${g},0) 100%)`;
  },

  _windDirText(deg) {
    const dirs = [
      "N",
      "NNE",
      "NE",
      "ENE",
      "E",
      "ESE",
      "SE",
      "SSE",
      "S",
      "SSW",
      "SW",
      "WSW",
      "W",
      "WNW",
      "NW",
      "NNW"
    ];
    const ix = Math.round(deg / 22.5) % 16;
    return dirs[ix];
  },

  // Converts a Fahrenheit reading to the configured display unit.
  _temp(f) {
    if (typeof f !== "number") return null;
    return this.config.units === "metric" ? ((f - 32) * 5) / 9 : f;
  },

  // Converts an mph reading to the configured display unit.
  _windSpeed(mph) {
    if (typeof mph !== "number") return null;
    return this.config.units === "metric" ? mph * 1.609344 : mph;
  },

  _windUnit() {
    return this.config.units === "metric" ? "km/h" : "mph";
  },

  // Station-measured signals (rain/snow/fog) that are meaningful at any time of day and must win
  // over any forecast- or solar-based guess - e.g. it should never show "clear" while the gauge
  // is actively measuring rain. Returns null when nothing measured is conclusive.
  _measuredCondition(d) {
    if (!d) return null;
    const r = d.hourlyrainin || 0;
    const s = d.solarradiation || 0;
    const u = d.uv || 0;
    const h = d.humidity || 0;
    const t = d.tempf || 0;
    const dew = d.dewPoint ?? d.dewpoint ?? d.dewpointf;
    const dewDiff = typeof dew === "number" ? Math.abs(t - dew) : null;

    if (r > 0.1) return "rain";
    if (t < 32 && h > 80 && r > 0) return "snow";
    if (s === 0 && u === 0 && h > 98 && dewDiff !== null && dewDiff < 2) return "fog";
    return null;
  },

  // Fallback heuristic once measured signals are inconclusive. Solar radiation is only a
  // meaningful signal during the day - at night it's always ~0, so this uses humidity as a rough
  // cloud/clear proxy instead of defaulting to "cloud" for every single night.
  _heuristicCondition(d) {
    const isDay = this._isDay(d);
    const s = d?.solarradiation || 0;
    const u = d?.uv || 0;
    const h = d?.humidity || 0;

    if (isDay) {
      if (s > 200 && u > 1) return "clear";
      if (s > 100 && h < 80) return "partly_cloudy";
      return "cloud";
    }

    return h > 90 ? "cloud" : "clear";
  },

  _currentCondition(d) {
    if (!d) return "partly_cloudy";

    // Station-measured precipitation/fog wins first, at any time of day - it must not be
    // overridden by a "clear" forecast or solar reading.
    const measured = this._measuredCondition(d);
    if (measured) return measured;

    // Ambient realtime packets carry no weather/condition field, so at night (no solar signal)
    // prefer tonight's NWS condition - the current/next night-time forecast period, NOT
    // forecast[0] (which is the next *daytime* period, i.e. usually tomorrow).
    if (!this._isDay(d) && this.tonight && this.tonight.cond) {
      return this.tonight.cond;
    }

    return this._heuristicCondition(d);
  },

  // Static (non-Lottie) icon class for a condition - used whenever enableLottie is false, e.g.
  // on the Pi's default performance profile.
  _staticIconClass(cond, isDay) {
    const map = {
      clear: isDay ? "fa-sun" : "fa-moon",
      partly_cloudy: isDay ? "fa-cloud-sun" : "fa-cloud-moon",
      cloud: "fa-cloud",
      rain: "fa-cloud-rain",
      thunderstorm: "fa-bolt",
      snow: "fa-snowflake",
      fog: "fa-smog",
      sleet: "fa-cloud-meatball",
      freezing_rain: "fa-cloud-meatball"
    };
    return map[cond] || (isDay ? "fa-cloud-sun" : "fa-cloud-moon");
  },

  _extractPressure(d) {
    const rel = d?.baromrelin ?? d?.baromabsin;
    if (rel === undefined || rel === null) return null;
    const isMetric = this.config.units === "metric";
    const value = isMetric ? rel * 33.8639 : rel;
    const unit = isMetric ? "hPa" : "inHg";
    return { value, unit, rawInHg: rel };
  },

  _updatePressureTrend(currentRawInHg) {
    if (currentRawInHg === undefined || currentRawInHg === null) return;
    const prev = this.lastPressure;
    if (prev?.value !== undefined && prev?.value !== null) {
      const delta = currentRawInHg - prev.value;
      const threshold = this.config.pressureTrendThreshold || 0.01; // inHg
      let trend = "steady";
      if (delta > threshold) trend = "rising";
      else if (delta < -threshold) trend = "falling";
      this.pressureTrend = { trend, delta };
    }
    this.lastPressure = { value: currentRawInHg, ts: Date.now() };
  },

  _isDay(d) {
    if (!d || !d.sunrise || !d.sunset) return true;
    const now = new Date();
    return now >= new Date(d.sunrise) && now <= new Date(d.sunset);
  },

  _broadcastCurrentConditions(data) {
    if (!data) return;
    const tempF = typeof data.tempf === "number" ? data.tempf : null;
    const temperature = tempF !== null ? this._temp(tempF) : null;
    const condKey = this._currentCondition(data) || "partly_cloudy";
    const conditionRaw =
      data.weather || data.conditions || data.icon || condKey || "";
    const condition = `${conditionRaw}`.replace(/[_]+/g, " ").trim();
    const isDaytime = this._isDay(data);
    const payload = {
      temperature,
      condition,
      conditionCode: data.weatherCode ?? data.iconCode ?? undefined,
      aqi: data.aqi,
      uv: data.uv,
      sunrise: data.sunrise,
      sunset: data.sunset,
      isDaytime,
      lottie: this.enableLottie
        ? this._resolveAnimationFile(condKey, isDaytime)
        : null
    };

    this.sendNotification("AMBIENT_WEATHER_DATA", payload);
  },

  _resolveAnimationFile(cond, isDay) {
    const animations = this.config.animations || {};
    const preferred = animations[cond] ||
      animations.default || {
        day: "partly-cloudy-day.json",
        night: "partly-cloudy-night.json"
      };
    const pickVariant = (entry) => {
      if (!entry) return null;
      if (typeof entry === "string") return entry;
      if (typeof entry === "object") {
        const variant = isDay ? entry.day : entry.night;
        return variant || entry.day || entry.night || null;
      }
      return null;
    };

    let candidate = pickVariant(preferred) || pickVariant(animations.default);
    const hasDayMarker =
      candidate &&
      (/_isDay\.json$/i.test(candidate) || /-day\.json$/i.test(candidate));
    const hasNightMarker = candidate && /night/i.test(candidate);

    if (isDay) {
      if (!candidate) candidate = `${cond}_isDay.json`;
      else if (!hasDayMarker && !hasNightMarker)
        candidate = candidate.replace(/\.json$/i, "_isDay.json");
      else if (hasNightMarker)
        candidate = candidate
          .replace(/night/i, "day")
          .replace(/\.json$/i, "_isDay.json");
    } else {
      if (!candidate) candidate = `${cond}-night.json`;
      else if (!hasNightMarker) {
        if (
          /-day\.json$/i.test(candidate) ||
          /_isDay\.json$/i.test(candidate)
        ) {
          candidate = candidate
            .replace(/-day\.json$/i, "-night.json")
            .replace(/_isDay\.json$/i, "-night.json");
        } else {
          candidate = candidate.replace(/\.json$/i, "-night.json");
        }
      }
    }

    if (!candidate)
      return isDay ? "partly-cloudy-day.json" : "partly-cloudy-night.json";
    return candidate;
  },

  _maybeRequestForecast() {
    if (
      !this.config.showNwsForecast ||
      !this.config.latitude ||
      !this.config.longitude
    )
      return;
    const cacheMs = (this.config.forecastCacheMinutes || 90) * 60 * 1000;
    const now = Date.now();
    if (this.lastForecastFetch && now - this.lastForecastFetch < cacheMs)
      return;
    this.lastForecastFetch = now;
    this.sendSocketNotification("REQUEST_FORECAST", {
      lat: this.config.latitude,
      lon: this.config.longitude,
      days: this.config.forecastDays || 3,
      metric: this.config.units === "metric"
    });
  },

  // ---- Lottie lifecycle -------------------------------------------------------------------
  //
  // getDom() builds a brand-new DOM tree on every render while MagicMirror keeps the previous
  // tree attached for the fade-out, and MagicMirror may even skip the swap entirely when the new
  // markup equals the old. So containers are never looked up by id, and players from the previous
  // render are NOT destroyed in getDom(): they keep running on the visible tree until their
  // container is actually detached, at which point _startAnimations() reaps them. Each render
  // registers the exact container elements it created (this.pendingAnims); a player is created
  // only once such a container is connected. renderGen invalidates timers from older renders.
  // this.lottieInstances holds { player, container } for every live player.

  _clearAnimTimer() {
    if (this.animTimer) {
      clearTimeout(this.animTimer);
      this.animTimer = null;
    }
  },

  _destroyPlayer(entry) {
    try {
      entry.player.destroy();
    } catch (err) {
      Log.warn(`[${this.name}] Failed to destroy lottie player:`, err);
    }
  },

  // Destroys players whose container is no longer in the document (the swapped-out tree).
  _reapDetachedAnimations() {
    this.lottieInstances = (this.lottieInstances || []).filter((entry) => {
      if (entry.container.isConnected) return true;
      this._destroyPlayer(entry);
      return false;
    });
  },

  // Starts a new render generation: drops the previous registrations and timer. Live players are
  // left alone (see above).
  _beginRender() {
    this.renderGen = (this.renderGen || 0) + 1;
    this._clearAnimTimer();
    this.pendingAnims = [];
  },

  // Registers a container created by the current getDom() pass; the player starts later.
  _registerAnimation(container, animationFile) {
    if (!this.enableLottie || !animationFile || !container) return;
    this.pendingAnims.push({ container, file: animationFile, player: null });
  },

  // Creates players for registered containers that are now attached to the document and reaps
  // players on detached containers. Items whose container is not attached yet (new DOM still
  // waiting for the old DOM to fade out) are retried on a short timer, bounded by `attempts`.
  // Players are only created/resumed while the module is not suspended.
  _startAnimations(attempts = 50) {
    this._clearAnimTimer();
    if (!this.enableLottie) return;
    this._reapDetachedAnimations();
    // MM sets hidden=false when a show starts but calls resume() only when its fade ends; a
    // data render inside that window clears MM's shared timer and resume() never comes. A
    // module that MM reports visible is not suspended.
    if (this.suspended && this.hidden === false) this.suspended = false;
    if (this.suspended) return;
    const gen = this.renderGen;
    let waiting = false;
    this.pendingAnims.forEach((item) => {
      if (item.player) return;
      if (!item.container.isConnected) {
        waiting = true;
        return;
      }
      let player;
      try {
        player = lottie.loadAnimation({
          container: item.container,
          renderer: "svg",
          loop: true,
          autoplay: true,
          path: this.file(`animations/${item.file}`)
        });
      } catch (err) {
        Log.warn(`[${this.name}] Failed to start lottie animation ${item.file}:`, err);
        item.player = { destroy() {}, play() {}, pause() {} }; // do not retry a failing file
        return;
      }
      item.player = player;
      this.lottieInstances.push({ player, container: item.container });
    });
    // Every surviving player is on a connected container (detached ones were reaped above), so
    // play all of them, including previous-render players left on screen by a skipped/dropped
    // swap while the module was suspended.
    this.lottieInstances.forEach((entry) => {
      if (typeof entry.player.play === "function") entry.player.play();
    });
    // Players from a previous render that is still attached are reaped once it is swapped out.
    const staleLeft = this.lottieInstances.some(
      (entry) => !this.pendingAnims.some((item) => item.player === entry.player)
    );
    if ((waiting || staleLeft) && attempts > 0) {
      this.animTimer = setTimeout(() => {
        this.animTimer = null;
        if (gen !== this.renderGen) return;
        this._startAnimations(attempts - 1);
      }, 100);
    } else if (waiting && !this.lottieInstances.length) {
      // Not a failure while the previous tree is still live with players (swap skipped/dropped).
      Log.warn(`[${this.name}] Gave up waiting for weather icon containers to attach`);
    }
  },

  _pauseAnimations() {
    this._clearAnimTimer();
    (this.lottieInstances || []).forEach((entry) => {
      if (typeof entry.player.pause === "function") entry.player.pause();
    });
  },

  // Called by MagicMirror when the module is hidden (e.g. MMM-pages rotation).
  suspend() {
    this.suspended = true;
    this._pauseAnimations();
  },

  resume() {
    this.suspended = false;
    this._startAnimations();
  },

  _uvAnimationFile(uvValue) {
    if (uvValue === undefined || uvValue === null) return null;
    const level = Math.min(11, Math.max(1, Math.round(uvValue)));
    return `uv-index-${level}.json`;
  },

  _resolvePerformanceProfile() {
    const requested = (this.config.performanceProfile || "auto").toLowerCase();
    if (requested === "pi" || requested === "full") return requested;
    const ua =
      typeof navigator !== "undefined" && navigator.userAgent ? navigator.userAgent : "";
    const isPi =
      ua.includes("raspberry") ||
      ua.includes("armv7") ||
      ua.includes("aarch64") ||
      ua.includes("linux arm");
    return isPi ? "pi" : "full";
  },

  _shouldUseLottie() {
    const profile = (this.config.performanceProfile || "auto").toLowerCase();
    const forceReduce =
      this.config.reduceMotion === true ||
      profile === "pi" ||
      (typeof window !== "undefined" &&
        window.matchMedia &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    return this.config.animateIcons && !forceReduce;
  },

  getDom() {
    // New render generation; old players stay alive until their (visible) tree is swapped out.
    this._beginRender();

    const wrapper = document.createElement("div");
    wrapper.className = "MMM-AmbientWeather glass-card raised-edge";
    wrapper.style.minWidth = `${this.config.minWidth}px`;
    if (Number(this.config.maxHeight) > 0) {
      wrapper.style.setProperty("--aw-max-height", `${Number(this.config.maxHeight)}px`);
    }
    if (this.offline) wrapper.classList.add("offline");

    if (this.config.title) {
      const titleEl = document.createElement("div");
      titleEl.className = "aw-title";
      titleEl.textContent = this.config.title;
      wrapper.appendChild(titleEl);
    }

    // An error takes priority over the loading spinner - otherwise a bad key or MAC address
    // leaves the card stuck on "Loading..." forever.
    if (this.error && !this.weatherData) {
      const errDiv = document.createElement("div");
      errDiv.className = "aw-error";
      const icon = document.createElement("i");
      icon.className = "fa fa-triangle-exclamation";
      const msg = document.createElement("div");
      msg.className = "aw-error-text";
      msg.textContent = this._errorMessage(this.error);
      errDiv.appendChild(icon);
      errDiv.appendChild(msg);
      wrapper.appendChild(errDiv);
      this._startAnimations(); // reaps players left on the outgoing tree
      return wrapper;
    }

    if (!this.loaded || !this.weatherData) {
      const loading = document.createElement("div");
      loading.className = "loading";
      const spinner = document.createElement("div");
      spinner.className = "spinner";
      const text = document.createElement("div");
      text.className = "loading-text";
      text.textContent = "Loading Ambient Weather data…";
      loading.appendChild(spinner);
      loading.appendChild(text);
      wrapper.appendChild(loading);
      this._startAnimations();
      return wrapper;
    }

    const d = this.weatherData;
    const tempUnit = this.config.units === "metric" ? "C" : "F";
    const feelsSourceF = d.feelsLike ?? d.feelslike;
    const feelsConverted = this._temp(feelsSourceF);
    const feels = feelsConverted !== null
      ? `${feelsConverted.toFixed(1)}&deg;${tempUnit}`
      : "-";
    const pressure = this._extractPressure(d);
    const trend = this.pressureTrend?.trend;
    const trendIcon =
      trend === "rising"
        ? "fa-arrow-up"
        : trend === "falling"
          ? "fa-arrow-down"
          : trend === "steady"
            ? "fa-arrows-h"
            : null;
    const trendText = trend
      ? ` (${trend.charAt(0).toUpperCase()}${trend.slice(1)})`
      : "";

    const cond = this._currentCondition(d);
    const isDay = this._isDay(d);

    // Main weather section
    const main = document.createElement("div");
    main.className = "main-content";

    // Left: Animation
    const left = document.createElement("div");
    left.className = "main-left";
    const animDiv = document.createElement("div");
    animDiv.id = `${this.identifier}-anim-weather`;
    animDiv.className = "anim-container";
    left.appendChild(animDiv);
    if (!this.enableLottie) {
      const icon = document.createElement("i");
      icon.className = `fa ${this._staticIconClass(cond, isDay)} static-icon`;
      animDiv.appendChild(icon);
    }

    // UV under main icon
    if (this.config.showUV && d.uv !== undefined) {
      const uvRow = document.createElement("div");
      uvRow.className = "uv-row";
      const uvLabel = document.createElement("span");
      uvLabel.className = "uv-label";
      uvLabel.textContent = "UV Index:";
      const uvIcon = document.createElement("div");
      uvIcon.id = `${this.identifier}-uv-anim`;
      uvIcon.className = "uv-icon";
      uvRow.appendChild(uvLabel);
      uvRow.appendChild(uvIcon);
      left.appendChild(uvRow);

      if (this.enableLottie) {
        const uvFile = this._uvAnimationFile(d.uv);
        if (uvFile) {
          this._registerAnimation(uvIcon, uvFile);
        }
      } else {
        // No Lottie: fall back to a plain numeric UV value instead of an empty icon box.
        uvIcon.classList.add("uv-static");
        uvIcon.textContent = Number(d.uv).toFixed(0);
      }
    }
    main.appendChild(left);

    // Right: temperature + extras
    const right = document.createElement("div");
    right.className = "main-right";
    const tempRow = document.createElement("div");
    tempRow.className = "temp-row";
    const tempConverted = this._temp(d.tempf);
    tempRow.innerHTML = `
      <div class="temp-value">${tempConverted !== null ? tempConverted.toFixed(1) : "-"}&deg;${tempUnit}</div>
      <div class="temp-feels">Feels like ${feels}</div>`;
    right.appendChild(tempRow);

    // Humidity & Wind
    const metrics = document.createElement("div");
    metrics.className = "metrics";
    const windConverted = this._windSpeed(d.windspeedmph);
    metrics.innerHTML = `
      <div class="metric-item"><i class="fa fa-tint"></i> Humidity: ${this._esc(d.humidity ?? "-")}%</div>
      <div class="metric-item">
        <span class="vane" style="transform: rotate(${Number(d.winddir) || 0}deg)">
          <i class="fa fa-location-arrow"></i>
        </span>
        Wind: ${this._esc(windConverted !== null ? windConverted.toFixed(1) : "-")} ${this._windUnit()} (${this._esc(this._windDirText(d.winddir || 0))})
      </div>`;
    const indoorTempF = d.tempinf;
    const indoorHum = d.humidityin;
    if (indoorTempF !== undefined || indoorHum !== undefined) {
      const indoorConverted = this._temp(indoorTempF);
      const indoorTemp = indoorConverted !== null ? indoorConverted.toFixed(1) : "-";
      const indoorItem = document.createElement("div");
      indoorItem.className = "metric-item";
      indoorItem.innerHTML = `<i class="fa fa-home"></i> Inside: ${this._esc(indoorTemp)}${tempUnit}${indoorHum !== undefined ? `, ${this._esc(indoorHum)}%` : ""}`;
      metrics.appendChild(indoorItem);
    }
    if (this.config.showBarometer && pressure) {
      const pr = document.createElement("div");
      pr.className = "metric-item";
      const iconHtml = trendIcon ? `<i class="fa ${trendIcon}"></i> ` : "";
      pr.innerHTML = `${iconHtml}Pressure: ${this._esc(pressure.value.toFixed(2))} ${this._esc(pressure.unit)}${this._esc(trendText)}`;
      metrics.appendChild(pr);
    }
    right.appendChild(metrics);

    // Sunrise / Sunset
    if (this.config.showSunTimes) {
      const sr = this._formatTimeIso(d.sunrise);
      const ss = this._formatTimeIso(d.sunset);
      const sunRow = document.createElement("div");
      sunRow.className = "sun-row";
      sunRow.innerHTML = `
        <div class="sun-item"><i class="fa fa-sun"></i> ${sr}</div>
        <div class="sun-item"><i class="fa fa-moon"></i> ${ss}</div>`;
      right.appendChild(sunRow);
    }

    main.appendChild(right);
    wrapper.appendChild(main);

    // Rain + Lightning Alerts
    const alerts = document.createElement("div");
    alerts.className = "weather-alerts";
    if (d.hourlyrainin > 0) {
      const rain = document.createElement("div");
      rain.className = "alert-badge alert-rain";
      rain.textContent = "RAIN DETECTED";
      alerts.appendChild(rain);
    }
    if (d.lightning_strike_count || d.lightning_time) {
      const lightning = document.createElement("div");
      lightning.className = "alert-badge alert-lightning";
      lightning.textContent = "LIGHTNING ACTIVITY";
      alerts.appendChild(lightning);
    }
    wrapper.appendChild(alerts);

    // Weather.gov forecast
    const forecastLimit = this.config.forecastDays || 3;
    const forecastItems = (this.forecast || []).slice(0, forecastLimit);
    if (this.config.showNwsForecast && forecastItems.length) {
      const fc = document.createElement("div");
      fc.className = "forecast";
      const fcTitle = document.createElement("div");
      fcTitle.className = "forecast-title";
      fcTitle.textContent = `${forecastLimit}-Day Forecast`;
      const grid = document.createElement("div");
      grid.className = "forecast-grid";
      forecastItems.forEach((day, idx) => {
        const dayName = day?.date
          ? new Date(day.date).toLocaleDateString([], { weekday: "short" })
          : "";
        const hi =
          typeof day?.high === "number" ? day.high.toFixed(0) : "-";
        const lo =
          typeof day?.low === "number" ? day.low.toFixed(0) : "-";
        const phrase = day?.phrase || "";
        // node_helper already derives `cond` from the NWS phrase for every forecast item.
        const dayCond = day?.cond || "partly_cloudy";
        const dayIsDay = day?.isDaytime !== false;

        const dayEl = document.createElement("div");
        dayEl.className = "forecast-day";
        const nameEl = document.createElement("div");
        nameEl.className = "forecast-name";
        nameEl.textContent = dayName;
        const tempsEl = document.createElement("div");
        tempsEl.className = "forecast-temps";
        const hiEl = document.createElement("span");
        hiEl.className = "hi";
        hiEl.textContent = `${hi}°`;
        const loEl = document.createElement("span");
        loEl.className = "lo";
        loEl.textContent = `${lo}°`;
        tempsEl.appendChild(hiEl);
        tempsEl.appendChild(loEl);
        const iconEl = document.createElement("div");
        iconEl.className = "forecast-icon";
        iconEl.id = `${this.identifier}-forecast-anim-${idx}`;
        if (this.enableLottie) {
          this._registerAnimation(iconEl, this._resolveAnimationFile(dayCond, dayIsDay));
        } else {
          const staticIcon = document.createElement("i");
          staticIcon.className = `fa ${this._staticIconClass(dayCond, dayIsDay)} forecast-static-icon`;
          iconEl.appendChild(staticIcon);
        }
        const textEl = document.createElement("div");
        textEl.className = "forecast-text";
        textEl.textContent = phrase;
        dayEl.appendChild(nameEl);
        dayEl.appendChild(tempsEl);
        dayEl.appendChild(iconEl);
        dayEl.appendChild(textEl);
        grid.appendChild(dayEl);
      });
      fc.appendChild(fcTitle);
      fc.appendChild(grid);
      wrapper.appendChild(fc);
    }

    // Footer (offline/last update)
    const footer = document.createElement("div");
    footer.className = "footer";
    const last = this.lastUpdate
      ? new Date(this.lastUpdate).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit"
        })
      : "—";
    footer.innerHTML = this.offline
      ? `<span class="offline-text"><i class="fa fa-triangle-exclamation"></i> Offline — last update: ${last}</span>`
      : `<span>Updated: ${last}</span>`;
    wrapper.appendChild(footer);

    // Main weather icon: bound to the exact container created above, not looked up by id.
    if (this.enableLottie) {
      const animFile =
        this._resolveAnimationFile(cond, isDay) ||
        this.config.animations?.default?.[isDay ? "day" : "night"];
      this._registerAnimation(animDiv, animFile);
      // Players start once MagicMirror has attached this tree (container.isConnected).
      this._startAnimations();
    }

    return wrapper;
  }
});
