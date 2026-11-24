# obdy — plan

Own OBD scanner for a Mustang 2.3 EcoBoost via the UniCarScan UCSI-2100 BLE adapter (ELM327, service FFF0).
Prototype: `obd_tui.py` (Python + Textual + bleak) — stays as a dev tool.

## Decision

Client only: static site (PWA), no server. Hosting: GitHub Pages (free HTTPS).
- iPhone: **Bluefy** browser (Chrome/Safari on iOS have no Web Bluetooth). Mac: Chrome.
- Web Bluetooth requires HTTPS; http://localhost is enough on a Mac.
- Logs live in the browser's IndexedDB; export: Share (AirDrop/Files) · Download · Copy.
- Nothing to install on the work Mac, no Gatekeeper/MDM issues.

## Architecture

```
web/ (Vite + TypeScript, no framework or Preact)
  core/       elm.ts  pids.ts  dtc.ts  mode06.ts  anomalies.ts  scenarios.ts  journal.ts
  transport/  ble.ts (Web Bluetooth)  fake.ts (demo)  replay.ts (log replay)
  ui/         connect · scenarios (Quick / Cold start / Drive / Fuel debug) · live · journals
tools/        obd_tui.py
docs/         PLAN.md  JOURNAL_FORMAT.md
```

Log format matches obd_tui: `<date> <time.ms> <TAG> key=value ...`
(KEYS, S, STEP, DTC, DTC_NEW, FF, MISFIRE, ANOM, BATT, STAT, RESULT, LOG).

## Stages

0. **Spike (1 evening)** — one page: BLE connect → ELM init → poll 010C/0123/0105 → log to IndexedDB →
   export (Share / Download / Copy). Test in Bluefy and Chrome on Mac.
   Risks to check early: BLE poll rate, Share/Download in Bluefy,
   page sleeping on screen lock (Screen Wake Lock).
1. **Core in TS** — port from Python: PID decoders, DTC 03/07/0A, freeze frame, Mode 06 misfires, anomalies,
   scenarios. Tests (vitest) with real logs as fixtures.
2. **UI** — mobile-first: big buttons, step card, live charts (uPlot), battery, log list.
3. **Deploy** — GitHub Actions → GitHub Pages (`artyrian.github.io/obdy`). ✔
4. **Later** (if needed) — auto-upload logs to a server, per-car profiles, discovered Ford DIDs, in-app log analysis.

## Open questions
- Vanilla TS or Preact.
