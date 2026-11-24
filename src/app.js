import { Elm } from "./core/elm.js";
import { KPA_PSI, dataBytes, decode, fmt, parseDtcs, replyPrefix } from "./core/pids.js";
import { Journal, listSessions, sessionText, deleteSession } from "./core/journal.js";
import { BleTransport, bleAvailable } from "./transport/ble.js";
import { FakeTransport } from "./transport/fake.js";
import * as settings from "./core/settings.js";
import { Series, draw } from "./ui/chart.js";

const VERSION = "0.1.0-alpha"; // keep in sync with package.json (checked by tests)
const BLUEFY_URL = "https://apps.apple.com/app/id1492822055";

// write an extra S line when one of these moved by at least this much
// thresholds sit above normal idle jitter so a steady engine doesn't bloat the log
const DEADBAND = { "010C": 150, "0123": 300, "0111": 3, "0104": 5, "010D": 3 }; // trims/lambda oscillate by design
const DEADBAND_MIN_MS = 250; // at most 4 extra lines/s
const DTC_POLL_MS = 20000;
const BATT_POLL_MS = 15000;

const $ = (id) => document.getElementById(id);
const st = { elm: null, transport: null, j: null, polling: false, recording: false, wake: null,
  minmax: {}, lastW: 0, lastVals: {}, lastDtc: 0, lastBatt: 0, dtcSeen: new Set(), misLive: {}, t0: 0,
  cfg: settings.load(), lastPoll: {}, latest: {}, unwritten: {}, series: {}, units: {} };

// ---------------------------------------------------------------- env
const ua = navigator.userAgent;
const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isAndroid = /Android/.test(ua);

function caps() {
  const f = typeof File !== "undefined" ? new File(["x"], "x.log", { type: "text/plain" }) : null;
  return {
    "Web Bluetooth": bleAvailable(),
    "Share file": !!(navigator.canShare && f && navigator.canShare({ files: [f] })),
    "Share text": !!navigator.share,
    "Clipboard": !!navigator.clipboard?.writeText,
    "Keep screen on (Wake Lock)": "wakeLock" in navigator,
    "Storage (IndexedDB)": typeof indexedDB !== "undefined",
    "HTTPS / localhost": window.isSecureContext,
  };
}

function showBanner() {
  const b = $("banner");
  if (bleAvailable()) return;
  if (isIOS) {
    b.innerHTML = `<b>Bluefy browser required.</b> Safari and Chrome on iPhone can't talk to Bluetooth adapters.
      <div class="bar"><a href="${BLUEFY_URL}" target="_blank" rel="noopener"><button class="primary">Get Bluefy on the App Store</button></a>
      <button id="copy-url">Copy link to this page</button></div>
      <div class="small">Install Bluefy and open this page there. Demo works here too.</div>`;
    $("copy-url").onclick = () => copyText(location.href).then(() => toast("Link copied"));
  } else if (isAndroid) {
    b.innerHTML = `<b>Open in Chrome.</b> This browser doesn't support Bluetooth adapters.`;
  } else if (!window.isSecureContext) {
    b.innerHTML = `<b>HTTPS or localhost required</b> for Bluetooth access.`;
  } else {
    b.innerHTML = `<b>Open in Chrome or Edge.</b> This browser doesn't support Web Bluetooth.`;
  }
  b.hidden = false;
  $("connect").disabled = true;
}

// ---------------------------------------------------------------- log / ui helpers
function log(msg) {
  const el = $("log");
  el.textContent = `${new Date().toLocaleTimeString()}  ${msg}\n` + el.textContent.slice(0, 20000);
  st.j?.w("LOG", { msg });
}

function toast(msg) { log(msg); $("status").textContent = msg; setTimeout(updateStatus, 2500); }

function updateStatus() {
  $("status").textContent = st.elm ? `● ${st.transport.name}${st.recording ? " · recording" : ""}` : "not connected";
}

