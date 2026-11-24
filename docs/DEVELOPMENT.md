# Development

Static web app: plain ES modules, no framework, no build step, no runtime dependencies.

## Run

Serve `app/` from `localhost` (Web Bluetooth needs HTTPS or localhost), e.g. `npx serve app`, and open it in Chrome.
**Demo** works without an adapter.

```sh
npm test   # node --test, no dependencies
```

## Layout

```
app/index.html
app/assets/             icons
app/src/app.js          UI wiring
app/src/core/           pids.js (decoders) · elm.js (ELM327 protocol) · journal.js (IndexedDB log)
                        settings.js (poll schedule) · refs.js (normal ranges) · guide.js (guided tests)
                        obdb.js (OBDb signal sets, VIN helpers)
app/profiles/           bundled OBDb profiles (Ford-Mustang, CC BY-SA 4.0) for offline use
app/src/ui/             style.css (light/dark) · chart.js (canvas charts)
app/src/transport/      ble.js (Web Bluetooth) · fake.js (Demo)
tests/                  unit tests for core modules
tools/obd_tui.py        Python TUI (Mac, bleak): Ford DID scans, log diffing
docs/screenshots/       README images
```

## Deploy

Every push to `main` runs `.github/workflows/pages.yml`: tests → copy `app/` → version CSS/JS URLs with the commit
SHA (no mixed old/new assets from caches) → GitHub Pages.

Version: `VERSION` in `app/src/app.js` must equal `version` in `package.json` (checked by a test).

## Log format

One line per event: `<date> <time.ms> <TAG> key=value ...` (same as `tools/obd_tui.py`).

| Tag | Meaning |
|---|---|
| `SESSION`, `CONN`, `ELM`, `LOG` | session start/end, adapter connect/loss, ELM info, app messages (incl. BLE steps) |
| `KEYS`, `CFG` | PID names/units; poll settings (ms per PID) at record start and on change |
| `S` | sample: only values polled since the previous line; `phase=` during guided tests |
| `DTC`, `DTC_NEW`, `FF` | trouble codes (before/read), new code during recording, freeze frame |
| `MISFIRE` | Mode 06 misfire counters per cylinder |
| `BATT` | adapter voltage + engine state |
| `VEH`, `PROFILE` | detected car (VIN, make/model/year, source) and the loaded OBDb profile |
| `ANOM` | anomaly: new misfire, value out of the "bad" range |
| `STEP`, `RESULT`, `STAT` | guided test steps, before/after comparison, per-step min/mean/max |

```sh
grep -E " (DTC_NEW|ANOM|MISFIRE) " obd_*.log
```

## Polling

- Each value has its own interval (Settings); a cycle polls only what's due. RPM doubles as the ECU liveness check.
- A sample line is written every `logEvery` ms, plus extra lines on jumps of RPM/rail/throttle/load/speed
  (at most 4/s). Trims and lambda are excluded: they oscillate by design.
- Fast guided-test steps (off/on prime, snaps, drive) poll only RPM, rail, trims, lambda, load, throttle.
- Unsupported PIDs (from the `0100/0120/0140` bitmaps) are skipped after connect.

## Vehicle profiles (OBDb)

- On connect (ECU awake): `0902` → VIN → NHTSA vPIC (`DecodeVinValues`) → make/model/year; offline fallback by WMI.
- Profile = OBDb repo `Make-Model` (then `Make`): fresh cache (7 days, localStorage) → GitHub raw → stale cache →
  `app/profiles/<repo>.json`. Manual override in Settings (repo + year).
- `commandsFor(signalset, year)` applies `filter`; `dbg`/`dbgfilter` years are shown as “unverified”.
- Values are keyed `x.<signal id>` in S lines; `KEYS` maps them to name, unit and `{hdr.cmd}`.
- Polling: own interval per value (≥1 s); commands grouped by header (`ATSH` switch, back to `7E0`);
  a command that fails 3 times (`7F22..`/NO DATA) is marked “no answer” and skipped until re-enabled.
- Dashed target lines: lambda ← commanded λ, rail ← `HPFP Desired`, low-side actual ← desired.
- Our own Ford DID research (`tools/obd_tui.py` scans) stays; OBDb is an extra source, not a replacement.

## BLE notes

- Service discovery tries `getPrimaryServices()`, then each known service (FFF0, FFE0, 18F0, AE30, Vgate) one by one.
- Known notify/write pairs (FFF1/FFF2, FFE1, …) are preferred; writes use write-with-response when available.
- ELM init fails fast if the adapter connects but doesn't answer.

## Open items

- Verify OBDb Mustang DIDs on the real car (2018 is mostly “unverified” in OBDb): `220548` low-side actual,
  `22041F` desired, `2203DC` rail desired, `220382…038B` misfire acceleration. Compare with our own DID scans
  (1279/16D3/16D4/16D7 turned out static).
