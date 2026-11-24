import { Elm } from "./core/elm.js";
import { KPA_PSI, dataBytes, decode, fmt, parseDtcs, replyPrefix } from "./core/pids.js";
import { Journal, listSessions, sessionText, deleteSession } from "./core/journal.js";
import { BleTransport, bleAvailable } from "./transport/ble.js";
import { FakeTransport } from "./transport/fake.js";
import * as settings from "./core/settings.js";
import { refFor, status as refStatus } from "./core/refs.js";
import * as guide from "./core/guide.js";
import { Series, draw, rateLabel } from "./ui/chart.js";

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
const preLog = []; // lines logged before the journal exists (BLE connect steps) — flushed into it
function log(msg) {
  const el = $("log");
  el.textContent = `${new Date().toLocaleTimeString()}  ${msg}\n` + el.textContent.slice(0, 20000);
  if (st.j) st.j.w("LOG", { msg });
  else preLog.push(msg) > 50 && preLog.shift();
}

function toast(msg) { log(msg); $("status").textContent = msg; setTimeout(updateStatus, 2500); }

function updateStatus() {
  $("status").textContent = st.elm ? `● ${st.transport.name}${st.recording ? " · recording" : ""}` : "not connected";
}

function setConnected(on) {
  $("connect").hidden = on; $("demo").hidden = on; $("disconnect").hidden = !on;
  $("rec").hidden = !on; $("read-diag").disabled = !on;
  updateStatus();
  updateGuideUI();
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
  const open = st.open;
  $("tiles").innerHTML = "";
  for (const c of settings.enabled(st.cfg)) {
    const d = document.createElement("div");
    d.className = "tile"; d.id = "t" + c;
    d.tabIndex = 0; d.setAttribute("role", "button"); d.setAttribute("aria-expanded", "false");
    d.innerHTML = `<div class="t-head"><span class="k"></span><span class="hz" title="actual poll rate"></span></div>
      <div class="t-val"><span class="v">—</span><span class="u"></span></div>
      <canvas class="spark" aria-hidden="true"></canvas><div class="mm"></div><div class="ref"></div>`;
    d.querySelector(".k").textContent = labelOf(c);
    d.onclick = () => toggleTile(c);
    d.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleTile(c); } };
    $("tiles").append(d);
    if (st.latest[c] != null) showTile(c, st.latest[c], unitOf(c));
  }
  if (open) toggleTile(open, true);
}