function setConnected(on) {
  $("connect").hidden = on; $("demo").hidden = on; $("disconnect").hidden = !on;
  $("rec").hidden = !on; $("read-diag").disabled = !on;
  updateStatus();
}

// kPa is shown as psi everywhere in the UI (journal keeps kPa)
const dispUnit = (unit) => (unit === "kPa" ? "psi" : unit);
const dispVal = (v, unit) => (v == null ? null : unit === "kPa" ? v * KPA_PSI : v);
const fmtDisp = (v, unit) => (v == null ? "—" : unit === "kPa" ? v.toFixed(0) : unit === "λ" ? v.toFixed(3)
  : Math.abs(v) >= 100 || Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1));
const unitOf = (c) => st.units[c] ?? (st.units[c] = decode(c, null).unit);
const labelOf = (c) => settings.LABEL[c] || c;
// unknown until connected; RPM is always polled (liveness check)
const isSupported = (c) => c === "010C" || !st.supported || st.supported.has(parseInt(c.slice(2), 16));

function buildTiles() {
  $("tiles").innerHTML = "";
  for (const c of settings.enabled(st.cfg)) {
    const d = document.createElement("div");
    d.className = "tile"; d.id = "t" + c;
    d.innerHTML = `<div class="k"></div><div><span class="v">—</span><span class="u"></span></div>
      <canvas class="spark" aria-hidden="true"></canvas><div class="mm"></div>`;
    d.querySelector(".k").textContent = labelOf(c);
    d.onclick = () => openChart(c);
    $("tiles").append(d);
  }
}

function showTile(c, v, unit) {
  if (v != null) {
    const mm = st.minmax[c] || [v, v];
    st.minmax[c] = [Math.min(mm[0], v), Math.max(mm[1], v)];
  }
  const t = $("t" + c);
  if (!t) return;
  t.querySelector(".v").textContent = fmtDisp(dispVal(v, unit), unit);
  t.querySelector(".u").textContent = v == null ? "" : dispUnit(unit);
  if (st.minmax[c]) {
    const f = (x) => fmtDisp(dispVal(x, unit), unit);
    t.querySelector(".mm").textContent = `min ${f(st.minmax[c][0])} · max ${f(st.minmax[c][1])}`;
  }
}

// ---------------------------------------------------------------- connection
async function connect(demo) {
  try {
    const tr = demo ? new FakeTransport() : new BleTransport();
    $("status").textContent = "connecting…";
    await tr.connect();
    tr.onDisconnect = () => { log("adapter disconnected"); st.j?.w("CONN", { event: "lost" }); teardown(); };
    st.transport = tr;
    st.elm = new Elm(tr);
    st.j = new Journal(Journal.newId());
    await st.j.start({ app: VERSION, adapter: tr.name, demo: !!demo, ua: navigator.userAgent.slice(0, 120) });
    st.j.w("CONN", { event: "connected", name: tr.name, service: tr.service || "-" });
    const { ati, probe } = await st.elm.init(log);
    st.j.w("ELM", { ati, probe });
    if (!probe.startsWith("41")) log("⚠ ECU not responding — turn ignition on");
    st.supported = probe.startsWith("41") ? await st.elm.supported().catch(() => null) : null;
    if (st.supported?.size) {
      const off = settings.enabled(st.cfg).filter((c) => !isSupported(c));
      if (off.length) log(`not supported by this car: ${off.map(labelOf).join(", ")}`);
    } else st.supported = null;
    renderSettings();
    setConnected(true);
    st.minmax = {}; st.lastPoll = {}; st.latest = {}; st.unwritten = {};
    buildTiles();
    pollLoop();
  } catch (e) {
    log("connect failed: " + e.message);
    $("status").textContent = "not connected";
  }
}

async function teardown() {
  st.polling = false;
  await stopRecording();
  try { await st.transport?.close(); } catch { /* ignore */ }
  st.j?.w("SESSION", { event: "end" });
  await st.j?.flush();
  st.elm = st.transport = null;
  setConnected(false);
  renderLogs();
}

