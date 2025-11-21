/* MMM-AmbientWeather.js
 * Animated 3D Lottie weather icons + liquid glass card
 * Humidity, wind, rain, lightning, UV + realtime Ambient data
 */

Module.register("MMM-AmbientWeather", {
  defaults: {
    title: "Home Weather",
    units: "imperial",
    updateInterval: 30 * 1000,
    offlineThreshold: 5 * 60 * 1000,
    animateIcons: true,
    minWidth: 260,
    showSunTimes: true,
    showUV: true,
    showBarometer: true,
    pressureTrendThreshold: 0.01, // inHg delta to flag rising/falling
    showNwsForecast: true,
    forecastDays: 3,
    forecastCacheMinutes: 90,
    animations: {
      clear: { day: "clear_isDay.json", night: "clear-night.json" },
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
        day: "freezing_rain.json",
        night: "overcast-night-sleet.json"
      },
      default: {
        day: "clear_isDay.json",
        night: "clear_night.json"
      }
    }
  },

  getScripts() {
    return [this.file("vendor/lottie.min.js")];
  },

  getStyles() {
    return [this.file("MMM-AmbientWeather.css"), "font-awesome.css"];
  },

  start() {
    Log.info(`[${this.name}] Starting module`);
    this.loaded = false;
    this.weatherData = null;
    this.lastUpdate = null;
    this.offline = false;
    this.isDomReady = false;
    this.lottieInstances = {};
    this.lastPressure = null;
    this.pressureTrend = null;
    this.forecast = [];
    this.lastForecastFetch = 0;
    this.latestForecastRenderKey = null;
    this.forecastAnimQueue = [];

    this.sendSocketNotification("CONNECT_AMBIENT", {
      apiKey: this.config.apiKey,
      applicationKey: this.config.applicationKey,
      macAddress: this.config.macAddress,
      latitude: this.config.latitude,
      longitude: this.config.longitude,
      forecastCacheMinutes: this.config.forecastCacheMinutes
    });

    setTimeout(() => {
      this.isDomReady = true;
      if (this.loaded) this.safeUpdateDom(0);
    }, 800);

    this.offlineTimer = setInterval(() => this._checkOffline(), 15000);
    this.forecastTimer = setInterval(
      () => this._maybeRequestForecast(),
      30 * 60 * 1000
    );
    this._maybeRequestForecast();
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "AMBIENT_DATA") {
      const data = payload && payload.lastData ? payload.lastData : payload;
      console.log(`[${this.name}] Ambient realtime data:`, data);
      const pressure = this._extractPressure(data);
      if (pressure) this._updatePressureTrend(pressure.rawInHg);
      this.weatherData = data;
      this.lastUpdate = Date.now();
      this.loaded = true;
      this.offline = false;
      this.safeUpdateDom(500);
      this._maybeRequestForecast();
    }

    if (notification === "NWS_FORECAST") {
      if (payload && Array.isArray(payload.forecast)) {
        this.forecast = payload.forecast;
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

  _detectCondition(d) {
    if (!d) return "partly_cloudy";
    const r = d.hourlyrainin || 0;
    const s = d.solarradiation || 0;
    const u = d.uv || 0;
    const h = d.humidity || 0;
    const t = d.tempf || 0;
    const dew = d.dewPoint ?? d.dewpoint ?? d.dewpointf;
    const dewDiff = typeof dew === "number" ? Math.abs(t - dew) : null;

    if (r > 0.1) return "rain";
    if (d.windgustmph > 25) return "thunderstorm";
    if (t < 32 && h > 80 && r > 0) return "snow";
    if (s === 0 && u === 0 && h > 98 && dewDiff !== null && dewDiff < 2)
      return "fog";
    if (s > 200 && u > 1) return "clear";
    if (s > 100 && h < 80) return "partly_cloudy";
    return "cloud";
  },

  _conditionFromText(txt) {
    if (!txt) return null;
    const t = `${txt}`.toLowerCase();
    if (t.includes("thunder")) return "thunderstorm";
    if (t.includes("sleet")) return "sleet";
    if (t.includes("freezing")) return "freezing_rain";
    if (t.includes("snow")) return "snow";
    if (t.includes("hail")) return "sleet";
    if (t.includes("rain") || t.includes("drizzle") || t.includes("shower"))
      return "rain";
    if (t.includes("fog") || t.includes("mist")) return "fog";
    if (t.includes("haze") || t.includes("smoke")) return "fog";
    if (t.includes("overcast")) return "cloud";
    if (t.includes("cloud")) return "partly_cloudy";
    if (t.includes("clear") || t.includes("sun") || t.includes("fair"))
      return "clear";
    return null;
  },

  _currentCondition(d) {
    const fromIcon = this._conditionFromText(
      d?.icon || d?.weather || d?.conditions
    );
    return fromIcon || this._detectCondition(d);
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

  _playAnimationFor(elementId, animationFile) {
    const el = document.getElementById(elementId);
    if (!el) return;
    const path = this.file(`animations/${animationFile}`);
    if (this.lottieInstances[elementId])
      this.lottieInstances[elementId].destroy();
    this.lottieInstances[elementId] = lottie.loadAnimation({
      container: el,
      renderer: "svg",
      loop: true,
      autoplay: true,
      path: path
    });
  },

  _playAnimationWhenReady(
    elementId,
    animationFile,
    attempts = 20,
    delay = 200
  ) {
    const el = document.getElementById(elementId);
    const isForecast = elementId.startsWith("forecast-anim-");
    if (
      isForecast &&
      this.latestForecastRenderKey &&
      !elementId.includes(this.latestForecastRenderKey)
    ) {
      return; // stale render; skip
    }
    if (!el) {
      if (attempts > 0) {
        setTimeout(
          () =>
            this._playAnimationWhenReady(
              elementId,
              animationFile,
              attempts - 1,
              delay
            ),
          delay
        );
      } else {
        console.warn(
          `[${this.name}] Missing icon container after retries: ${elementId}`
        );
      }
      return;
    }
    this._playAnimationFor(elementId, animationFile);
  },

  _uvAnimationFile(uvValue) {
    if (uvValue === undefined || uvValue === null) return null;
    const level = Math.min(11, Math.max(1, Math.round(uvValue)));
    return `uv-index-${level}.json`;
  },

  _processForecastAnimQueue() {
    if (!this.forecastAnimQueue.length) return;
    const next = [];
    this.forecastAnimQueue.forEach((item) => {
      const { id, file, isDay, attempts, renderKey } = item;
      if (
        this.latestForecastRenderKey &&
        renderKey !== this.latestForecastRenderKey
      )
        return; // stale
      const el = document.getElementById(id);
      if (el) {
        this._playAnimationFor(id, file);
      } else if (attempts > 0) {
        next.push({ id, file, isDay, attempts: attempts - 1, renderKey });
      } else {
        console.warn(
          `[${this.name}] Missing forecast icon container after retries: ${id}`
        );
      }
    });
    this.forecastAnimQueue = next;
    if (this.forecastAnimQueue.length)
      setTimeout(() => this._processForecastAnimQueue(), 200);
  },

  getDom() {
    const wrapper = document.createElement("div");
    wrapper.className = "MMM-AmbientWeather glass-card raised-edge";
    wrapper.style.minWidth = `${this.config.minWidth}px`;
    if (this.offline) wrapper.classList.add("offline");

    if (!this.loaded || !this.weatherData) {
      wrapper.innerHTML = `
        <div class="loading">
          <div class="spinner"></div>
          <div class="loading-text">Loading Ambient Weather data…</div>
        </div>`;
      return wrapper;
    }

    const d = this.weatherData;
    const tempUnit = this.config.units === "metric" ? "C" : "F";
    const feelsSource = d.feelsLike ?? d.feelslike;
    const feels = typeof feelsSource === "number"
      ? `${feelsSource.toFixed(1)}&deg;${tempUnit}`
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

    // Main weather section
    const main = document.createElement("div");
    main.className = "main-content";

    // Left: Animation
    const left = document.createElement("div");
    left.className = "main-left";
    const animId = "anim-weather";
    const animDiv = document.createElement("div");
    animDiv.id = animId;
    animDiv.className = "anim-container";
    left.appendChild(animDiv);

    // UV animation under main icon
    if (this.config.showUV && d.uv !== undefined) {
      const uvRow = document.createElement("div");
      uvRow.className = "uv-row";
      const uvAnimId = `uv-anim-${Date.now()}`;
      const uvLabel = document.createElement("span");
      uvLabel.className = "uv-label";
      uvLabel.textContent = "UV Index:";
      const uvIcon = document.createElement("div");
      uvIcon.id = uvAnimId;
      uvIcon.className = "uv-icon";
      uvRow.appendChild(uvLabel);
      uvRow.appendChild(uvIcon);
      left.appendChild(uvRow);

      const uvFile = this._uvAnimationFile(d.uv);
      if (uvFile && this.config.animateIcons) {
        setTimeout(() => this._playAnimationWhenReady(uvAnimId, uvFile), 200);
      }
    }
    main.appendChild(left);

    // Right: temperature + extras
    const right = document.createElement("div");
    right.className = "main-right";
    right.innerHTML = `
      <div class="temp-row">
        <div class="temp-value">${d.tempf?.toFixed(1) || "-"}&deg;${tempUnit}</div>
        <div class="temp-feels">Feels like ${feels}</div>
      </div>`;

    // Humidity & Wind
    const metrics = document.createElement("div");
    metrics.className = "metrics";
    metrics.innerHTML = `
      <div class="metric-item"><i class="fa fa-tint"></i> Humidity: ${d.humidity ?? "-"}%</div>
      <div class="metric-item">
        <span class="vane" style="transform: rotate(${d.winddir || 0}deg)">
          <i class="fa fa-location-arrow"></i>
        </span>
        Wind: ${d.windspeedmph?.toFixed(1) ?? "-"} mph (${this._windDirText(d.winddir || 0)})
      </div>`;
    const indoorTempF = d.tempinf;
    const indoorHum = d.humidityin;
    if (indoorTempF !== undefined || indoorHum !== undefined) {
      const isMetric = this.config.units === "metric";
      const indoorTemp = typeof indoorTempF === "number"
        ? isMetric ? ((indoorTempF - 32) * 5 / 9).toFixed(1) : indoorTempF.toFixed(1)
        : "-";
      const indoorUnit = isMetric ? "C" : "F";
      const indoorItem = document.createElement("div");
      indoorItem.className = "metric-item";
      indoorItem.innerHTML = `<i class="fa fa-home"></i> Inside: ${indoorTemp}${indoorUnit}${indoorHum !== undefined ? `, ${indoorHum}%` : ""}`;
      metrics.appendChild(indoorItem);
    }
    if (this.config.showBarometer && pressure) {
      const pr = document.createElement("div");
      pr.className = "metric-item";
      const iconHtml = trendIcon ? `<i class="fa ${trendIcon}"></i> ` : "";
      pr.innerHTML = `${iconHtml}Pressure: ${pressure.value.toFixed(2)} ${pressure.unit}${trendText}`;
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
      rain.innerText = "RAIN DETECTED";
      alerts.appendChild(rain);
    }
    if (d.lightning_strike_count || d.lightning_time) {
      const lightning = document.createElement("div");
      lightning.className = "alert-badge alert-lightning";
      lightning.innerText = "LIGHTNING ACTIVITY";
      alerts.appendChild(lightning);
    }
    wrapper.appendChild(alerts);

    // Weather.gov forecast
    const forecastLimit = this.config.forecastDays || 3;
    const forecastItems = (this.forecast || []).slice(0, forecastLimit);
    if (this.config.showNwsForecast && forecastItems.length) {
      const fc = document.createElement("div");
      fc.className = "forecast";
      const renderKey = Date.now().toString();
      this.latestForecastRenderKey = renderKey;
      const forecastAnims = [];
      const rows = forecastItems
        .map((day, idx) => {
          const dayName = day?.date
            ? new Date(day.date).toLocaleDateString([], { weekday: "short" })
            : "";
          const hi =
            day?.high !== undefined && day?.high !== null
              ? day.high.toFixed(0)
              : "-";
          const lo =
            day?.low !== undefined && day?.low !== null
              ? day.low.toFixed(0)
              : "-";
          const phrase = day?.phrase || "";
          const condRaw = day?.cond || this._conditionFromText(phrase);
          const cond = condRaw || "partly_cloudy";
          const animId = `forecast-anim-${renderKey}-${idx}`;
          forecastAnims.push({ animId, cond, isDay: day?.isDaytime !== false });
          return `
          <div class="forecast-day">
            <div class="forecast-name">${dayName}</div>
            <div class="forecast-temps"><span class="hi">${hi}&deg;</span><span class="lo">${lo}&deg;</span></div>
            <div class="forecast-icon" id="${animId}"></div>
            <div class="forecast-text">${phrase}</div>
          </div>`;
        })
        .join("");
      fc.innerHTML = `
        <div class="forecast-title">${forecastLimit}-Day Forecast</div>
        <div class="forecast-grid">${rows}</div>`;
      wrapper.appendChild(fc);

      setTimeout(() => {
        const latestKey = this.latestForecastRenderKey;
        const queue = forecastAnims
          .filter((f) => `${f.animId}`.includes(latestKey))
          .map(({ animId, cond, isDay }) => ({
            id: animId,
            file: this._resolveAnimationFile(cond, isDay),
            isDay,
            attempts: 30,
            renderKey: latestKey
          }));
        this.forecastAnimQueue = queue;
        if (this.forecastAnimQueue.length) this._processForecastAnimQueue();
      }, 400);
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
      ? `<span class="offline-text">⚠️ Offline — last update: ${last}</span>`
      : `<span>Updated: ${last}</span>`;
    wrapper.appendChild(footer);

    // Animate the weather icon
    setTimeout(() => {
      const cond = this._currentCondition(d);
      const isDay = this._isDay(d);
      const animFile = this._resolveAnimationFile(cond, isDay);
      if (this.config.animateIcons && animFile) {
        this._playAnimationWhenReady(animId, animFile);
      } else if (this.config.animateIcons) {
        const fallback =
          this.config.animations?.default?.[isDay ? "day" : "night"];
        if (fallback) this._playAnimationWhenReady(animId, fallback);
      }
    }, 300);

    return wrapper;
  }
});
