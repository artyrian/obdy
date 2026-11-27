// Report: turns a session journal (text) into a plain-language health report.
// Works on any saved log, so a report can be rebuilt later from Logs or from a shared file.
// Pure — tested with `node --test`.

import { refFor } from "./refs.js";
import { KPA_PSI, parseUdsDtcs } from "./pids.js";
import { LABEL } from "./settings.js";

const LINE_RE = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d(?:\.\d+)?) (\S+)(.*)$/;
const KV_RE = /([^\s=]+)=("([^"]*)"|\S*)/g;
const NUM_RE = /^-?\d+(\.\d+)?$/;
const TEXT_KEYS = new Set(["raw", "codes", "code", "vin", "ftb", "status", "before", "after", "probe"]); // hex/ids, never numbers
const RUNNING_RPM = 400;

/** One journal line -> { ts, tag, kv } or null. */
export function parseLine(l) {
  const m = LINE_RE.exec(l);
  if (!m) return null;
  const kv = {};
  for (const x of m[4].matchAll(KV_RE)) {
    const raw = x[3] ?? x[2];
    kv[x[1]] = x[3] == null && NUM_RE.test(raw) && !TEXT_KEYS.has(x[1]) ? Number(raw) : raw;
  }
  return { ts: new Date(`${m[1]}T${m[2]}`).getTime(), tag: m[3], kv };
}

// ---------------------------------------------------------------- plain-language texts
/** Common codes in plain words. Anything else falls back to the code family. */
export const DTC_TEXT = {
  P0008: "Engine timing (cam/crank) out of position — timing chain wear",
  P0011: "Intake cam timing over-advanced — oil level / VCT solenoid",
  P0016: "Crank and cam position don't agree — timing chain or sensor",
  P0087: "Fuel rail pressure too low",
  P0088: "Fuel rail pressure too high",
  P008A: "Low-pressure fuel system: pressure too low (in-tank pump / filter / sensor)",
  P008B: "Low-pressure fuel system: pressure too high",
  P0101: "Mass air flow sensor reading implausible — dirty MAF or intake leak",
  P0190: "Fuel rail pressure sensor circuit",
  P0191: "Fuel rail pressure sensor range/performance",
  P0192: "Fuel rail pressure sensor circuit low",
  P0193: "Fuel rail pressure sensor circuit high",
  P018A: "Low-side fuel pressure sensor (sensor B) circuit",
  P018B: "Low-side fuel pressure sensor (sensor B) range/performance",
  P018C: "Low-side fuel pressure sensor (sensor B) circuit low — sensor, wiring or connector",
  P018D: "Low-side fuel pressure sensor (sensor B) circuit high — sensor, wiring or connector",
  P018E: "Low-side fuel pressure sensor (sensor B) intermittent",
  P0113: "Intake air temperature sensor: signal high",
  P0128: "Engine warms up too slowly — thermostat stuck open",
  P0171: "Running lean (bank 1) — vacuum/intake leak, weak fuel supply, dirty MAF",
  P0172: "Running rich (bank 1) — leaking injector, high fuel pressure, MAF",
  P0174: "Running lean (bank 2)",
  P0175: "Running rich (bank 2)",
  P0234: "Turbo overboost",
  P0299: "Turbo underboost — boost leak, wastegate",
  P0300: "Random misfires",
  P0401: "EGR flow too low",
  P0420: "Catalytic converter efficiency low (bank 1)",
  P0430: "Catalytic converter efficiency low (bank 2)",
  P0442: "Small EVAP leak — often the fuel cap",
  P0455: "Large EVAP leak — fuel cap or EVAP hose",
  P0456: "Very small EVAP leak — often the fuel cap",
  P0500: "Vehicle speed sensor",
  P0505: "Idle control problem",
  P0562: "System voltage low — battery / alternator",
  P0563: "System voltage high — charging system",
  P0606: "Engine computer internal fault",
  P0700: "Transmission computer reports a fault — read the TCM",
};
const FAMILY = [
  [/^P00/, "Fuel/air or timing"], [/^P01/, "Fuel and air metering"], [/^P02/, "Fuel and air metering (injectors, boost)"],
  [/^P03/, "Ignition or misfire"], [/^P04/, "Emissions controls"], [/^P05/, "Speed, idle or electrical"],
  [/^P06/, "Engine computer or its circuits"], [/^P07|^P08|^P09/, "Transmission"], [/^P[1-3]/, "Manufacturer-specific engine code"],
  [/^B/, "Body (airbags, comfort)"], [/^C/, "Chassis (ABS, steering)"], [/^U/, "Network / module communication"],
];
export function dtcText(code) {
  if (DTC_TEXT[code]) return DTC_TEXT[code];
  const m = /^P030([1-9])$/.exec(code);
  if (m) return `Misfire in cylinder ${m[1]} — spark plug, coil or injector`;
  return FAMILY.find(([re]) => re.test(code))?.[1] ?? "Unknown code";
}

