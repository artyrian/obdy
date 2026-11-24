# obdy

In-browser OBD-II scanner for BLE ELM327 adapters (tested with UniCarScan UCSI-2100 on a Ford Mustang 2.3 EcoBoost).
Client only: static files, no server, no build step.

**▶ https://artyrian.github.io/obdy/**

- **iPhone:** [Bluefy](https://apps.apple.com/app/id1492822055) browser (Safari/Chrome on iOS have no Web Bluetooth).
- **Mac/Windows/Android:** Chrome or Edge.

## Phone notes / known issues

- **iPhone needs Bluefy.** Safari and Chrome on iOS have no Web Bluetooth. Open the link in Bluefy.
- **Ignition on before connecting**, otherwise the ECU answers `NO DATA` (the adapter itself still connects).
  The app keeps polling and picks the ECU up once the ignition/engine is on.
- **One app per adapter.** Close Car Scanner or other OBD apps first, or the adapter won't connect.
- **Keep the browser in the foreground.** iOS suspends background pages: locking the phone or switching apps
  pauses polling, and after a few minutes the adapter disconnects (`CONN event=lost` in the log).
  While recording, the screen is kept on (Wake Lock) — plug the phone in for long sessions.
- **"Low Data Mode" warning** in Bluefy is harmless: the app needs the network only to load once.
  To turn it off: Settings → Wi-Fi → ⓘ next to the network (hotspot too) → Low Data Mode off;
  cellular: Settings → Cellular → Cellular Data Options → Data Mode → Standard.
- **Low Power Mode** (low battery) may slow polling; it turns off by itself at 80 % charge.
- **Connection failed?** The red banner has *Copy log*: it includes every BLE step (services, characteristics, chosen pair).

## Run locally

```sh
python3 -m http.server 8000   # Chrome: http://localhost:8000 (localhost allows Bluetooth without HTTPS)
npm test                      # core tests (node --test), no dependencies
```

"Demo" works without an adapter.

## Features (0.1.0-alpha)

- Live: RPM, coolant, fuel rail pressure, STFT/LTFT, lambda, load, voltage (+ optional MAP, MAF, timing…).
  Each tile: value, sparkline, actual poll period; tap expands a full chart in place (2–30 min window).
- Reference ranges (green band, `ref` line, value turns orange/red), context-aware: battery charging vs engine off,
  coolant warm, fuel trims ±10 %, lambda vs commanded λ (dashed line), warm-idle RPM, baro, catalyst.
  A value going out of the "bad" range while recording writes an `ANOM rule=ref_<PID>` line.
- Settings: on/off and poll interval per value, log line interval, jump lines; log size estimate. Saved in the browser.
- Recording starts automatically on connect (can be turned off in Settings): a line every 1 s by default with only values polled since the previous line (slow values appear
  as often as they're polled), extra lines on RPM/rail/throttle/load/speed jumps,
  DTCs and per-cylinder misfires every 20 s, freeze frame on new DTC, Wake Lock keeps the screen on.
- DTCs: modes 03/07/0A, freeze frame, Mode 06 misfires per cylinder.
- Logs go to IndexedDB immediately; export: Share / Download / Copy.

## Log format

`<date> <time.ms> <TAG> key=value ...`, same as `tools/obd_tui.py`.
Tags: SESSION CONN ELM KEYS CFG S STEP DTC DTC_NEW FF MISFIRE ANOM BATT LOG.
`CFG` records poll settings (ms per PID) at record start and on every change.

```sh
grep -E " (DTC_NEW|ANOM|MISFIRE) " obd_*.log
```

## Layout

```
index.html
favicon.svg/.ico · apple-touch-icon.png
src/app.js              UI
src/core/               pids.js (decoders) · elm.js (protocol) · journal.js · settings.js (poll schedule)
src/ui/                 style.css · chart.js (canvas charts)
src/transport/          ble.js (Web Bluetooth) · fake.js (demo)
tests/                  node --test
tools/obd_tui.py        Python TUI (dev tool: DID scans, diff)
docs/PLAN.md
```

## Deploy

Every push to `main` → `.github/workflows/pages.yml` (tests → GitHub Pages).

Version: `VERSION` in `src/app.js` must equal `version` in `package.json` (checked by a test).