// ---------------------------------------------------------------- polling + recording
function moved(prev, cur) {
  return Object.entries(DEADBAND).some(([k, d]) =>
    typeof prev[k] === "number" && typeof cur[k] === "number" && Math.abs(prev[k] - cur[k]) >= d);
}

async function pollLoop() {
  st.polling = true;
  let n = 0, tRate = performance.now();
  while (st.polling && st.elm) {
    const now0 = Date.now();
    const list = settings.due(st.cfg, st.lastPoll, now0).filter((c) => isSupported(c) || ((st.lastPoll[c] = now0), false));
    if (!list.length) { await sleep(Math.min(250, settings.nextDueIn(st.cfg, st.lastPoll, Date.now()) || 20)); continue; }
    const vals = {};
    let alive = true;
    for (const c of list) {
      if (!st.polling || !st.elm) return;
      const r = await st.elm.cmd(c, 2000);
      const t = Date.now();
      st.lastPoll[c] = t;
      const b = dataBytes(r, replyPrefix(c));
      if (c === "010C" && !b) { alive = false; vals.ecu = r || "none"; break; }
      const d = decode(c, b);
      st.units[c] = d.unit;
      vals[c] = d.value;
      if (d.value != null) st.latest[c] = d.value;
      showTile(c, d.value, d.unit);
      seriesOf(c).push(t, dispVal(d.value, d.unit));
      n++;
    }
    Object.assign(st.unwritten, vals);
    const now = Date.now();
    const dt = (performance.now() - tRate) / 1000;
    if (dt > 2) {
      $("rate").textContent = `${(n / dt).toFixed(1)} cmd/s · ${st.elm.rate.toFixed(0)} ms/cmd`;
      n = 0; tRate = performance.now();
    }
    if (st.recording) {
      const jump = st.cfg.deadband && now - st.lastW >= DEADBAND_MIN_MS && moved(st.lastVals, st.unwritten);
      if (now - st.lastW >= st.cfg.logEvery || jump || !alive) {
        st.j.sample(st.unwritten, { sess: st.sess, t: ((now - st.t0) / 1000).toFixed(2) });
        st.lastW = now; st.lastVals = { ...st.lastVals, ...st.unwritten }; st.unwritten = {};
      }
      if (alive && now - st.lastDtc > DTC_POLL_MS) { st.lastDtc = now; await pollDtcMisfires(); }
    } else st.unwritten = {};
    if (st.elm && now - st.lastBatt > BATT_POLL_MS) { st.lastBatt = now; await pollBattery(st.latest["010C"]); }
    if (!alive) { st.latest["010C"] = 0; await sleep(1000); }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollBattery(rpm) {
  const v = await st.elm.voltage();
  if (v == null) return;
  const running = rpm > 400;
  let cls = "", state;
  if (running) { state = v >= 13.2 ? "charging" : "not charging?"; cls = v >= 13.2 ? "" : "warn"; }
  else {
    state = "engine off";
    if (v < 12.0) { cls = "bad"; state = "low — start engine or turn ignition off"; }
    else if (v < 12.3) cls = "warn";
  }
  $("batt").textContent = `🔋 ${v.toFixed(1)} V`;
  $("batt").className = "pill " + cls;
  $("batt").title = state;
  st.j?.w("BATT", { v, rpm: rpm ?? 0, state });
  if (cls === "bad") log(`⚠ battery ${v.toFixed(2)} V — ${state}`);
}

async function pollDtcMisfires() {
  const vals = st.latest;
  const rpm = vals["010C"];
  if (rpm > 400) {
    const mis = await st.elm.misfires();
    for (const [cyl, m] of Object.entries(mis)) {
      if (cyl === "all" || m.cycle == null) continue;
      st.j.w("MISFIRE", { tag: "live", sess: st.sess, cyl, cycle: m.cycle, rpm, ect: vals["0105"] ?? "" });
      if (m.cycle > (st.misLive[cyl] ?? 0)) {
        st.j.w("ANOM", { rule: `misfire_${cyl}`, msg: `misfires ${cyl}: ${st.misLive[cyl] ?? 0}->${m.cycle}` });
        log(`⚠ misfires ${cyl}: ${m.cycle}`);
      }
      st.misLive[cyl] = m.cycle;
    }
  }
  for (const [m, type] of [["07", "pending"], ["03", "stored"]]) {
    for (const code of parseDtcs(await st.elm.cmd(m, 5000), "4" + m[1])) {
      if (st.dtcSeen.has(code)) continue;
      st.dtcSeen.add(code);
      st.j.w("DTC_NEW", { sess: st.sess, type, code, rpm: rpm ?? 0, ect: vals["0105"] ?? "" });
      log(`⚠ new DTC ${code} (${type})`);
      const ff = await st.elm.freezeFrame();
      if (ff) st.j.w("FF", { sess: st.sess, ...ff });
    }
  }
}

async function startRecording() {
  st.sess = "r" + Journal.newId().slice(9);
  st.t0 = Date.now(); st.lastW = 0; st.lastDtc = 0; st.misLive = {};
  const keys = {};
  for (const c of settings.enabled(st.cfg)) {
    const d = decode(c, null);
    keys[c] = `${d.name.replace(/[ /.]+/g, "_")}[${d.unit || "raw"}]`;
  }
  st.j.w("STEP", { sess: st.sess, id: "record", event: "start" });
  st.j.w("KEYS", keys);
  st.j.w("CFG", settings.describe(st.cfg));
  st.unwritten = {}; st.lastVals = {};
  const d = await st.elm.dtcs();
  st.dtcSeen = new Set(Object.values(d).flatMap((x) => x.codes));
  for (const [type, x] of Object.entries(d)) st.j.w("DTC", { tag: "before", type, codes: x.codes.join(",") || "-", raw: x.raw });
  st.recording = true;
  $("rec").classList.add("on"); $("rec").textContent = "■ Stop";
  await wakeLock(true);
  updateStatus();
  log(`recording ${st.sess}`);
}

async function stopRecording() {
  if (!st.recording) return;
  st.recording = false;
  $("rec").classList.remove("on"); $("rec").textContent = "● Record";
  st.j.w("STEP", { sess: st.sess, id: "record", event: "stop", t: ((Date.now() - st.t0) / 1000).toFixed(1) });
  await wakeLock(false);
  await st.j.flush();
  updateStatus();
  log(`recording ${st.sess} stopped`);
}

async function wakeLock(on) {
  try {
    if (on && "wakeLock" in navigator) {
      st.wake = await navigator.wakeLock.request("screen");
      st.j?.w("LOG", { msg: "wake lock on" });
    } else if (!on && st.wake) { await st.wake.release(); st.wake = null; }
  } catch (e) { log("wake lock: " + e.message); }
}

document.addEventListener("visibilitychange", async () => {
  st.j?.w("LOG", { msg: `visibility ${document.visibilityState}` });
  if (document.visibilityState === "visible" && st.recording) await wakeLock(true);
});

// ---------------------------------------------------------------- diagnostics tab
async function readDiag() {
  const out = $("diag-out");
  out.textContent = "reading…";
  const d = await st.elm.dtcs();
  const mis = await st.elm.misfires();
  const ff = await st.elm.freezeFrame();
  for (const [type, x] of Object.entries(d)) st.j.w("DTC", { tag: "read", type, codes: x.codes.join(",") || "-", raw: x.raw });
  for (const [cyl, m] of Object.entries(mis)) st.j.w("MISFIRE", { tag: "read", cyl, cycle: m.cycle ?? "", avg10: m.avg10 ?? "" });
  if (ff) st.j.w("FF", ff);
  const names = { stored: "Stored", pending: "Pending", permanent: "Permanent" };
  let h = `<div class="card"><h4>DTCs</h4><table>`;
  for (const [type, x] of Object.entries(d)) {
    h += `<tr><td>${names[type]}</td><td class="code ${x.codes.length ? "bad" : "ok"}">${x.codes.join(", ") || "none"}</td></tr>`;
  }
  h += `</table></div><div class="card"><h4>Misfires by cylinder</h4>
    <table><tr><th></th><th>this/last cycle</th><th>avg of 10</th></tr>`;
  for (const [cyl, m] of Object.entries(mis)) {
    if (cyl === "all" && m.cycle == null) continue;
    const bad = (m.cycle ?? 0) > 0 || (m.avg10 ?? 0) > 0;
    h += `<tr><td>${cyl}</td><td class="${bad ? "warn" : ""}">${m.cycle ?? "—"}</td><td>${m.avg10 ?? "—"}</td></tr>`;
  }
  h += `</table></div>`;
  if (ff) {
    h += `<div class="card"><h4>Freeze frame: ${ff.dtc}</h4><table>`;
    for (const [k, v] of Object.entries(ff)) {
      if (k === "dtc") continue;
      const dd = decode(k, null);
      h += `<tr><td>${dd.name}</td><td>${fmt(v, dd.unit)} ${dd.unit === "kPa" ? "" : dd.unit}</td></tr>`;
    }
    h += `</table></div>`;
  }
  out.innerHTML = h;
}

// ---------------------------------------------------------------- journals tab
async function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const ta = document.createElement("textarea");
  ta.value = text; document.body.append(ta); ta.select(); document.execCommand("copy"); ta.remove();
}

async function exportLog(id, how) {
  const text = st.j?.id === id ? st.j.text() : await sessionText(id);
  const name = `obd_${id}.log`;
  try {
    if (how === "share") {
      const file = new File([text], name, { type: "text/plain" });
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: name });
      else if (navigator.share) await navigator.share({ title: name, text });
      else throw new Error("Share not supported — use Download or Copy");
    } else if (how === "download") {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
      a.download = name; document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } else if (how === "copy") {
      await copyText(text);
      toast(`copied ${text.split("\n").length - 1} lines`);
    }
  } catch (e) {
    if (e.name !== "AbortError") log(`export (${how}): ${e.message}`);
  }
}