/** Why a value out of its normal range matters: [low, high] per PID. */
const EXPLAIN = {
  "0142": ["Voltage is low: weak battery, bad connection or the alternator isn't charging.",
    "Voltage is high: the charging system may be overcharging."],
  "0105": ["Engine stays cool: thermostat may be stuck open (worse economy, P0128).",
    "Engine runs hot: check the coolant level, radiator fan and thermostat."],
  "0106": ["The engine is taking fuel away (runs rich): leaking injector, high fuel pressure, purge valve or MAF.",
    "The engine is adding fuel (runs lean): air leak after the MAF, weak fuel supply or dirty MAF."],
  "0107": ["Long-term fuel trim is negative (rich): leaking injector, high fuel pressure, purge valve or MAF.",
    "Long-term fuel trim is positive (lean): air leak, weak fuel supply or dirty MAF."],
  "0134": ["Mixture is richer than the computer asks for.", "Mixture is leaner than the computer asks for."],
  "010C": ["Warm idle is low or stalls.", "Warm idle is high: air leak or idle control."],
  "013C": ["Catalyst is cold.", "Catalyst is very hot: misfires or rich running can overheat it."],
};

/** Actual vs desired pairs: actual staying below desired while running = supply can't keep up. */
const PAIRS = [
  { act: "0123", des: "x.ECU_HPFP_Desired", title: "High-pressure fuel (rail) below desired",
    why: "The high-pressure pump can't reach the pressure the engine asks for: weak low-side supply or worn HP pump." },
  { act: "x.MUSTANG_LPFP_ACT", des: "x.MUSTANG_LPFP_DES", title: "Low-side fuel pressure below desired",
    why: "The in-tank pump/filter can't keep the commanded pressure, or the low-side pressure sensor reads low (P008A, P018C)." },
];
const PAIR_LOW = 0.85; // actual < 85 % of desired
const FUEL_CUT_LAMBDA = 1.5;
const MISFIRE_BAD = 5;   // misfire counts added during a recording to call it active
const CRANK_MS = 5000;
const newStat = () => ({ n: 0, sum: 0, min: Infinity, max: -Infinity });
const addStat = (s, v) => { s.n++; s.sum += v; if (v < s.min) s.min = v; if (v > s.max) s.max = v; };
const median = (a) => { const b = [...a].sort((x, y) => x - y); return b[b.length >> 1]; };
const LEVEL = { ok: 0, warn: 1, bad: 2 };
const worst = (a, b) => (LEVEL[b] > LEVEL[a] ? b : a);

// ---------------------------------------------------------------- analysis
/**
 * Journal text -> report object:
 * { meta, verdict, codes, findings, misfires, battery, steps, keys, series, summary }
 */
