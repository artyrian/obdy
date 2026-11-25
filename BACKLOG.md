# Backlog

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

## Integrations
- Bouncie (cellular tracker, no BLE): cloud tab via Bouncie API — DTCs, battery, fuel, odometer.
  Needs OAuth + a small backend for the client secret (e.g. Cloudflare Worker).

## Infra
- Custom domain via Cloudflare (`CNAME obd.<domain> → artyrian.github.io`, DNS-only until the cert is issued).
- Releases: deploy Pages on `v*` tags instead of every push to `main`.
