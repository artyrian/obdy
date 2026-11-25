# Backlog

## Positioning (draft)
"Find the intermittent problem": live charts of everything on one screen (tap to expand) + codes from the
engine module + step-by-step test + a plain-language report right away. Free, no account, data stays on the phone.
Strengths to lean on: any cheap BLE adapter, guided tests, context-aware ranges, actual-vs-desired checks, open log.

## Native app (needed to sell)
- Capacitor wrapper: keep `core/` and UI as is, swap `transport/ble.js` for a native BLE plugin
  (`@capacitor-community/bluetooth-le`); background logging on iOS (`bluetooth-central`).
- In-app purchases (StoreKit / RevenueCat); web version stays free as demo and landing.
- TestFlight on own car first; then landing page + waitlist before the paid version.


## 0.4 — other cars
- DTC fallback chain: UDS `19 02` → KWP2000 `18 02 FF 00` → OBD `03/07/0A`; log which one answered.
- Scan all modules: module addresses (`hdr`/`rax`) from the car's OBDb profile, `19 02` per module.
- CI: run the decoder against OBDb test cases of all repos (recorded real responses per model year).
- Log replay as Demo: play back a user's journal to debug a car without having it.
- Known limit: VAG PQ (pre-~2012) non-engine modules use TP2.0 — not supported by ELM327.

## Mustang
- Verify OBDb DIDs on the car (2018 mostly "unverified"): `220548` low-side actual, `22041F` desired,
  `2203DC` rail desired, `220382…038B` misfire acceleration; compare with own DID scans (`tools/obd_tui.py`).
- Check UDS `19 02` on the real PCM shows P008A (it is in the module memory).

## UI
- Less noise on the phone: fewer tiles by default, collapsible hints, compact header (status + buttons in one row).

## Infra
- Custom domain via Cloudflare (`CNAME obd.<domain> → artyrian.github.io`, DNS-only until the cert is issued).
- Releases: deploy Pages on `v*` tags instead of every push to `main`.

## Product (to verify before investing)
Hypotheses from the market scan (Nov 2026) — check each before building:
- Positioning: free scanner that walks you through a test and explains what's wrong, no subscriptions.
  Audience: owners with an intermittent problem, DIY people tired of subscriptions. Verify: talk to 5–10 such people, Reddit/forums.
- Table stakes we lack vs a basic handheld scanner: clear codes, I/M readiness (TX inspection), DTC descriptions.
- Differentiators: guided tests, context-aware ranges, module DTC memory (UDS), structured logs.
- Ideas, by expected impact:
  1. "Explain in plain words": AI report from a test log.
  2. Report for a mechanic: PDF/link in one tap.
  3. Native iOS app with background logging (removes Bluefy; needed for any public launch).
  4. All-module scan via OBDb profiles (ABS/SRS/TCM without paid brand packs).
- Not competing on: coding/adaptations, bidirectional tests.
- Verify: market prices and features; App Store review rules for OBD apps;
  OBDb CC BY-SA terms for commercial use (attribution + share-alike for the data).

## Monetization (open question)
Options to test, core scanner stays free:
- One-time Pro ($5–10): extra features (all-module scan, report history, drive recording in background).
- AI report in-app (own backend, small model, cents per report) — free version keeps "Copy for AI".
- Paid AI reports (pay per report or small subscription) — has a real cost per use, easy to justify.
- Affiliate links to recommended BLE adapters (Amazon Associates).
- Small fleets / Turo hosts: health checks for several cars, history, alerts.
- Later: own branded adapter bundle.
Verify: willingness to pay (landing page + waitlist), AI cost per report, affiliate rates.