export function analyze(text) {
  const meta = { app: null, adapter: null, demo: false, vin: null, car: null, profile: null, start: null, end: null, preset: null };
  const keys = {};      // key -> { name, unit }
  const series = {};    // key -> [[ts, v]]
  const acc = {};       // key -> { n, sum, min, max, ref: {n, warn, bad, low, high}, band }
  const latest = {};
  const codes = new Map();
  const mis = {};       // cyl -> { first, last, max, grew }
  const batt = { off: [], run: [] };
  const steps = [];
  const pairs = PAIRS.map((p) => ({ ...p, n: 0, low: 0, worst: null, zero: 0 }));
  let firstRun = null; // first sample with the engine running: cranking happens right before it
  let runT = 0, lastTs = null, maxEct = null, idleRpm = [];

  const code = (c) => codes.get(c) ?? (codes.set(c, { code: c, kinds: new Set(), flags: new Set(), during: false }), codes.get(c));

  for (const l of String(text).split(/\r?\n/)) {
    const x = parseLine(l);
    if (!x) continue;
    const { ts, tag, kv } = x;
    meta.start ??= ts;
    meta.end = ts;
    switch (tag) {
      case "SESSION": meta.app = kv.app ?? meta.app; meta.adapter = kv.adapter ?? meta.adapter; meta.demo ||= kv.demo === "true"; break;
      case "VEH":
        meta.vin = kv.vin && kv.vin !== "-" ? kv.vin : meta.vin;
        meta.car = [kv.year, kv.make, kv.model].filter((v) => v && v !== "-").join(" ") || meta.car;
        if (kv.engine && kv.engine !== "-") meta.engine = kv.engine;
        break;
      case "PROFILE": meta.profile = kv.repo; break;
      case "KEYS":
        for (const [k, v] of Object.entries(kv)) {
          const m = /^(.*?)\[(.*?)\]/.exec(String(v));
          keys[k] = { name: (m ? m[1] : String(v)).replace(/_/g, " "), unit: m && m[2] !== "raw" ? m[2] : "" };
        }
        break;
      case "STEP": {
        if (kv.id === "begin") { meta.preset = kv.preset; steps.length = 0; break; }
        if (kv.id === "record" || kv.id === "end") break;
        let s = steps.find((x) => x.id === kv.id);
        if (!s) steps.push((s = { id: kv.id, title: kv.title || kv.id, state: "started" }));
        if (kv.event !== "start") Object.assign(s, { state: kv.event, t: kv.t, msg: kv.status || "" });
        break;
      }
      case "DTC": {
        const kind = kv.type === "uds" ? "module" : kv.type;
        if (kv.code) { const c = code(kv.code); c.kinds.add(kind); String(kv.flags || "").split("|").filter(Boolean).forEach((f) => c.flags.add(f)); }
        if (kind === "module" && /^59/i.test(String(kv.raw ?? ""))) {
          for (const it of parseUdsDtcs(String(kv.raw))?.items ?? []) { const c = code(it.code); c.kinds.add(kind); it.flags.forEach((f) => c.flags.add(f)); }
        }
        for (const c of String(kv.codes ?? "").split(",")) if (/^[PBCU][0-9A-F]{4}$/.test(c)) code(c).kinds.add(kind);
        break;
      }
      case "DTC_NEW": { const c = code(kv.code); c.kinds.add(kv.type === "uds" ? "module" : kv.type); c.during = true; break; }
      case "RESULT":
        if (String(kv.what).startsWith("dtc_")) {
          const before = new Set(String(kv.before).split(","));
          for (const c of String(kv.after).split(",")) if (/^[PBCU][0-9A-F]{4}$/.test(c)) {
            const d = code(c); d.kinds.add(kv.what === "dtc_uds" ? "module" : kv.what.slice(4)); if (!before.has(c)) d.during = true;
          }
        } else if (kv.what === "misfire" && kv.cyl !== "all") {
          const m = (mis[kv.cyl] ??= { first: null, last: 0, max: 0, grew: false });
          if (Number(kv.after) > Number(kv.before)) m.grew = true;
          m.max = Math.max(m.max, Number(kv.after) || 0);
        }
        break;
      case "MISFIRE": {
        if (kv.cyl === "all" || kv.cycle === "" || kv.cycle == null) break;
        const m = (mis[kv.cyl] ??= { first: null, last: 0, max: 0, grew: false });
        const v = Number(kv.cycle) || 0;
        if (m.first != null && v > m.last) m.grew = true;
        m.first ??= v;
        m.last = v; m.max = Math.max(m.max, v);
        break;
      }
      case "BATT":
        if (typeof kv.v === "number" && typeof kv.rpm === "number") (kv.rpm > RUNNING_RPM ? batt.run : batt.off).push([ts, kv.v]);
        break;
      case "S": {
        for (const [k, v] of Object.entries(kv)) if (typeof v === "number" && k !== "t") latest[k] = v;
        const running = latest["010C"] > RUNNING_RPM;
        if (running) firstRun ??= ts;
        if (running && lastTs != null) runT += Math.min(5000, ts - lastTs);
        lastTs = ts;
        if (latest["0105"] != null) maxEct = Math.max(maxEct ?? -99, latest["0105"]);
        if (kv.phase === "idle" && typeof kv["010C"] === "number") idleRpm.push(kv["010C"]);
        for (const [k, v] of Object.entries(kv)) {
          if (typeof v !== "number" || k === "t") continue;
          (series[k] ??= []).push([ts, v]);
          const a = (acc[k] ??= { all: newStat(), run: newStat(), ref: { n: 0, warn: 0, bad: 0, low: 0, high: 0 }, labels: new Map() });
          addStat(a.all, v);
          if (running) addStat(a.run, v);
          // wideband pegged lean on deceleration = injectors off (fuel cut), not a lean engine
          if (k === "0134" && (v >= FUEL_CUT_LAMBDA || latest["0144"] >= FUEL_CUT_LAMBDA)) continue;
          const r = refFor(k, latest);
          if (r) {
            const out = (b) => b && (v < b[0] || v > b[1]);
            a.ref.n++;
            if (out(r.bad)) a.ref.bad++; else if (out(r.warn)) a.ref.warn++;
            if (out(r.warn) || out(r.bad)) { if (v < r.lo) a.ref.low++; else a.ref.high++; }
            const lab = k === "0134" ? "≈ commanded ±0.03" : r.label;
            a.labels.set(lab, { band: k === "0134" ? null : [r.lo, r.hi], n: (a.labels.get(lab)?.n ?? 0) + 1 });
          }
        }
        if (running) for (const p of pairs) {
          const act = latest[p.act], des = latest[p.des];
          if (act == null || !(des > 0)) continue;
          const toPsi = (k, v) => ((keys[k]?.unit ?? (k === "0123" ? "kPa" : "")) === "kPa" ? v * KPA_PSI : v);
          // a running engine can't have ~0 fuel pressure: that's the sensor/circuit dropping out, counted apart
          if (toPsi(p.act, act) < 1) { p.zero++; continue; }
          const ratio = toPsi(p.act, act) / toPsi(p.des, des);
          p.n++;
          if (ratio < PAIR_LOW) p.low++;
          p.worst = p.worst == null ? ratio : Math.min(p.worst, ratio);
        }
        break;
      }
      default:
    }
  }

  // ---- findings
  const findings = [];
  const add = (level, title, detail, key) => findings.push({ level, title, detail, key });
  for (const [k, a] of Object.entries(acc)) {
    const r = a.ref;
    if (!EXPLAIN[k] || r.n < 5) continue;
    const badF = r.bad / r.n, offF = (r.bad + r.warn) / r.n;
    const level = badF > 0.05 ? "bad" : offF > 0.15 ? "warn" : null;
    if (!level) continue;
    const dir = r.low >= r.high ? 0 : 1;
    add(level, `${labelFor(k, keys)} ${dir ? "high" : "low"} (${Math.round(offF * 100)}% of the time)`, EXPLAIN[k][dir], k);
  }
  for (const p of pairs) {
    if (p.zero >= 2) add("bad", `${labelFor(p.act, keys)} reads 0 with the engine running (${p.zero}×)`,
      "Impossible while the engine runs: the pressure sensor, its wiring or connector drops out. Check this before replacing the pump.", p.act);
    if (p.n < 5 || p.low / p.n < 0.05) continue;
    add(p.low / p.n > 0.2 ? "bad" : "warn", p.title, `${p.why} Lowest: ${Math.round(p.worst * 100)}% of desired; below ${Math.round(PAIR_LOW * 100)}% in ${Math.round((p.low / p.n) * 100)}% of samples.`, p.act);
  }
  const misCyl = Object.entries(mis).filter(([, m]) => m.max);
  for (const [cyl, m] of misCyl) {
    const grewBy = m.first != null ? m.last - m.first : m.grew ? 1 : 0;
    const level = grewBy >= MISFIRE_BAD || m.max >= 2 * MISFIRE_BAD ? "bad" : "warn";
    add(level, `Misfires: ${cyl.replace("cyl", "cylinder ")} (${m.max} this cycle)`,
      m.grew ? `Grew during the recording${grewBy > 0 ? ` (+${grewBy})` : ""}: ${level === "bad" ? "an active misfire — spark plug, coil or injector on that cylinder" : "a few misfires; watch whether it keeps growing"}.`
        : "Counted by the engine computer this drive cycle, didn't grow while recording.", null);
  }
  if (misCyl.length >= 3) add("warn", `Misfires on ${misCyl.length} cylinders`,
    "Spread over several cylinders usually means a shared cause (fuel pressure, air leak, ignition supply), not one coil.", null);
  const offRest = batt.off.filter(([t]) => firstRun == null || t < firstRun - CRANK_MS || t > firstRun).map(([, v]) => v);
  const bOff = offRest.length ? median(offRest) : null; // cranking dips are normal, not a weak battery
  const bRun = batt.run.length ? Math.max(...batt.run.map(([, v]) => v)) : null;
  if (bOff != null && bOff < 12.2) add(bOff < 11.9 ? "bad" : "warn", `Battery ${bOff.toFixed(1)} V with the engine off`, "Weak or discharged battery: charge it and have it load-tested.", "0142");
  if (bRun != null && bRun < 13.2) add("warn", `Charging voltage only ${bRun.toFixed(1)} V`, "The alternator may not be charging. Check belt, connections and alternator output.", "0142");
  if (runT > 15 * 60000 && maxEct != null && maxEct < 75) add("warn", `Engine never warmed up (max ${maxEct.toFixed(0)} °C in ${Math.round(runT / 60000)} min)`, EXPLAIN["0105"][0], "0105");
  if (idleRpm.length >= 10) {
    const mean = idleRpm.reduce((s, v) => s + v, 0) / idleRpm.length;
    const sd = Math.sqrt(idleRpm.reduce((s, v) => s + (v - mean) ** 2, 0) / idleRpm.length);
    if (sd > 75) add("warn", `Unstable idle (±${sd.toFixed(0)} rpm)`, "RPM hunts at idle: air leak, dirty throttle body or misfire.", "010C");
  }

  // ---- codes
  const codeList = [...codes.values()].map((c) => {
    const kinds = [...c.kinds], flags = [...c.flags];
    const confirmed = c.kinds.has("stored") || c.kinds.has("permanent") || flags.some((f) => /confirmed|failed now|check engine/.test(f));
    return { code: c.code, text: dtcText(c.code), kinds, flags, during: c.during, level: confirmed ? "bad" : "warn" };
  }).sort((a, b) => LEVEL[b.level] - LEVEL[a.level] || a.code.localeCompare(b.code));

  findings.sort((a, b) => LEVEL[b.level] - LEVEL[a.level]);
  for (let i = steps.length - 1; i >= 0; i--) if (steps[i].state === "started") steps.splice(i, 1);
  let verdict = "ok";
  for (const f of findings) verdict = worst(verdict, f.level);
  for (const c of codeList) verdict = worst(verdict, c.level);

  const summary = {};
  for (const [k, a] of Object.entries(acc)) {
    // engine-off zeros (rpm 0, load 0) would drag the averages: use running samples when there are any
    const st = a.run.n >= 3 && k !== "0142" ? a.run : a.all;
    const top = [...a.labels].sort((x, y) => y[1].n - x[1].n)[0];
    summary[k] = { min: st.min, mean: st.sum / st.n, max: st.max, n: st.n, running: st === a.run,
      band: top?.[1].band ?? null, bandLabel: top?.[0] || "" };
  }
  return {
    meta: { ...meta, durationS: meta.start ? Math.round((meta.end - meta.start) / 1000) : 0, runningS: Math.round(runT / 1000) },
    verdict, codes: codeList, findings, misfires: mis, battery: { off: bOff, run: bRun }, steps, keys, series, summary,
  };
}

