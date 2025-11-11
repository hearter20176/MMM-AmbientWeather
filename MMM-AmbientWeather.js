/* MMM-AmbientWeather.js
 * Animated 3D Lottie weather icons + liquid glass card
 * Gradient AQI/UV Index + humidity, wind, rain, lightning + shimmer reflection
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
    showAQI: true,
    showUV: true,
    animations: {
      clear_day: "clear_day.json",
      clear_night: "clear_night.json",
      partly_cloudy_day: "partly_cloudy_day.json",
      partly_cloudy_night: "partly_cloudy_night.json",
      cloud: "cloud.json",
      rain: "rain.json",
      thunderstorm: "thunderstorm.json",
      fog: "fog.json",
      snow: "snow.json",
      sleet: "sleet.json",
      freezing_rain: "freezing_rain.json"
    }
  },

  getScripts() {
    return ["https://cdnjs.cloudflare.com/ajax/libs/bodymovin/5.10.2/lottie.min.js"];
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

    this.sendSocketNotification("CONNECT_AMBIENT", {
      apiKey: this.config.apiKey,
      applicationKey: this.config.applicationKey,
      macAddress: this.config.macAddress,
      latitude: this.config.latitude,
      longitude: this.config.longitude
    });

    setTimeout(() => {
      this.isDomReady = true;
      if (this.loaded) this.safeUpdateDom(0);
    }, 800);

    this.offlineTimer = setInterval(() => this._checkOffline(), 15000);
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "AMBIENT_DATA") {
      const data = payload && payload.lastData ? payload.lastData : payload;
      this.weatherData = data;
      this.lastUpdate = Date.now();
      this.loaded = true;
      this.offline = false;
      this.safeUpdateDom(500);
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

  _aqiGradient(aqi) {
    const clamped = Math.min(500, Math.max(0, aqi));
    const ratio = clamped / 500;
    const r = Math.round(0 + (255 - 0) * ratio);
    const g = Math.round(228 - 228 * ratio);
    return `linear-gradient(90deg, #16a34a 0%, rgb(${r},${g},0) 100%)`;
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
      "N", "NNE", "NE", "ENE", "E", "ESE",
      "SE", "SSE", "S", "SSW", "SW", "WSW",
      "W", "WNW", "NW", "NNW"
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

    if (r > 0.1) return "rain";
    if (d.windgustmph > 25) return "thunderstorm";
    if (t < 32 && h > 80 && r > 0) return "snow";
    if (s === 0 && u === 0 && h > 90) return "fog";
    if (s > 200 && u > 1) return "clear";
    if (s > 100 && h < 80) return "partly_cloudy";
    return "cloud";
  },

  _isDay(d) {
    if (!d || !d.sunrise || !d.sunset) return true;
    const now = new Date();
    return now >= new Date(d.sunrise) && now <= new Date(d.sunset);
  },

  _playAnimationFor(elementId, animationFile) {
    const el = document.getElementById(elementId);
    if (!el) return;
    const path = this.file(`animations/${animationFile}`);
    if (this.lottieInstances[elementId]) this.lottieInstances[elementId].destroy();
    this.lottieInstances[elementId] = lottie.loadAnimation({
      container: el,
      renderer: "svg",
      loop: true,
      autoplay: true,
      path: path
    });
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
    const feels = d.feelsLike ? `${d.feelsLike.toFixed(1)}°${tempUnit}` : "—";

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
    main.appendChild(left);

    // Right: temperature + extras
    const right = document.createElement("div");
    right.className = "main-right";
    right.innerHTML = `
      <div class="temp-row">
        <div class="temp-value">${d.tempf?.toFixed(1) || "—"}°${tempUnit}</div>
        <div class="temp-feels">Feels ${feels}</div>
      </div>`;

    // Humidity & Wind
    const metrics = document.createElement("div");
    metrics.className = "metrics";
    metrics.innerHTML = `
      <div class="metric-item"><i class="fa fa-tint"></i> Humidity: ${d.humidity ?? "—"}%</div>
      <div class="metric-item">
        <span class="vane" style="transform: rotate(${d.winddir || 0}deg)">
          <i class="fa fa-location-arrow"></i>
        </span>
        Wind: ${d.windspeedmph?.toFixed(1) ?? "—"} mph (${this._windDirText(d.winddir || 0)})
      </div>`;
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

    // AQI + UV badges
    const badges = document.createElement("div");
    badges.className = "badges";

    if (this.config.showAQI && d.aqi_pm25 !== undefined) {
      const aqiDiv = document.createElement("div");
      aqiDiv.className = "badge aqi";
      aqiDiv.style.background = this._aqiGradient(d.aqi_pm25);
      aqiDiv.innerHTML = `Air Quality Index: ${d.aqi_pm25}`;
      badges.appendChild(aqiDiv);
    }

    if (this.config.showUV && d.uv !== undefined) {
      const uvDiv = document.createElement("div");
      uvDiv.className = "badge uv";
      uvDiv.style.background = this._uvGradient(d.uv);
      uvDiv.innerHTML = `UV Index: ${d.uv}`;
      badges.appendChild(uvDiv);
    }

    right.appendChild(badges);
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

    // Footer (offline/last update)
    const footer = document.createElement("div");
    footer.className = "footer";
    const last = this.lastUpdate
      ? new Date(this.lastUpdate).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "—";
    footer.innerHTML = this.offline
      ? `<span class="offline-text">⚠️ Offline — last update: ${last}</span>`
      : `<span>Updated: ${last}</span>`;
    wrapper.appendChild(footer);

    // Animate the weather icon
    setTimeout(() => {
      const cond = this._detectCondition(d);
      const isDay = this._isDay(d);
      let key = cond;
      if (cond === "clear") key = isDay ? "clear_day" : "clear_night";
      if (cond === "partly_cloudy") key = isDay ? "partly_cloudy_day" : "partly_cloudy_night";
      const animFile = this.config.animations[key] || this.config.animations.partly_cloudy_day;
      if (this.config.animateIcons && animFile) this._playAnimationFor(animId, animFile);
    }, 300);

    return wrapper;
  }
});