async function renderLogs() {
  const el = $("logs");
  const sessions = await listSessions().catch(() => []);
  if (!sessions.length) { el.innerHTML = `<p class="muted">No logs yet — connect an adapter.</p>`; return; }
  el.innerHTML = "";
  for (const s of sessions) {
    const row = document.createElement("div");
    row.className = "card logrow";
    const d = new Date(s.started);
    row.innerHTML = `<div><b></b><div class="muted small"></div></div>
      <div class="bar"><button data-a="share">Share</button><button data-a="download">Download</button>
      <button data-a="copy">Copy</button><button data-a="del">✕</button></div>`;
    row.querySelector("b").textContent = d.toLocaleString();
    row.querySelector(".small").textContent = `${s.adapter || ""}${s.demo ? " · demo" : ""} · ${s.id}`;
    row.querySelectorAll("button").forEach((b) => {
      b.onclick = async () => {
        if (b.dataset.a === "del") {
          if (st.j?.id === s.id) return toast("can't delete the active log");
          if (confirm("Delete log?")) { await deleteSession(s.id); renderLogs(); }
        } else exportLog(s.id, b.dataset.a);
      };
    });
    el.append(row);
  }
}


// ---------------------------------------------------------------- charts tab
const seriesOf = (c) => st.series[c] ?? (st.series[c] = new Series());
const visible = (tab) => !$("tab-" + tab).hidden && document.visibilityState === "visible";
const gapOf = (c) => Math.max(10000, 3 * (st.cfg.pids[c]?.every || 0));

