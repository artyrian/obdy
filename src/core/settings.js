// Poll/log settings: which PIDs, how often each one is polled, how often S lines are written.
// Pure functions + a tiny localStorage wrapper — tested with `node --test`.

// `every` = min ms between polls of that PID; 0 = every cycle (as fast as the adapter allows).
export const PID_OPTIONS = [
  { c: "010C", label: "RPM", on: true, every: 0 },
  { c: "0123", label: "Fuel rail", on: true, every: 0 },
  { c: "0106", label: "STFT", on: true, every: 0 },
  { c: "0134", label: "Lambda", on: true, every: 0 },
  { c: "0144", label: "Lambda cmd", on: true, every: 1000 },
  { c: "0104", label: "Load", on: true, every: 0 },
  { c: "0111", label: "Throttle", on: true, every: 1000 },
  { c: "010D", label: "Speed", on: true, every: 1000 },
  { c: "0105", label: "Coolant", on: true, every: 5000 },
  { c: "0107", label: "LTFT", on: true, every: 10000 },
  { c: "0142", label: "Voltage", on: true, every: 5000 },
  { c: "010B", label: "MAP", on: false, every: 1000 },
  { c: "0110", label: "MAF", on: false, every: 1000 },
  { c: "010E", label: "Timing", on: false, every: 1000 },
  { c: "010F", label: "Intake air", on: false, every: 10000 },
  { c: "0133", label: "Baro", on: false, every: 30000 },
  { c: "013C", label: "Catalyst", on: false, every: 5000 },
  { c: "0146", label: "Ambient", on: false, every: 30000 },
  { c: "012F", label: "Fuel level", on: false, every: 30000 },
];

export const EVERY_CHOICES = [0, 1000, 2000, 5000, 10000, 30000];
export const LOG_CHOICES = [500, 1000, 2000, 5000];
export const WINDOW_CHOICES = [2, 5, 15, 30]; // chart window, minutes

export const LABEL = Object.fromEntries(PID_OPTIONS.map((p) => [p.c, p.label]));

export function defaults() {
  return {
    v: 1,
    logEvery: 1000,   // min ms between S lines (deadband can add extra lines)
    deadband: true,   // extra S line when a fast value jumps
    window: 5,        // chart window, minutes
    pids: Object.fromEntries(PID_OPTIONS.map((p) => [p.c, { on: p.on, every: p.every }])),
  };
}

/** Merge stored settings over defaults; unknown keys dropped, RPM always on (liveness check). */
export function normalize(raw) {
  const d = defaults();
  if (!raw || typeof raw !== "object") return d;
  if (LOG_CHOICES.includes(raw.logEvery)) d.logEvery = raw.logEvery;
  if (typeof raw.deadband === "boolean") d.deadband = raw.deadband;
  if (WINDOW_CHOICES.includes(raw.window)) d.window = raw.window;
  for (const c of Object.keys(d.pids)) {
    const p = raw.pids?.[c];
    if (!p) continue;
    if (typeof p.on === "boolean") d.pids[c].on = p.on;
    if (EVERY_CHOICES.includes(p.every)) d.pids[c].every = p.every;
  }
  d.pids["010C"].on = true;
  return d;
}

export const enabled = (cfg) => PID_OPTIONS.map((p) => p.c).filter((c) => cfg.pids[c]?.on);

/** PIDs to poll this cycle, in table order (RPM first). `last` = {pid: ms of last poll}. */
export function due(cfg, last, now) {
  return enabled(cfg).filter((c) => now - (last[c] ?? -Infinity) >= cfg.pids[c].every);
}

/** ms until the next PID is due (0 = something is due now). */
export function nextDueIn(cfg, last, now) {
  let m = Infinity;
  for (const c of enabled(cfg)) m = Math.min(m, (last[c] ?? -Infinity) + cfg.pids[c].every - now);
  return Math.max(0, m);
}

/** Rough log growth, KB per hour of recording (S lines only; DTC/misfire lines add ~5%). */
export function estimateKbPerHour(cfg, cycleMs = 120) {
  const lineMs = Math.max(cfg.logEvery, cycleMs);
  const lines = 3_600_000 / lineMs;
  let fields = 0;
  for (const c of enabled(cfg)) fields += Math.min(1, lineMs / Math.max(cfg.pids[c].every, cycleMs));
  const bytes = lines * (42 + fields * 13) * (cfg.deadband ? 1.3 : 1);
  return Math.round(bytes / 1024);
}

/** Compact form for the CFG journal line. */
export function describe(cfg) {
  const kv = { log_ms: cfg.logEvery, deadband: cfg.deadband ? 1 : 0 };
  for (const c of enabled(cfg)) kv[c] = cfg.pids[c].every;
  return kv;
}

const KEY = "obdy.settings";

export function load(storage = globalThis.localStorage) {
  try { return normalize(JSON.parse(storage?.getItem(KEY) || "null")); } catch { return defaults(); }
}

export function save(cfg, storage = globalThis.localStorage) {
  try { storage?.setItem(KEY, JSON.stringify(cfg)); } catch { /* private mode etc. */ }
}
