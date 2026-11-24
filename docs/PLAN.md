# odb_scanner — план

Свой OBD-сканер для Mustang 2.3 EcoBoost через BLE-адаптер UniCarScan UCSI-2100 (ELM327, сервис FFF0).
Прототип: `obd_tui.py` (Python + Textual + bleak) — остаётся как dev-инструмент.

## Решение

Только клиент: статический сайт (PWA), без сервера. Хостинг — GitHub Pages (бесплатный HTTPS).
- iPhone: браузер **Bluefy** (Chrome/Safari на iOS Web Bluetooth не умеют). Mac: Chrome.
- HTTPS обязателен для Web Bluetooth; локально на Mac хватает http://localhost.
- Журналы хранятся в IndexedDB браузера, экспорт: Share (AirDrop/Files) · Download · Copy.
- Ничего не ставить на рабочий Mac, нет Gatekeeper/MDM-проблем.

## Архитектура

```
web/ (Vite + TypeScript, без фреймворка или Preact)
  core/       elm.ts  pids.ts  dtc.ts  mode06.ts  anomalies.ts  scenarios.ts  journal.ts
  transport/  ble.ts (Web Bluetooth)  fake.ts (демо)  replay.ts (проигрывание журналов)
  ui/         connect · scenarios (Quick / Cold start / Drive / Fuel debug) · live · journals
tools/        obd_tui.py
docs/         PLAN.md  JOURNAL_FORMAT.md
```

Журнал — тот же формат, что в obd_tui: `<date> <time.ms> <TAG> key=value ...`
(KEYS, S, STEP, DTC, DTC_NEW, FF, MISFIRE, ANOM, BATT, STAT, RESULT, LOG).

## Этапы

0. **Spike (1 вечер)** — одна страница: BLE connect → init ELM → опрос 010C/0123/0105 → журнал в IndexedDB →
   экспорт (Share / Download / Copy). Проверить в Bluefy и Chrome на Mac.
   Риски проверить сразу: скорость опроса по BLE, работает ли Share/Download в Bluefy,
   не засыпает ли страница при блокировке экрана (Screen Wake Lock).
1. **Core на TS** — порт из Python: декодеры PID, DTC 03/07/0A, freeze frame, Mode 06 пропуски, аномалии,
   сценарии. Тесты (vitest) на реальных журналах как фикстурах.
2. **UI** — mobile-first: крупные кнопки, карточка шага, живые графики (uPlot), батарея, список журналов.
3. **Деплой** — GitHub Actions → GitHub Pages (`artyrian.github.io/odb_scanner`).
4. **Потом** (если понадобится) — автовыгрузка журнала на сервер — профили по машинам, найденные Ford DID, разбор журнала прямо в приложении.

## Открытые вопросы
- Репозиторий: публичный (Pages бесплатно) или приватный.
- Vanilla TS или Preact.