const SHORT = { "x.MUSTANG_LPFP_ACT": "Low-side fuel pressure", "x.MUSTANG_LPFP_DES": "Low-side desired",
  "x.ECU_HPFP_Desired": "Rail pressure desired", "x.ECU_LPFP_duty_cycle": "Fuel pump duty" };
const REF_KEYS = new Set(["0144", "x.MUSTANG_LPFP_DES", "x.ECU_HPFP_Desired"]); // shown as dashed lines, not rows
export function labelFor(k, keys = {}) {
  return LABEL[k] || SHORT[k] || keys[k]?.name || k;
}

/** Key values worth showing even when fine, in display order. */
export const CORE_KEYS = ["0142", "0105", "010C", "0106", "0107", "0134", "0123", "x.MUSTANG_LPFP_ACT", "0104"];

export const VERDICT_TEXT = {
  ok: "No problems found",
  warn: "Worth a look",
  bad: "Problem found",
};

const unitTxt = (k, keys) => {
  const u = keys[k]?.unit ?? "";
  return u === "kPa" ? "psi" : u;
};
const valTxt = (k, v, keys) => {
  const u = keys[k]?.unit ?? "";
  if (u === "kPa") return (v * KPA_PSI).toFixed(0);
  if (u === "λ") return v.toFixed(3);
  if (u === "V") return v.toFixed(1);
  if (v === 0) return "0";
  return Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1);
};
export const fmtKey = (k, v, keys) => (v == null ? "—" : `${valTxt(k, v, keys)} ${unitTxt(k, keys)}`.trim());

