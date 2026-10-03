# MMM-AmbientWeather

A real-time Ambient Weather display module for MagicMirror2, featuring a liquid-glass UI, Lottie
weather icons (with a static icon fallback for low-power devices), and realtime data streaming via
the Ambient Weather Realtime API.

<p align="center">
  <img src="docs/MMM-AmbientWeather_loading_spinner.png" width="400" alt="Loading state"/>
  <img src="docs/MMM-AmbientWeather_night.png" width="400" alt="Night view"/>
</p>

## Features

- Realtime weather updates via Ambient Weather's Realtime API (socket.io)
- Animated Lottie icons for day/night and all major weather types, with static Font Awesome icon
  fallback when animation is disabled (e.g. on `performanceProfile: "pi"`)
- Temperature, feels-like, humidity, windspeed + direction, indoor temperature/humidity
- Rotating weathervane with compass text (N, NNE, NE, ...)
- Rain detection badge (based on station data)
- Lightning: a page-wide alert when the station's lightning sensor reports a new strike, and a
  lightning row on the card (strikes today and in the last hour, last strike time and distance)
- Sunrise and sunset times (computed automatically via SunCalc when the station doesn't report them)
- UV Index, shown as an animated icon or a plain number when Lottie is disabled
- 3-day (configurable) National Weather Service forecast panel
- Liquid-glass frosted card UI
- Offline fallback - card fades and shows last update time if data goes stale
- Visible error state (missing/invalid API keys, connection failure, wrong `macAddress`) instead of
  an indefinite loading spinner
- Supports both Imperial and Metric units

## Installation

Navigate to your MagicMirror modules directory:

```sh
cd ~/MagicMirror/modules
```

Clone this repository:

```sh
git clone https://github.com/hearter20176/MMM-AmbientWeather.git
```

Install dependencies:

```sh
cd MMM-AmbientWeather
npm install
```

Add the module to your MagicMirror `config.js` file (see below).

## Configuration

Add the following to your `config/config.js`:

```js
{
  module: "MMM-AmbientWeather",
  position: "top_right",
  config: {
    title: "Home Weather",
    apiKey: "YOUR_API_KEY_HERE",
    applicationKey: "YOUR_APP_KEY_HERE",
    macAddress: "xx:xx:xx:xx:xx:xx",
    units: "imperial",           // "imperial" or "metric"
    showUV: true,
    showSunTimes: true,
    showBarometer: true,
    pressureTrendThreshold: 0.01,
    latitude: 40.7128,           // used for sunrise/sunset fallback and the NWS forecast
    longitude: -74.0060,
    showNwsForecast: true,
    forecastDays: 3,
    forecastCacheMinutes: 90,
    offlineThreshold: 300000,    // fade card if no update after 5 min
    animateIcons: true,
    performanceProfile: "auto",  // "auto" | "pi" | "full"
    reduceMotion: false,         // true disables Lottie on low-power or reduced-motion setups
    minWidth: 260,
    maxHeight: null              // optional card height cap in px; null = size to content
  }
}
```

Note: For the weather.gov forecast API, keep `latitude` and `longitude` to 4 decimal places or
fewer. More precision can cause the API to reject the request.

## Options

| Option                  | Type      | Default          | Description                                                                                     |
| :----------------------- | :-------- | :--------------- | :------------------------------------------------------------------------------------------------ |
| `title`                  | `string`  | `"Home Weather"` | Title shown at the top of the card. Set to `""`/`false` to hide.                                  |
| `apiKey`                 | `string`  | **Required**     | Your Ambient Weather API key.                                                                      |
| `applicationKey`         | `string`  | **Required**     | Your Ambient Weather application key.                                                              |
| `macAddress`             | `string`  | —                 | MAC address of your station. If omitted, the first device on the account is used.                 |
| `units`                  | `string`  | `"imperial"`     | `"imperial"` or `"metric"`. Applies to temperature (F/C) and wind speed (mph/km/h).                |
| `showUV`                 | `boolean` | `true`           | Show the UV Index (animated icon, or a number when Lottie is disabled).                            |
| `showSunTimes`           | `boolean` | `true`           | Show sunrise/sunset times.                                                                          |
| `showBarometer`          | `boolean` | `true`           | Show barometric pressure and its rising/falling/steady trend.                                      |
| `pressureTrendThreshold` | `float`   | `0.01`           | inHg delta between readings required to flag a rising/falling pressure trend.                      |
| `latitude`               | `float`   | —                 | Used for sunrise/sunset fallback (if the station doesn't report it) and the NWS forecast.          |
| `longitude`              | `float`   | —                 | See `latitude`.                                                                                     |
| `showNwsForecast`        | `boolean` | `true`           | Show the National Weather Service forecast panel (requires `latitude`/`longitude`).                |
| `forecastDays`           | `int`     | `3`              | Number of forecast days to request/display (1-5).                                                   |
| `forecastCacheMinutes`   | `int`     | `90`             | Minutes to cache the NWS forecast response before re-fetching.                                      |
| `offlineThreshold`       | `int`     | `300000`         | Milliseconds since the last realtime packet before the module grays out ("offline").                |
| `animateIcons`           | `boolean` | `true`           | Enable Lottie animated weather icons.                                                               |
| `animations`             | `object`  | (JSON map)       | Map of weather condition keys to `{ day, night }` Lottie filenames (under `animations/`).           |
| `performanceProfile`     | `string`  | `"auto"`         | `"auto"` detects Pi/ARM devices and disables Lottie for them, `"pi"` forces it off, `"full"` keeps it on. |
| `reduceMotion`           | `boolean` | `false`          | Force-disable Lottie/motion (also triggered by `prefers-reduced-motion`).                           |
| `minWidth`               | `int`     | `260`            | Minimum card width in pixels.                                                                       |
| `maxHeight`              | `int`     | `null`           | Optional card height cap in pixels. `null` sizes the card to its content (nothing is clipped).      |
| `debug`                  | `boolean` | `false`          | Log every realtime payload from the Ambient API to the browser console (verbose; off by default).  |
| `showLightning`          | `string`  | `"always"`       | Lightning row on the card: `"always"`, `"auto"` (only on days with strikes), or `"never"`. `true`/`false` mean always/never. |
| `lightningAlert`         | `boolean` | `true`           | Show the page-wide banner when the sensor reports a new strike.                                     |
| `lightningAlertDuration` | `int`     | `60`             | Seconds the banner stays up. Each new strike while it is up refreshes it and restarts the timer. Minimum 5. |
| `lightningAlertCooldown` | `int`     | `10`             | Minutes after the banner closes before another strike reopens it. `0` disables the cooldown.        |
| `lightningActiveMinutes` | `int`     | `30`             | Minutes after the last strike that the card treats lightning as active (highlighted row and badge). |
| `lightningDangerDistance`| `float`   | `6`              | Strikes this close (miles, or km when `units` is metric) use the urgent banner. `0` disables it. See Lightning for the cooldown rule. |
| `lightningAlertPosition` | `string`  | `"bottom"`       | Banner position: `"bottom"` or `"top"` of the screen.                                            |

When `animateIcons` is off (directly, via `reduceMotion`, or because `performanceProfile` resolved
to `"pi"`), the module falls back to static Font Awesome icons for the main condition and each
forecast day, and shows the UV Index as a plain number instead of an animated icon.

Animation lifecycle: every Lottie player is bound to the exact container created for its render.
Players from the previous render keep running on the visible tree and are destroyed as soon as
that tree is detached. The module detects this on MagicMirror's `MODULE_DOM_UPDATED`
notification, with a short bounded poll as a fallback; if MagicMirror skips or drops the swap the
existing players simply stay on screen. At most one player exists per container. While the module
is hidden (for example by MMM-pages), `suspend()` pauses all players and `resume()` plays every
surviving player again (and starts any that are missing).
The card height is automatic, and the height override in the module CSS applies only to this
module's own card (`.MMM-AmbientWeather.glass-card`); other modules are not affected. If a
`custom.css` rule sets a fixed `height`/`max-height` on this card it is overridden; use the
`maxHeight` option to cap the height instead. Any stale clamp on other modules' cards should be
fixed in that module or in `custom.css`.

## Lightning

For stations with a lightning sensor (Ambient fields `lightning_day`, `lightning_hour`,
`lightning_time`, `lightning_distance`):

- **Strike detection.** A new strike is a rise in `lightning_day` or a newer `lightning_time` than
  the previous realtime packet. The first packet after MagicMirror starts only sets the baseline,
  so a restart never re-announces an old strike. The midnight reset of `lightning_day` is not a
  strike. A `lightning_time` that advances to a value already older than
  `lightningActiveMinutes` (strikes missed during a connection gap) is ignored, including when
  the day count rose during the gap; a day-count rise with an
  unchanged timestamp still counts, reported without a time. Ages are measured on the station's
  clock (the packet's `dateutc`, which Ambient sends with every packet), so a station clock that
  runs ahead of or behind the mirror does not drop strikes. A `lightning_time` more than 15
  minutes ahead of that clock is treated as corrupt: it is ignored, and only a day-count rise can
  report a strike from that packet.
- **Banner.** A glass banner with the distance, time, and strikes in the last hour. It is attached
  to the page body rather than the card, so it appears on every MMM-pages page, not only the
  weather page. While it is up, new strikes update it in place, and once it is urgent (red,
  "Lightning strike nearby") it stays urgent until it closes. After it closes, further strikes
  within `lightningAlertCooldown` do not reopen it. The exception is a strike within
  `lightningDangerDistance` when the previous banner was not urgent: that opens the urgent banner
  straight away. The banner enters and leaves with one short transition and never loops; with
  `reduceMotion` or the `"pi"` profile (or the OS reduced-motion setting) it appears and
  disappears without motion and without the backdrop blur.
- **Card.** A lightning row under the other readings: strikes today and in the last hour, plus the
  last strike's time and distance ("No strikes logged" until the sensor has recorded one). It is
  highlighted, and a "LIGHTNING NEARBY" badge shows, for `lightningActiveMinutes` (30 by default,
  after the 30-30 rule) after the last strike. The badges pulse a few times when they appear and
  then stay still.
- **Options.** Invalid lightning options are logged as a warning and replaced by their defaults.
- **Notification.** Every detected strike is broadcast as `AMBIENT_LIGHTNING`
  `{ time, distance, unit, strikesHour, strikesDay }`, banner or not, for other modules to use.

## Data Displayed

- Temperature (deg F/C) and feels-like
- Humidity (%)
- Windspeed (mph/km/h) + weathervane with compass direction
- Indoor temperature/humidity (when reported by the station)
- Barometric pressure and trend
- UV Index (0-11)
- Sunrise / sunset
- Rain detection badge; lightning row and "LIGHTNING NEARBY" badge (see Lightning)
- National Weather Service forecast (when `showNwsForecast` is enabled)
- Offline indicator / last updated time
- Error state for missing/invalid API keys, connection failures, or an unmatched `macAddress`

## Visual Effects

**Liquid Glass Card**: a translucent, frosted background with blur, bevel, and raised border.

**Shimmer Animation**: a subtle looping reflection moving across the card surface.

**Lottie Weather Icons**: animated illustrations for all major weather types, replaced by static
Font Awesome icons when Lottie is disabled.

**Offline Mode**: the card fades and becomes grayscale when no data has arrived for more than
`offlineThreshold` milliseconds.

## Dependencies

- MagicMirror2
- [socket.io-client](https://www.npmjs.com/package/socket.io-client) - realtime connection to the Ambient Weather API
- [suncalc](https://www.npmjs.com/package/suncalc) - sunrise/sunset fallback when the station doesn't report them
- A vendored copy of [Lottie](https://airbnb.io/lottie/) (`vendor/lottie.min.js`) for icon animation - no CDN fetch required

## Credits

Author: Harry Arter

Realtime Data: [Ambient Weather API](https://ambientweather.net/)

Forecast Data: [National Weather Service API](https://www.weather.gov/documentation/services-web-api)

Animations: [LottieFiles.com](https://lottiefiles.com/)

UI Design Inspiration: iOS "Liquid Glass" and weather dashboard aesthetics

## License

This module is released under the [MIT License](LICENSE).

Feel free to fork, enhance, and share improvements.
