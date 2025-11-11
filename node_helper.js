/* MagicMirror²
 * Module: MMM-AmbientWeather
 * Node Helper
 */

const NodeHelper = require("node_helper");
const io = require("socket.io-client");
const SunCalc = require("suncalc");

module.exports = NodeHelper.create({
  start: function () {
    console.log(`[${this.name}] ✅ Node helper started.`);
    this.socket = null;
    this.lastPayload = null;
    this.config = {};
  },

  socketNotificationReceived: function (notification, payload) {
    if (notification === "CONNECT_AMBIENT") {
      this.config = payload;
      this.connectAmbient(payload);
    }
  },

  connectAmbient: function (config) {
    if (this.socket) {
      console.log(`[${this.name}] 🔌 Existing connection closed before reconnect.`);
      this.socket.disconnect();
      this.socket = null;
    }

    const { apiKey, applicationKey, macAddress, latitude, longitude } = config;
    const FILTER_MAC = macAddress ? macAddress.toLowerCase() : null;
    const SOCKET_URL = `https://rt2.ambientweather.net/?api=1&applicationKey=${applicationKey}`;

    console.log(`[${this.name}] 🌐 Connecting to Ambient Weather Realtime API...`);
    console.log(`[${this.name}] URL: ${SOCKET_URL}`);

    const socket = io(SOCKET_URL, {
      transports: ["websocket"],
      reconnection: true,
      reconnectionDelay: 5000
    });
    this.socket = socket;

    socket.on("connect", () => {
      console.log(`[${this.name}] ✅ Connected to Ambient Weather Realtime API`);
      socket.emit("subscribe", { apiKeys: [apiKey], applicationKey });
    });

    socket.on("subscribed", (data) => {
      console.log(`[${this.name}] 📡 Subscribed to realtime feed:`, data);
    });

    socket.on("data", (data) => {
      try {
        const mac = (data.macAddress || data.MACAddress || data.mac || "").toLowerCase();
        if (FILTER_MAC && mac !== FILTER_MAC) return;

        console.log(`[${this.name}] 📡 Realtime update received for ${mac}: tempf=${data.tempf}, humidity=${data.humidity}`);

        // Attach computed sunrise/sunset if missing
        if ((!data.sunrise || !data.sunset) && latitude && longitude) {
          try {
            const times = SunCalc.getTimes(new Date(), latitude, longitude);
            data.sunrise = times.sunrise.toISOString();
            data.sunset = times.sunset.toISOString();
          } catch (err) {
            console.warn(`[${this.name}] ⚠️ Unable to compute sunrise/sunset:`, err.message);
          }
        }

        this.lastPayload = data;
        this.sendSocketNotification("AMBIENT_DATA", { lastData: data });
      } catch (err) {
        console.error(`[${this.name}] ⚠️ Error processing data:`, err);
      }
    });

    socket.on("disconnect", (reason) => {
      console.warn(`[${this.name}] ⚠️ Disconnected from Ambient API:`, reason);
    });

    socket.on("connect_error", (err) => {
      console.error(`[${this.name}] ❌ Connection error:`, err.message);
    });

    socket.on("error", (err) => {
      console.error(`[${this.name}] ❌ Socket error:`, err);
    });
  }
});