/** Compact plain-text report (Markdown) — for sharing and as the AI input. */
export function toText(rep) {
  const m = rep.meta, out = [];
  const when = m.start ? new Date(m.start).toLocaleString() : "";
  out.push(`# obdy report — ${VERDICT_TEXT[rep.verdict]}`);
  out.push(`Car: ${m.car || "unknown"}${m.engine ? ` ${m.engine}` : ""}${m.vin ? ` · VIN ${m.vin}` : ""}`);
  out.push(`Recorded: ${when} · ${Math.round(m.durationS / 60)} min (engine running ${Math.round(m.runningS / 60)} min)${m.preset ? ` · guided test: ${m.preset}` : ""}${m.demo ? " · DEMO DATA" : ""}`);
  out.push("", "## Trouble codes");
  if (!rep.codes.length) out.push("- none");
  for (const c of rep.codes) out.push(`- ${c.code} — ${c.text} [${c.kinds.join(", ")}${c.flags.length ? `; ${c.flags.join(", ")}` : ""}${c.during ? "; appeared during recording" : ""}]`);
  out.push("", "## Findings");
  if (!rep.findings.length) out.push("- values stayed in normal ranges");
  for (const f of rep.findings) out.push(`- [${f.level}] ${f.title}: ${f.detail}`);
  out.push("", "## Values while the engine ran (min / mean / max)");
  for (const k of orderedKeys(rep)) {
    const s = rep.summary[k];
    out.push(`- ${labelFor(k, rep.keys)}: ${fmtKey(k, s.min, rep.keys)} / ${fmtKey(k, s.mean, rep.keys)} / ${fmtKey(k, s.max, rep.keys)}${normalTxt(k, s, rep.keys) ? ` (normal ${normalTxt(k, s, rep.keys)})` : ""}`);
  }
  out.push("Lambda readings at fuel cut (coasting) are excluded from the lambda checks.");
  if (rep.steps.some((s) => s.state === "done" || s.state === "skipped")) {
    out.push("", "## Test steps");
    for (const s of rep.steps) out.push(`- ${s.title}: ${s.state}${s.t != null ? ` (${Math.round(s.t)} s)` : ""}`);
  }
  return out.join("\n") + "\n";
}

