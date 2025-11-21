/* MagicMirror Module: MMM-AmbientWeather - Node Helper */

const NodeHelper = require("node_helper");
const io = require("socket.io-client");
const SunCalc = require("suncalc");
const https = require("https");

module.exports = NodeHelper.create({
  start: function () {
    console.log(`[${this.name}] Node helper started.`);
    this.socket = null;
    this.lastPayload = null;
    this.config = {};
    this.forecastCache = null;
  },

  socketNotificationReceived: function (notification, payload) {
    if (notification === "CONNECT_AMBIENT") {
      this.config = payload;
      this.connectAmbient(payload);
    }
    if (notification === "REQUEST_FORECAST") {
      this.fetchNwsForecast(payload);
    }
  },

  connectAmbient: function (config) {
    if (this.socket) {
      console.log(`[${this.name}] Existing connection closed before reconnect.`);
      this.socket.disconnect();
      this.socket = null;
    }

    const { apiKey, applicationKey, macAddress, latitude, longitude } = config;
    const FILTER_MAC = macAddress ? macAddress.toLowerCase() : null;
    const SOCKET_URL = `https://rt2.ambientweather.net/?api=1&applicationKey=${applicationKey}`;

    console.log(`[${this.name}] Connecting to Ambient Weather Realtime API...`);
    console.log(`[${this.name}] URL: ${SOCKET_URL}`);

    const socket = io(SOCKET_URL, {
      transports: ["websocket"],
      reconnection: true,
      reconnectionDelay: 5000
    });
    this.socket = socket;

    socket.on("connect", () => {
      console.log(`[${this.name}] Connected to Ambient Weather Realtime API`);
      socket.emit("subscribe", { apiKeys: [apiKey], applicationKey });
    });

    socket.on("subscribed", (data) => {
      console.log(`[${this.name}] Subscribed to realtime feed:`, data);
    });

    socket.on("data", (data) => {
      try {
        const mac = (data.macAddress || data.MACAddress || data.mac || "").toLowerCase();
        if (FILTER_MAC && mac !== FILTER_MAC) return;

        console.log(`[${this.name}] Realtime payload:`, data);

        // Attach computed sunrise/sunset if missing
        if ((!data.sunrise || !data.sunset) && latitude && longitude) {
          try {
            const times = SunCalc.getTimes(new Date(), latitude, longitude);
            data.sunrise = times.sunrise.toISOString();
            data.sunset = times.sunset.toISOString();
          } catch (err) {
            console.warn(`[${this.name}] Unable to compute sunrise/sunset:`, err.message);
          }
        }

        this.lastPayload = data;
        this.sendSocketNotification("AMBIENT_DATA", { lastData: data });
      } catch (err) {
        console.error(`[${this.name}] Error processing data:`, err);
      }
    });

    socket.on("disconnect", (reason) => {
      console.warn(`[${this.name}] Disconnected from Ambient API:`, reason);
    });

    socket.on("connect_error", (err) => {
      console.error(`[${this.name}] Connection error:`, err.message);
    });

    socket.on("error", (err) => {
      console.error(`[${this.name}] Socket error:`, err);
    });
  },

  fetchNwsForecast: function (opts = {}) {
    const { lat, lon, metric, days } = opts;
    if (lat === undefined || lon === undefined) return;
    const cacheMs = (this.config.forecastCacheMinutes || 90) * 60 * 1000;
    const now = Date.now();
    if (this.forecastCache && now - this.forecastCache.ts < cacheMs) {
      this.sendSocketNotification("NWS_FORECAST", this.forecastCache.data);
      return;
    }

    const limit = Math.max(1, Math.min(5, days || 3));
    const pointsUrl = `https://api.weather.gov/points/${lat},${lon}`;

    this._fetchJson(pointsUrl)
      .then((points) => {
        const forecastUrl = points?.properties?.forecast;
        if (!forecastUrl) throw new Error("No forecast URL from weather.gov");
        return this._fetchJson(forecastUrl);
      })
      .then((json) => {
        const periods = Array.isArray(json?.properties?.periods) ? json.properties.periods : [];
        const daysOnly = periods.filter((p) => p.isDaytime).slice(0, limit);
        const forecast = daysOnly.map((p, idx) => {
          const night = periods.find((n) => !n.isDaytime && new Date(n.startTime).getTime() > new Date(p.startTime).getTime());
          const toMetric = (tempF) => (tempF - 32) * 5 / 9;
          const hiF = p.temperature !== undefined ? p.temperature : null;
          const loF = night?.temperature !== undefined ? night.temperature : null;
          const high = hiF === null ? null : (metric ? toMetric(hiF) : hiF);
          const low = loF === null ? null : (metric ? toMetric(loF) : loF);
          return {
            date: p.startTime,
            high,
            low,
            unit: metric ? "C" : "F",
            phrase: p.shortForecast || p.name || "",
            cond: this._conditionFromText(p.shortForecast || p.name) || null,
            isDaytime: p.isDaytime
          };
        });
        this.forecastCache = { ts: Date.now(), data: { forecast, metric } };
        this.sendSocketNotification("NWS_FORECAST", { forecast });
      })
      .catch((err) => {
        console.error(`[${this.name}] Forecast fetch error:`, err.message || err);
      });
  },

  _conditionFromText: function (txt) {
    if (!txt) return null;
    const t = `${txt}`.toLowerCase();
    if (t.includes("thunder")) return "thunderstorm";
    if (t.includes("sleet")) return "sleet";
    if (t.includes("freezing")) return "freezing_rain";
    if (t.includes("snow")) return "snow";
    if (t.includes("hail")) return "sleet";
    if (t.includes("rain") || t.includes("drizzle") || t.includes("shower")) return "rain";
    if (t.includes("fog") || t.includes("mist")) return "fog";
    if (t.includes("haze") || t.includes("smoke")) return "fog";
    if (t.includes("overcast")) return "cloud";
    if (t.includes("cloud")) return "partly_cloudy";
    if (t.includes("clear") || t.includes("sun") || t.includes("fair")) return "clear";
    return null;
  },

  _fetchJson: function (url) {
    return new Promise((resolve, reject) => {
      const opts = {
        headers: {
          "User-Agent": "MMM-AmbientWeather/1.0 (MagicMirror)"
        }
      };
      https
        .get(url, opts, (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              resolve(JSON.parse(data));
            } catch (err) {
              reject(err);
            }
          });
        })
        .on("error", reject);
    });
  }
});
