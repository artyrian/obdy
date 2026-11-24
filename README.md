# obdy

In-browser OBD-II scanner for BLE ELM327 adapters (tested with UniCarScan UCSI-2100 on a Ford Mustang 2.3 EcoBoost).
Client only: static files, no server, no build step.

**▶ https://artyrian.github.io/obdy/**

- **iPhone:** [Bluefy](https://apps.apple.com/app/id1492822055) browser (Safari/Chrome on iOS have no Web Bluetooth).
- **Mac/Windows/Android:** Chrome or Edge.

## Run locally

```sh
python3 -m http.server 8000   # Chrome: http://localhost:8000 (localhost allows Bluetooth without HTTPS)
npm test                      # core tests (node --test), no dependencies
```

"Demo" works without an adapter.

## Features (0.1.0-alpha)

- Live: RPM, coolant, fuel rail pressure, STFT/LTFT, lambda, load, voltage; poll rate.
- Recording: ~1 line/s (more on change), DTCs and per-cylinder misfires every 20 s,
  freeze frame on new DTC, Wake Lock keeps the screen on.
- DTCs: modes 03/07/0A, freeze frame, Mode 06 misfires per cylinder.
- Logs go to IndexedDB immediately; export: Share / Download / Copy.

## Log format

`<date> <time.ms> <TAG> key=value ...`, same as `tools/obd_tui.py`.
Tags: SESSION CONN ELM KEYS S STEP DTC DTC_NEW FF MISFIRE ANOM BATT LOG.

```sh
grep -E " (DTC_NEW|ANOM|MISFIRE) " obd_*.log
```

## Layout

```
index.html
favicon.svg/.ico · apple-touch-icon.png
src/app.js              UI
src/core/               pids.js (decoders) · elm.js (protocol) · journal.js
src/transport/          ble.js (Web Bluetooth) · fake.js (demo)
tests/                  node --test
tools/obd_tui.py        Python TUI (dev tool: DID scans, diff)
docs/PLAN.md
```

## Deploy

Every push to `main` → `.github/workflows/pages.yml` (tests → GitHub Pages).

Version: `VERSION` in `src/app.js` must equal `version` in `package.json` (checked by a test).