function buildCharts() {
  const el = $("charts");
  const open = el.querySelector(".chart.big")?.dataset.c;
  el.innerHTML = "";
  for (const c of settings.enabled(st.cfg)) {
    const d = document.createElement("button");
    d.className = "chart"; d.dataset.c = c; d.type = "button";
    d.setAttribute("aria-expanded", "false");
    d.innerHTML = `<div class="ch-head"><span class="k"></span><span class="cv"></span></div>
      <canvas></canvas><div class="ch-foot muted small"></div>`;
    d.querySelector(".k").textContent = labelOf(c);
    d.onclick = () => toggleChart(d);
    el.append(d);
    if (c === open) toggleChart(d, true);
  }
  drawCharts();
}

function toggleChart(card, force) {
  const big = force ?? !card.classList.contains("big");
  $("charts").querySelectorAll(".chart.big").forEach((x) => { x.classList.remove("big"); x.setAttribute("aria-expanded", "false"); });
  card.classList.toggle("big", big);
  card.setAttribute("aria-expanded", String(big));
  if (big) card.scrollIntoView({ block: "nearest", behavior: "smooth" });
  drawCharts();
}

function openChart(c) {
  showTab("charts");
  const card = $("charts").querySelector(`.chart[data-c="${c}"]`);
  if (card) toggleChart(card, true);
}

