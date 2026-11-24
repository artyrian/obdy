# obdy

OBD-II сканер в браузере для BLE-адаптеров ELM327 (проверен под UniCarScan UCSI-2100), Ford Mustang 2.3 EcoBoost.
Только клиент: статика, без сервера и сборки.

**▶ https://artyrian.github.io/obdy/**

- **iPhone:** браузер [Bluefy](https://apps.apple.com/app/id1492822055) (Safari/Chrome на iOS не умеют Web Bluetooth).
- **Mac/Windows/Android:** Chrome или Edge.

## Запуск локально

```sh
python3 -m http.server 8000   # Chrome: http://localhost:8000  (localhost = можно Bluetooth без HTTPS)
npm test                      # тесты ядра (node --test), зависимостей нет
```

«Демо» работает без адаптера.

## Что умеет (0.1.0-alpha)

- Live: обороты, температура, давление в рампе, STFT/LTFT, лямбда, нагрузка, напряжение; скорость опроса.
- Запись: журнал ~1 строка/с (чаще при изменениях), ошибки и пропуски по цилиндрам каждые 20 с,
  freeze frame при новой ошибке, Wake Lock чтобы экран не гас.
- Ошибки: 03/07/0A, freeze frame, Mode 06 пропуски по цилиндрам.
- Журналы хранятся в IndexedDB сразу; экспорт: Поделиться / Скачать / Копировать.

## Журнал

`<date> <time.ms> <TAG> key=value ...` — тот же формат, что у `tools/obd_tui.py`.
Теги: SESSION CONN ELM KEYS S STEP DTC DTC_NEW FF MISFIRE ANOM BATT LOG.

```sh
grep -E " (DTC_NEW|ANOM|MISFIRE) " obd_*.log
```

## Структура

```
index.html
favicon.svg/.ico · apple-touch-icon.png
src/app.js              UI
src/core/               pids.js (декодеры) · elm.js (протокол) · journal.js
src/transport/          ble.js (Web Bluetooth) · fake.js (демо)
tests/                  node --test
tools/obd_tui.py        Python TUI (dev-инструмент: сканы DID, diff)
docs/PLAN.md
```

## Деплой

https://artyrian.github.io/obdy/ — деплой на каждый push в `main` через `.github/workflows/pages.yml`
(тесты → Pages). Разово: Settings → Pages → Source: **GitHub Actions**.

Версия: `VERSION` в `src/app.js` = `version` в `package.json` (сверяет тест).
