/* MagicMirror Module: MMM-AmbientWeather - Node Helper */

const https = require("node:https");
const Log = require("logger");
const NodeHelper = require("node_helper");
const io = require("socket.io-client");
const SunCalc = require("suncalc");

const NO_DATA_TIMEOUT_MS = 3 * 60 * 1000; // how long to wait for a matching packet after "subscribed"
const ERROR_SUMMARY_MS = 5 * 60 * 1000; // how often to re-log/re-notify a sustained connect_error

module.exports = NodeHelper.create({
  start() {
    Log.info(`[${this.name}] Node helper started.`);
    this.socket = null;
    this.lastPayload = null;
    this.config = {};
    this.forecastCache = null;
    this.noDataTimer = null;
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "CONNECT_AMBIENT") {
      this.config = payload;
      this.connectAmbient(payload);
    }
    if (notification === "REQUEST_FORECAST") {
      this.fetchNwsForecast(payload);
    }
  },

  connectAmbient(config) {
    if (this.socket) {
      Log.log(`[${this.name}] Existing connection closed before reconnect.`);
      this.socket.disconnect();
      this.socket = null;
    }
    this._clearNoDataTimer();

    const { apiKey, applicationKey, macAddress, latitude, longitude, debug } = config || {};

    if (!apiKey || !applicationKey) {
      Log.error(`[${this.name}] Missing apiKey and/or applicationKey in config.`);
      this.sendSocketNotification("AMBIENT_ERROR", {
        code: "CONFIG",
        message: "apiKey and applicationKey are required"
      });
      return;
    }

    // Mutable: if no macAddress is configured, "subscribed" picks the account's first device.
    let FILTER_MAC = macAddress ? macAddress.toLowerCase() : null;
    const SOCKET_URL = `https://rt2.ambientweather.net/?api=1&applicationKey=${applicationKey}`;

    Log.log(`[${this.name}] Connecting to Ambient Weather Realtime API...`);

    // Back off exponentially (5s -> 2min) so an outage doesn't retry every 5s forever.
    const socket = io(SOCKET_URL, {
      transports: ["websocket"],
      reconnection: true,
      reconnectionDelay: 5000,
      reconnectionDelayMax: 120000,
      randomizationFactor: 0.5
    });
    let errorCount = 0;
    let lastErrorLog = 0;
    this.socket = socket;

    socket.on("connect", () => {
      if (errorCount > 0) {
        Log.log(`[${this.name}] Reconnected after ${errorCount} failed attempt(s)`);
        errorCount = 0;
      }
      Log.log(`[${this.name}] Connected to Ambient Weather Realtime API`);
      socket.emit("subscribe", { apiKeys: [apiKey], applicationKey });
    });

    socket.on("subscribed", (data) => {
      const devices = Array.isArray(data?.devices) ? data.devices : [];
      Log.log(`[${this.name}] Subscribed to realtime feed (${devices.length} device(s))`);

      // The Ambient realtime API answers a subscribe with bad/unknown keys with an empty device
      // list instead of a socket-level error - without this check the card spins forever.
      if (!devices.length) {
        this.sendSocketNotification("AMBIENT_ERROR", {
          code: "AUTH",
          message: "Ambient API key returned no devices. Check apiKey/applicationKey."
        });
        return;
      }

      if (!FILTER_MAC) {
        const firstMac = devices[0]?.macAddress || devices[0]?.mac;
        if (firstMac) FILTER_MAC = `${firstMac}`.toLowerCase();
      }

      this._armNoDataTimer(FILTER_MAC);
    });

    socket.on("data", (data) => {
      try {
        const mac = (data.macAddress || data.MACAddress || data.mac || "").toLowerCase();
        if (FILTER_MAC && mac !== FILTER_MAC) return;

        this._clearNoDataTimer();

        if (debug) Log.log(`[${this.name}] Realtime payload:`, data);

        // Attach computed sunrise/sunset if missing
        if ((!data.sunrise || !data.sunset) && latitude && longitude) {
          try {
            const times = SunCalc.getTimes(new Date(), latitude, longitude);
            data.sunrise = times.sunrise.toISOString();
            data.sunset = times.sunset.toISOString();
          } catch (err) {
            Log.warn(`[${this.name}] Unable to compute sunrise/sunset:`, err.message);
          }
        }

        this.lastPayload = data;
        this.sendSocketNotification("AMBIENT_DATA", { lastData: data });
      } catch (err) {
        Log.error(`[${this.name}] Error processing data:`, err);
      }
    });

    socket.on("disconnect", (reason) => {
      Log.warn(`[${this.name}] Disconnected from Ambient API:`, reason);
    });

    // Notify the front end on the first failure of an outage, then at most every 5 minutes.
    socket.on("connect_error", (err) => {
      errorCount += 1;
      const now = Date.now();
      if (errorCount === 1 || now - lastErrorLog >= ERROR_SUMMARY_MS) {
        const suffix = errorCount > 1 ? ` (${errorCount} failed attempts so far)` : "";
        Log.error(`[${this.name}] Connection error: ${err.message}${suffix}`);
        lastErrorLog = now;
        this.sendSocketNotification("AMBIENT_ERROR", {
          code: "CONNECT",
          message: err?.message || "Connection error"
        });
      }
    });

    socket.on("error", (err) => {
      Log.error(`[${this.name}] Socket error:`, err);
    });
  },

  // Starts (or restarts) the "did we ever hear a matching packet" watchdog. Fires once if no
  // packet arrives within NO_DATA_TIMEOUT_MS of a successful subscribe - this is what surfaces a
  // wrong/typo'd macAddress (or a station that's simply offline) instead of leaving the front end
  // loading forever. Armed regardless of whether a macAddress filter is configured.
  _armNoDataTimer(filterMac) {
    this._clearNoDataTimer();
    this.noDataTimer = setTimeout(() => {
      const message = filterMac
        ? `No data received for macAddress ending in ${filterMac.slice(-5)}`
        : "No data received from the Ambient Weather account";
      this.sendSocketNotification("AMBIENT_ERROR", { code: "NO_DATA", message });
    }, NO_DATA_TIMEOUT_MS);
    if (this.noDataTimer.unref) this.noDataTimer.unref();
  },

  _clearNoDataTimer() {
    if (this.noDataTimer) {
      clearTimeout(this.noDataTimer);
      this.noDataTimer = null;
    }
  },

  fetchNwsForecast(opts = {}) {
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
        const props = points?.properties || {};
        const fallbackGridUrl = props.gridId !== undefined &&
          props.gridX !== undefined &&
          props.gridY !== undefined
          ? `https://api.weather.gov/gridpoints/${props.gridId}/${props.gridX},${props.gridY}/forecast`
          : null;
        const forecastUrl = props.forecast || fallbackGridUrl;

        if (!forecastUrl) {
          const detail = points?.detail || points?.title || "unknown response";
          Log.warn(`[${this.name}] No forecast URL from weather.gov. Detail: ${detail}`);
          const empty = { forecast: [], tonight: null };
          this.forecastCache = { ts: Date.now(), data: empty };
          this.sendSocketNotification("NWS_FORECAST", empty);
          return null;
        }

        return this._fetchJson(forecastUrl);
      })
      .then((json) => {
        if (!json) return;
        const periods = Array.isArray(json?.properties?.periods) ? json.properties.periods : [];
        const daysOnly = periods.filter((p) => p.isDaytime).slice(0, limit);
        const forecast = daysOnly.map((p) => {
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

        // Distinct from forecast[0] (the next/current daytime period): the current or next
        // night-time period, used by the front end as its night fallback instead of tomorrow's
        // daytime forecast.
        const now = Date.now();
        const tonightPeriod = periods.find((p) => !p.isDaytime && new Date(p.endTime).getTime() > now);
        const tonight = tonightPeriod
          ? {
              cond: this._conditionFromText(tonightPeriod.shortForecast || tonightPeriod.name) || null,
              phrase: tonightPeriod.shortForecast || tonightPeriod.name || ""
            }
          : null;

        this.forecastCache = { ts: Date.now(), data: { forecast, tonight, metric } };
        this.sendSocketNotification("NWS_FORECAST", { forecast, tonight });
      })
      .catch((err) => {
        const msg = err?.message || `${err}`;
        const isInvalidPoint = /invalidpoint|data unavailable|no forecast url/i.test(msg);
        if (isInvalidPoint) {
          Log.warn(`[${this.name}] Forecast unavailable for lat/lon ${lat},${lon}: ${msg}`);
          const empty = { forecast: [], tonight: null };
          this.forecastCache = { ts: Date.now(), data: empty };
          this.sendSocketNotification("NWS_FORECAST", empty);
        } else {
          Log.error(`[${this.name}] Forecast fetch error:`, msg);
          // Don't leave the front end's forecast panel stuck on an old render forever - hand back
          // whatever we still have cached (or nothing) plus an error flag so it can retry sooner.
          const fallback = this.forecastCache ? this.forecastCache.data.forecast : [];
          const tonightFallback = this.forecastCache ? this.forecastCache.data.tonight : null;
          this.sendSocketNotification("NWS_FORECAST", { forecast: fallback || [], tonight: tonightFallback, error: msg });
        }
      });
  },

  _conditionFromText(txt) {
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

  _fetchJson(url) {
    return new Promise((resolve, reject) => {
      const opts = {
        headers: {
          "User-Agent": "MMM-AmbientWeather/1.0 (MagicMirror)",
          Accept: "application/geo+json"
        }
      };
      const req = https
        .get(url, opts, (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              const parsed = JSON.parse(data);
              const status = res.statusCode || 200;
              if (status >= 400) {
                const detail = parsed?.detail || parsed?.title || `HTTP ${status}`;
                reject(new Error(detail));
                return;
              }
              resolve(parsed);
            } catch (err) {
              reject(err);
            }
          });
        })
        .on("error", reject);
      req.setTimeout(15000, () => {
        req.destroy(new Error("Request timed out"));
      });
    });
  }
});