function drawCharts() {
  const now = Date.now(), windowMs = st.cfg.window * 60000;
  if (visible("live")) {
    for (const cv of $("tiles").querySelectorAll("canvas.spark")) {
      const c = cv.parentElement.id.slice(1);
      draw(cv, seriesOf(c), { now, windowMs, gapMs: gapOf(c) });
    }
  }
  if (!visible("charts")) return;
  for (const card of $("charts").querySelectorAll(".chart")) {
    const c = card.dataset.c, unit = unitOf(c), s = seriesOf(c);
    s.trim(now - 30 * 60000);
    const big = card.classList.contains("big");
    draw(card.querySelector("canvas"), s, { now, windowMs, big, gapMs: gapOf(c), fmtY: (y) => fmtDisp(y, unit) });
    const pts = s.since(now - windowMs).v;
    const last = pts.at(-1);
    card.querySelector(".cv").textContent = last == null ? "—" : `${fmtDisp(last, unit)} ${dispUnit(unit)}`;
    card.querySelector(".ch-foot").textContent = !pts.length ? (isSupported(c) ? "no data" : "not supported")
      : `min ${fmtDisp(Math.min(...pts), unit)} · max ${fmtDisp(Math.max(...pts), unit)}${big ? ` · ${pts.length} pts` : ""}`;
  }
}

// ---------------------------------------------------------------- settings tab

function fillSelect(sel, choices, value, label) {
  sel.innerHTML = "";
  for (const v of choices) {
    const o = document.createElement("option");
    o.value = String(v); o.textContent = label(v); o.selected = v === value;
    sel.append(o);
  }
}