/** "85–105 °C when warm", "≈ commanded ±0.03", or "" when there's no reference. */
export function normalTxt(k, s, keys) {
  if (!s.band) return s.bandLabel || "";
  const cond = { "warm idle": "at warm idle", warm: "when warm", "warming up": "when warm", charging: "engine running", "engine off": "engine off" }[s.bandLabel];
  return `${fmtKey(k, s.band[0], keys)}–${fmtKey(k, s.band[1], keys)}${cond ? ` ${cond}` : ""}`;
}

/** Keys for the values table: core first, then the rest with data. */
export function orderedKeys(rep, max = 14) {
  const have = Object.keys(rep.summary).filter((k) => rep.summary[k].n >= 3 && !REF_KEYS.has(k)
    && !(rep.summary[k].min === 0 && rep.summary[k].max === 0) && !/MISF_ACCEL|SENS_V|sensor_voltage/i.test(k));
  const core = CORE_KEYS.filter((k) => have.includes(k));
  return [...core, ...have.filter((k) => !core.includes(k))].slice(0, max);
}

/** Prompt for an external AI chat: instructions + the compact report. */
export function aiPrompt(rep) {
  return `You are an experienced automotive diagnostic technician. Below is a report from obdy, an OBD-II app,
recorded on my car with a Bluetooth ELM327 adapter. Explain in plain words for a car owner (not a mechanic):
1) what is most likely wrong, ranked by likelihood; 2) how urgent it is and whether it's safe to drive;
3) cheap checks I can do myself first; 4) what to tell the mechanic. Use only the data below, say when it's
not enough to be sure, and don't invent values. Keep it short.

${toText(rep)}`;
}