function toggleTile(c, force) {
  const t = $("t" + c);
  if (!t) { st.open = null; return; }
  const big = force ?? !t.classList.contains("big");
  $("tiles").querySelectorAll(".tile.big").forEach((x) => { x.classList.remove("big"); x.setAttribute("aria-expanded", "false"); });
  t.classList.toggle("big", big);
  t.setAttribute("aria-expanded", String(big));
  st.open = big ? c : null;
  drawCharts();
  if (big) t.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function showTile(c, v, unit) {
  if (v != null) {
    const mm = st.minmax[c] || [v, v];
    st.minmax[c] = [Math.min(mm[0], v), Math.max(mm[1], v)];
  }
  const t = $("t" + c);
  if (!t) return;
  const ve = t.querySelector(".v");
  ve.textContent = fmtDisp(dispVal(v, unit), unit);
  const stt = refStatus(c, v, st.latest);
  ve.className = "v " + (stt || "");
  if (stt === "bad" && st.refBad?.[c] !== "bad" && st.recording) { // log each excursion once
    st.j.w("ANOM", { rule: `ref_${c}`, msg: `${labelOf(c)} ${fmtDisp(dispVal(v, unit), unit)} ${dispUnit(unit)} out of range` });
    log(`⚠ ${labelOf(c)} ${fmtDisp(dispVal(v, unit), unit)} ${dispUnit(unit)} out of range`);
  }
  (st.refBad ??= {})[c] = stt;
  const r = refFor(c, st.latest);
  const f0 = (x) => fmtDisp(dispVal(x, unit), unit);
  t.querySelector(".ref").textContent = r ? `ref ${f0(r.lo)}–${f0(r.hi)}${r.label ? " · " + r.label : ""}` : "";
  t.querySelector(".u").textContent = v == null ? "" : dispUnit(unit);
  if (st.minmax[c] && !t.classList.contains("big")) {
    const f = (x) => fmtDisp(dispVal(x, unit), unit);
    t.querySelector(".mm").textContent = `min ${f(st.minmax[c][0])} · max ${f(st.minmax[c][1])}`;
  }
}

// ---------------------------------------------------------------- connection
async function connect(demo) {
  if (st.connecting) return;
  st.connecting = true;
  $("connect").disabled = $("demo").disabled = true;
  hideError();
  const step = (m) => { $("status").textContent = m; log(m); };
  try {
    const tr = demo ? new FakeTransport() : new BleTransport(log);
    step(demo ? "starting demo…" : "choose the adapter…");
    await tr.connect(); // BLE: requestDevice is its first await (needs this click)
    tr.onDisconnect = () => { log("adapter disconnected"); st.j?.w("CONN", { event: "lost" }); teardown(); };
    st.transport = tr;
    st.elm = new Elm(tr);
    st.j = new Journal(Journal.newId());
    await st.j.start({ app: VERSION, adapter: tr.name, demo: !!demo, ua: navigator.userAgent.slice(0, 220) });
    for (const msg of preLog.splice(0)) st.j.w("LOG", { msg });
    st.j.w("CONN", { event: "connected", name: tr.name, service: tr.service || "-" });
    step("initialising ELM327…");
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
    st.minmax = {}; st.lastPoll = {}; st.latest = {}; st.unwritten = {}; st.alive = undefined;
    buildTiles();
    pollLoop();
    if (st.cfg.autoRecord) await startRecording();
  } catch (e) {
    const cancelled = e.name === "NotFoundError" && /cancel/i.test(e.message);
    log(`connect failed: ${e.name}: ${e.message}`);
    st.j?.w("CONN", { event: "failed", err: e.message });
    if (!st.j) preLog.length = 0;
    try { await st.transport?.close(); } catch { /* ignore */ }
    st.elm = st.transport = null;
    $("status").textContent = "not connected";
    if (!cancelled) showError(`Connection failed: ${e.message}`);
  } finally {
    st.connecting = false;
    $("connect").disabled = !bleAvailable();
    $("demo").disabled = false;
  }
}

function showError(msg) {
  const el = $("err");
  el.querySelector(".msg").textContent = msg;
  el.hidden = false;
}
function hideError() { $("err").hidden = true; }

async function teardown() {
  st.polling = false;
  if (st.guide) await finishGuide(true, true); // adapter gone: no after-snapshot
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
    const fastStep = guide.active(st.guide)?.fast;
    const list = settings.due(st.cfg, st.lastPoll, now0)
      .filter((c) => isSupported(c) || ((st.lastPoll[c] = now0), false))
      // fast guided steps: only the fast set every cycle, the rest at most every 10 s
      .filter((c) => !fastStep || guide.FAST.has(c) || now0 - (st.lastPoll[c] ?? 0) >= 10000);
    if (!list.length) { await guideTick({}, st.alive !== false); await sleep(Math.min(250, settings.nextDueIn(st.cfg, st.lastPoll, Date.now()) || 20)); continue; }
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
    const lost = !alive && st.alive !== false; // log the ECU going silent once, not every second
    st.alive = alive;
    if (alive) delete st.unwritten.ecu;
    if (st.recording) {
      const jump = st.cfg.deadband && now - st.lastW >= DEADBAND_MIN_MS && moved(st.lastVals, st.unwritten);
      if (alive ? now - st.lastW >= st.cfg.logEvery || jump : lost) {
        const phase = guide.active(st.guide)?.id;
        st.j.sample(st.unwritten, { sess: st.sess, ...(phase ? { phase } : {}), t: ((now - st.t0) / 1000).toFixed(2) });
        st.lastW = now; st.lastVals = { ...st.lastVals, ...st.unwritten }; st.unwritten = {};
      }
      if (alive && now - st.lastDtc > DTC_POLL_MS) { st.lastDtc = now; await pollDtcMisfires(); }
    } else st.unwritten = {};
    if (st.elm && now - st.lastBatt > BATT_POLL_MS) { st.lastBatt = now; await pollBattery(st.latest["010C"]); }
    await guideTick(vals, alive);
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
  if (st.guide && !st.guide.finishing) await finishGuide(true, !st.elm);
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

function drawCharts() {
  if (!visible("live")) return;
  const now = Date.now(), windowMs = st.cfg.window * 60000;
  for (const t of $("tiles").querySelectorAll(".tile")) {
    const c = t.id.slice(1), unit = unitOf(c), s = seriesOf(c);
    s.trim(now - 30 * 60000);
    const big = t.classList.contains("big");
    t.querySelector(".hz").textContent = rateLabel(s.t, now);
    const r = refFor(c, st.latest);
    const band = r ? [dispVal(r.lo, unit), dispVal(r.hi, unit)] : null;
    const ref = c === "0134" && st.cfg.pids["0144"]?.on ? seriesOf("0144") : null; // commanded lambda
    draw(t.querySelector("canvas"), s, { now, windowMs, big, band, ref, gapMs: gapOf(c), fmtY: (y) => fmtDisp(y, unit) });
    if (big) {
      const pts = s.since(now - windowMs).v;
      t.querySelector(".mm").textContent = !pts.length ? (isSupported(c) ? "no data yet" : "not supported by this car")
        : `last ${st.cfg.window} min: min ${fmtDisp(Math.min(...pts), unit)} · max ${fmtDisp(Math.max(...pts), unit)} · ${pts.length} pts`;
    } else if (!isSupported(c)) t.querySelector(".mm").textContent = "not supported";
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
  $("set-autorec").checked = cfg.autoRecord;
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
  syncWindow();
  if (st.recording) st.j.w("CFG", settings.describe(st.cfg));
}

$("set-log").onchange = (e) => { st.cfg.logEvery = Number(e.target.value); applySettings(); };
$("set-deadband").onchange = (e) => { st.cfg.deadband = e.target.checked; applySettings(); };
$("set-autorec").onchange = (e) => { st.cfg.autoRecord = e.target.checked; applySettings(); };
$("set-window").onchange = (e) => { st.cfg.window = Number(e.target.value); applySettings(); };
$("chart-window").onchange = (e) => { st.cfg.window = Number(e.target.value); applySettings(); };
$("set-reset").onclick = () => { if (confirm("Reset settings to defaults?")) { st.cfg = settings.defaults(); applySettings(); } };
function syncWindow() { fillSelect($("chart-window"), settings.WINDOW_CHOICES, st.cfg.window, (v) => `${v} min`); }


// ---------------------------------------------------------------- guided test
const STEP_MARK = { pending: "○", active: "▶", done: "✔", skipped: "–" };

function renderPresets() {
  const el = $("g-presets");
  el.innerHTML = "";
  for (const [id, p] of Object.entries(guide.PRESETS)) {
    const b = document.createElement("button");
    b.className = "preset"; b.type = "button";
    b.innerHTML = `<div class="p-head"><b></b><span class="muted small"></span></div><div class="small p-desc"></div>
      <ol class="small muted"></ol>`;
    b.querySelector("b").textContent = p.label;
    b.querySelector(".p-head span").textContent = p.time;
    b.querySelector(".p-desc").textContent = p.desc;
    for (const s of p.steps()) { const li = document.createElement("li"); li.textContent = s.title; b.querySelector("ol").append(li); }
    b.onclick = () => startGuide(id);
    el.append(b);
  }
  updateGuideUI();
}

async function startGuide(preset) {
  if (!st.elm) { toast("connect the adapter (or Demo) first"); return; }
  if (st.guide) return;
  if (!st.recording) await startRecording();
  const run = guide.newRun(preset, Date.now());
  run.sess = st.sess;
  st.j.w("STEP", { sess: st.sess, id: "begin", event: "start", preset });
  $("g-status").textContent = "reading DTCs and misfire counters…";
  st.guide = run; // set before the snapshot so the UI switches immediately
  updateGuideUI();
  run.before = { dtc: await st.elm.dtcs(), mis: await st.elm.misfires() };
  for (const [type, x] of Object.entries(run.before.dtc)) st.j.w("DTC", { tag: "before", sess: st.sess, type, codes: x.codes.join(",") || "-" });
  for (const [cyl, m] of Object.entries(run.before.mis)) st.j.w("MISFIRE", { tag: "before", sess: st.sess, cyl, cycle: m.cycle ?? "", avg10: m.avg10 ?? "" });
  const v = await st.elm.voltage();
  if (v != null) st.j.w("BATT", { v, tag: "before" });
  run.stepT0 = run.last = Date.now();
  stepStart(run);
  log(`guided test: ${guide.PRESETS[preset].label}`);
}

function stepStart(run) {
  const s = guide.active(run);
  if (s) st.j.w("STEP", { sess: run.sess, id: s.id, event: "start", title: s.title });
  updateGuideUI();
}

async function guideTick(fresh, alive) {
  const run = st.guide;
  if (!run || !run.before || run.finishing) return;
  const prev = guide.active(run);
  const r = guide.tick(run, { now: Date.now(), alive, latest: st.latest, fresh });
  if (prev && prev.state !== "active") stepEnd(run, prev);
  if (r) updateGuideUI(r);
  if (!guide.active(run)) await finishGuide();
}

function stepEnd(run, s) {
  st.j.w("STEP", { sess: run.sess, id: s.id, event: s.state, t: (s.t ?? 0).toFixed(1), status: s.msg || "" });
  log(`step ${s.id}: ${s.state}`);
  stepStart(run);
}

function guideNext() {
  const run = st.guide;
  if (!run?.before) return;
  const s = guide.active(run);
  if (!s) return;
  guide.advance(run, Date.now(), s.manual ? "done" : "skipped");
  stepEnd(run, s);
  if (!guide.active(run)) finishGuide();
}

async function finishGuide(stopped = false, noSnapshot = false) {
  const run = st.guide;
  if (!run || run.finishing) return;
  run.finishing = true;
  $("g-status").textContent = "reading DTCs and misfire counters again — keep the engine running…";
  const res = { stopped, dtc: null, mis: null };
  const alive = !noSnapshot && run.before && st.elm && dataBytes(await st.elm.cmd("010C", 2000), "410C") != null;
  if (alive) {
    res.dtc = await st.elm.dtcs();
    res.mis = await st.elm.misfires();
    for (const [type, x] of Object.entries(res.dtc)) {
      st.j.w("RESULT", { sess: run.sess, what: `dtc_${type}`, before: run.before.dtc[type]?.codes.join(",") || "-", after: x.codes.join(",") || "-" });
    }
    for (const [cyl, m] of Object.entries(res.mis)) {
      st.j.w("RESULT", { sess: run.sess, what: "misfire", cyl, before: run.before.mis[cyl]?.cycle ?? "", after: m.cycle ?? "" });
    }
    const v = await st.elm?.voltage();
    if (v != null) st.j.w("BATT", { v, tag: "after" });
  } else if (st.j) st.j.w("RESULT", { sess: run.sess, what: "after_snapshot", status: "skipped_ecu_off" });
  for (const [phase, keys] of Object.entries(run.stats)) {
    for (const [k, x] of Object.entries(keys)) {
      st.j?.w("STAT", { sess: run.sess, phase, key: k, min: +x.min.toFixed(3), mean: +(x.sum / x.n).toFixed(3), max: +x.max.toFixed(3), n: x.n });
    }
  }
  st.j?.w("STEP", { sess: run.sess, id: "end", event: stopped ? "stopped" : "done" });
  log(`guided test ${stopped ? "stopped" : "done"}`);
  st.lastGuide = { run, res };
  st.guide = null;
  updateGuideUI();
  renderGuideResult();
}

function updateGuideUI(r) {
  const run = st.guide;
  $("g-pick").hidden = !!run;
  $("g-run").hidden = !run;
  $("gbar").hidden = !run;
  document.querySelectorAll(".preset").forEach((b) => (b.disabled = !st.elm));
  $("g-hint").hidden = !!st.elm;
  if (!run) return;
  const s = guide.active(run);
  const n = run.steps.length, i = Math.min(run.i + 1, n);
  $("g-title").textContent = s ? s.title : "Finishing…";
  $("g-count").textContent = `${guide.PRESETS[run.preset].label} · step ${i}/${n}`;
  $("g-text").textContent = s ? s.text : "";
  if (r) {
    $("g-bar").style.width = `${(r.p * 100).toFixed(0)}%`;
    $("g-status").textContent = r.msg;
  } else $("g-bar").style.width = "0%";
  $("g-next").textContent = s?.manual ? "Finish ✔" : "Skip ›";
  $("g-next").disabled = !s || !run.before;
  $("gb-step").textContent = s ? `${i}/${n} · ${s.title}` : "Finishing…";
  $("gb-status").textContent = r?.msg ?? "";
  $("gb-next").textContent = $("g-next").textContent;
  $("gb-next").disabled = $("g-next").disabled;
  const ol = $("g-list");
  ol.innerHTML = "";
  for (const x of run.steps) {
    const li = document.createElement("li");
    li.className = x.state;
    li.innerHTML = `<span class="mk"></span><span class="tt"></span><span class="muted small"></span>`;
    li.querySelector(".mk").textContent = STEP_MARK[x.state];
    li.querySelector(".tt").textContent = x.title;
    li.querySelector(".small").textContent = x.state === "done" || x.state === "skipped" ? `${(x.t ?? 0).toFixed(0)} s` : "";
    ol.append(li);
  }
}

function renderGuideResult() {
  const g = st.lastGuide;
  const el = $("g-result");
  if (!g) { el.hidden = true; return; }
  const { run, res } = g;
  const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  let h = `<h4>${esc(guide.PRESETS[run.preset].label)} test ${res.stopped ? "stopped" : "done"} ✔</h4><ol class="checklist small">`;
  for (const x of run.steps) h += `<li class="${x.state}"><span class="mk">${STEP_MARK[x.state]}</span><span class="tt">${esc(x.title)}</span><span class="muted">${x.t != null ? x.t.toFixed(0) + " s" : ""}</span></li>`;
  h += `</ol>`;
  if (res.dtc) {
    h += `<table class="small"><tr><th></th><th>before</th><th>after</th></tr>`;
    for (const [type, x] of Object.entries(res.dtc)) {
      const b = run.before.dtc[type]?.codes.join(", ") || "none", a = x.codes.join(", ") || "none";
      h += `<tr><td>${type}</td><td>${esc(b)}</td><td class="${x.codes.length ? "bad" : "ok"}">${esc(a)}</td></tr>`;
    }
    for (const [cyl, m] of Object.entries(res.mis)) {
      if (cyl === "all" && m.cycle == null) continue;
      const b = run.before.mis[cyl]?.cycle ?? "—";
      h += `<tr><td>misfires ${cyl}</td><td>${b}</td><td class="${(m.cycle ?? 0) > 0 ? "warn" : ""}">${m.cycle ?? "—"}</td></tr>`;
    }
    h += `</table>`;
  } else h += `<p class="muted small">After-test snapshot skipped: ECU not answering (engine/ignition off).</p>`;
  h += `<p class="muted small">Everything is in the current log (session ${esc(run.sess)}). Share it for review:</p>
    <div class="bar"><button id="g-share" class="primary">Share log</button><button id="g-again">New test</button></div>`;
  el.innerHTML = h;
  el.hidden = false;
  $("g-share").onclick = () => exportLog(st.j?.id, "share").catch((e) => log("export: " + e.message));
  $("g-again").onclick = () => { st.lastGuide = null; renderGuideResult(); };
}

$("g-next").onclick = guideNext;
$("gb-next").onclick = guideNext;
$("g-stop").onclick = () => { if (confirm("Stop the guided test?")) finishGuide(true); };
$("gb-open").onclick = () => showTab("diag");
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
  drawCharts();
  try { history.replaceState(null, "", "#" + name); } catch { /* ignore */ }
}
document.querySelectorAll(".tabs button").forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });
$("connect").onclick = () => connect(false);
$("err-copy").onclick = () => copyText($("log").textContent).then(() => toast("log copied"));
$("err-close").onclick = hideError;
$("demo").onclick = () => connect(true);
$("disconnect").onclick = () => teardown();
$("rec").onclick = () => (st.recording ? stopRecording() : startRecording());
$("read-diag").onclick = () => readDiag().catch((e) => log("error: " + e.message));
$("ver").textContent = VERSION;

showBanner();
renderCaps();
renderSettings();
renderPresets();
buildTiles();
syncWindow();
setInterval(drawCharts, 1000);
window.addEventListener("resize", () => drawCharts());
{
  const t = location.hash.slice(1) === "charts" ? "live" : location.hash.slice(1);
  if (document.querySelector(`.tabs button[data-tab="${t}"]`)) showTab(t);
}