function renderSettings() {
  const cfg = st.cfg;
  fillSelect($("set-log"), settings.LOG_CHOICES, cfg.logEvery, (v) => `${v / 1000} s`);
  $("set-deadband").checked = cfg.deadband;
  fillSelect($("set-window"), settings.WINDOW_CHOICES, cfg.window, (v) => `${v} min`);
  const tb = $("set-pids");
  tb.innerHTML = "";
  for (const p of settings.PID_OPTIONS) {
    const pc = cfg.pids[p.c];
    const tr = document.createElement("tr");
    const sup = isSupported(p.c);
    tr.className = pc.on ? "" : "off";
    tr.innerHTML = `<td><label class="chk"><input type="checkbox"><span></span></label></td>
      <td><select aria-label="poll interval"></select></td><td class="muted small"></td>`;
    const cb = tr.querySelector("input");
    cb.checked = pc.on; cb.disabled = p.c === "010C";
    tr.querySelector("label span").textContent = p.label;
    tr.querySelector("td.small").textContent = p.c === "010C" ? "required" : sup ? p.c : "not supported";
    const sel = tr.querySelector("select");
    fillSelect(sel, settings.EVERY_CHOICES, pc.every, (v) => (v === 0 ? "every cycle" : `every ${v / 1000} s`));
    sel.disabled = !pc.on;
    cb.onchange = () => { pc.on = cb.checked; applySettings(); };
    sel.onchange = () => { pc.every = Number(sel.value); applySettings(); };
    tb.append(tr);
  }
  const n = settings.enabled(cfg).length;
  $("set-est").textContent = `${n} values · log ≈ ${settings.estimateKbPerHour(cfg)} KB per hour of recording`;
  $("rec-note").textContent = `Recording: a sample line every ${cfg.logEvery / 1000} s`
    + `${cfg.deadband ? " (plus on sudden jumps)" : ""}, only values polled since the last line; `
    + `DTCs and misfires every ${DTC_POLL_MS / 1000} s. Saved on this device immediately.`;
}

function applySettings() {
  st.cfg = settings.normalize(st.cfg);
  settings.save(st.cfg);
  renderSettings();
  buildTiles();
  for (const c of settings.enabled(st.cfg)) {
    if (st.latest[c] != null) showTile(c, st.latest[c], unitOf(c));
  }
  buildCharts();
  if (st.recording) st.j.w("CFG", settings.describe(st.cfg));
}

$("set-log").onchange = (e) => { st.cfg.logEvery = Number(e.target.value); applySettings(); };
$("set-deadband").onchange = (e) => { st.cfg.deadband = e.target.checked; applySettings(); };
$("set-window").onchange = (e) => { st.cfg.window = Number(e.target.value); applySettings(); };
$("chart-window").onchange = (e) => { st.cfg.window = Number(e.target.value); applySettings(); syncWindow(); };
$("set-reset").onclick = () => { if (confirm("Reset settings to defaults?")) { st.cfg = settings.defaults(); applySettings(); syncWindow(); } };
function syncWindow() { fillSelect($("chart-window"), settings.WINDOW_CHOICES, st.cfg.window, (v) => `${v} min`); }

// ---------------------------------------------------------------- wiring
function renderCaps() {
  $("caps").innerHTML = "";
  for (const [k, v] of Object.entries(caps())) {
    const li = document.createElement("li");
    li.textContent = `${v ? "✅" : "❌"} ${k}`;
    $("caps").append(li);
  }
  const li = document.createElement("li");
  li.className = "muted small";
  li.textContent = navigator.userAgent;
  $("caps").append(li);
}

function showTab(name) {
  document.querySelectorAll(".tabs button").forEach((x) => {
    x.classList.toggle("on", x.dataset.tab === name);
    x.setAttribute("aria-selected", String(x.dataset.tab === name));
  });
  document.querySelectorAll(".tab").forEach((t) => (t.hidden = t.id !== "tab-" + name));
  if (name === "logs") renderLogs();
  if (name === "charts") syncWindow();
  drawCharts();
  try { history.replaceState(null, "", "#" + name); } catch { /* ignore */ }
}
document.querySelectorAll(".tabs button").forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });
$("connect").onclick = () => connect(false);
$("demo").onclick = () => connect(true);
$("disconnect").onclick = () => teardown();
$("rec").onclick = () => (st.recording ? stopRecording() : startRecording());
$("read-diag").onclick = () => readDiag().catch((e) => log("error: " + e.message));
$("ver").textContent = VERSION;

showBanner();
renderCaps();
renderSettings();
buildTiles();
buildCharts();
setInterval(drawCharts, 1000);
window.addEventListener("resize", () => drawCharts());
{
  const t = location.hash.slice(1);
  if (document.querySelector(`.tabs button[data-tab="${t}"]`)) showTab(t);
}
