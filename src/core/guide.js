// Guided tests: step-by-step checklists (ported from obd_tui's guided mode).
// Each step: check(ctx) -> { p: 0..1, msg, ok }. ctx = { t, dt, alive, rpm, ect, spd, acc }.
// `fast`: poll only the fast set (RPM, rail, trims, lambda, load, throttle) to catch short dips.
// Pure — tested with `node --test`.

const koeo = (sec) => ({
  id: "koeo", title: "Ignition ON, engine OFF",
  text: `Press Start without the brake. The fuel pump primes; rail pressure and voltage are logged. ${sec} s.`,
  check: (c) => (!c.alive
    ? { p: 0, msg: "ECU silent — turn the ignition on", ok: false }
    : { p: c.t / sec, msg: `${c.t.toFixed(0)}/${sec} s`, ok: c.t >= sec }),
});

const offon = () => ({
  id: "offon", title: "Ignition off → 10 s → on", fast: true,
  text: "Second prime: pressure builds from zero. Don't start the engine.",
  check: (c) => {
    if (!c.alive) { c.acc.off = true; return { p: 0.4, msg: "ignition off — wait 10 s, then turn it back on", ok: false }; }
    if (!c.acc.off) return { p: 0.1, msg: "turn the ignition off…", ok: false };
    c.acc.onT ??= c.t;
    const left = c.t - c.acc.onT;
    return { p: 0.5 + left / 30, msg: `back on, logging prime ${left.toFixed(0)}/15 s`, ok: left >= 15 };
  },
});

const start = (sec) => ({
  id: "start", title: "Start the engine, hands off the pedal",
  text: `Cold start + ${sec} s idle. Listen for a stumble, look at the exhaust.`,
  check: (c) => {
    if (c.rpm > 400) c.acc.run = (c.acc.run || 0) + c.dt;
    const run = c.acc.run || 0;
    return { p: run / sec, msg: run ? `running ${run.toFixed(0)}/${sec} s · ${(c.rpm || 0).toFixed(0)} rpm` : "start the engine…", ok: run >= sec };
  },
});

const warm = () => ({
  id: "warm", title: "Idle until warm (80 °C)",
  text: "Meanwhile check the coolant tank (bubbles, level) and look for leaks under the car. Skip if it takes too long.",
  check: (c) => {
    if (c.ect == null) return { p: 0, msg: "waiting for coolant temperature…", ok: false };
    c.acc.e0 ??= c.ect;
    const p = c.ect >= 80 ? 1 : (c.ect - c.acc.e0) / Math.max(1, 80 - c.acc.e0);
    return { p, msg: `coolant ${c.ect.toFixed(0)} °C → 80 °C`, ok: c.ect >= 80 };
  },
});

const hold = () => ({
  id: "hold", title: "Hold ~2500 rpm for 30 s",
  text: "Steady pedal. Rail pressure and trims under constant load.",
  check: (c) => {
    if (c.rpm > 2200 && c.rpm < 2800) c.acc.hold = (c.acc.hold || 0) + c.dt;
    const h = c.acc.hold || 0;
    return { p: h / 30, msg: `${(c.rpm || 0).toFixed(0)} rpm · in 2200–2800: ${h.toFixed(0)}/30 s`, ok: h >= 30 };
  },
});

const snap = () => ({
  id: "snap", title: "3 quick snaps to ~4000 rpm", fast: true,
  text: "Snap the throttle and release, 3 times with pauses. Fast polling catches pressure dips.",
  check: (c) => {
    c.acc.n ??= 0;
    if (c.rpm > 3500 && !c.acc.hi) { c.acc.n++; c.acc.hi = true; }
    if (c.rpm < 2000) c.acc.hi = false;
    c.acc.peak = Math.max(c.acc.peak || 0, c.rpm || 0);
    return { p: c.acc.n / 3, msg: `snaps ${c.acc.n}/3 · peak ${c.acc.peak.toFixed(0)} rpm`, ok: c.acc.n >= 3 };
  },
});

const idle = (sec) => ({
  id: "idle", title: `Idle ${sec} s`,
  text: "Hands off. Compared with the cold idle.",
  check: (c) => {
    if (c.rpm > 400 && c.rpm < 1200 && !c.spd) c.acc.idle = (c.acc.idle || 0) + c.dt;
    const i = c.acc.idle || 0;
    return { p: i / sec, msg: `idle ${i.toFixed(0)}/${sec} s · ${(c.rpm || 0).toFixed(0)} rpm`, ok: i >= sec };
  },
});

const drive = () => ({
  id: "drive", title: "Drive 10–15 min", fast: true, manual: true,
  text: "Normal driving + 2–3 pulls to 4000 rpm (load — this is where P008A shows). Press Finish when back; keep the engine running.",
  check: (c) => {
    c.acc.vmax = Math.max(c.acc.vmax || 0, c.spd || 0);
    c.acc.rmax = Math.max(c.acc.rmax || 0, c.rpm || 0);
    return { p: Math.min(1, c.t / 600), msg: `${(c.t / 60).toFixed(1)} min · max ${(c.acc.vmax * 0.621).toFixed(0)} mph, ${c.acc.rmax.toFixed(0)} rpm`, ok: false };
  },
});

export const PRESETS = {
  quick: { label: "Quick", time: "~2 min", desc: "Ignition, start, 1 min idle. Everyday check.", steps: () => [koeo(15), start(60)] },
  standard: { label: "Standard", time: "~10 min", desc: "Cold start: two fuel primes, start, warm-up, warm idle.",
    steps: () => [koeo(30), offon(), start(90), warm(), idle(60)] },
  full: { label: "Full", time: "~25 min", desc: "Standard + 2500 rpm hold, throttle snaps, idle and a drive.",
    steps: () => [koeo(30), offon(), start(90), warm(), hold(), snap(), idle(60), drive()] },
};

export const FAST = new Set(["010C", "0123", "0106", "0134", "0104", "0111"]);

/** New run state for a preset. */
export function newRun(preset, now) {
  const steps = PRESETS[preset].steps().map((s) => ({ ...s, state: "pending", msg: "" }));
  steps[0].state = "active";
  return { preset, steps, i: 0, t0: now, stepT0: now, last: now, acc: {}, stats: {} };
}

/**
 * Advance the run with the latest values. Returns { step, p, msg, ok } for the active step,
 * or null when the run is finished. Moves to the next step when ok.
 */
export function tick(run, { now, alive, latest, fresh = {} }) {
  const step = run.steps[run.i];
  if (!step) return null;
  const ctx = { t: (now - run.stepT0) / 1000, dt: Math.min(5, (now - run.last) / 1000), alive,
    rpm: alive ? latest["010C"] ?? 0 : 0, ect: latest["0105"], spd: latest["010D"], acc: run.acc };
  run.last = now;
  const st = (run.stats[step.id] ??= {});
  for (const [k, v] of Object.entries(fresh)) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const s = (st[k] ??= { n: 0, sum: 0, min: v, max: v });
    s.n++; s.sum += v; s.min = Math.min(s.min, v); s.max = Math.max(s.max, v);
  }
  const r = step.check(ctx);
  step.msg = r.msg;
  const out = { step, p: Math.max(0, Math.min(1, r.p || 0)), msg: r.msg, ok: r.ok, t: ctx.t };
  if (r.ok) advance(run, now, "done");
  return out;
}

/** Finish the active step (done/skipped) and activate the next one. Returns false when the run is over. */
export function advance(run, now, how) {
  const step = run.steps[run.i];
  if (!step) return false;
  step.state = how;
  step.t = (now - run.stepT0) / 1000;
  run.i++;
  run.stepT0 = run.last = now;
  run.acc = {};
  if (run.steps[run.i]) { run.steps[run.i].state = "active"; return true; }
  return false;
}

export const active = (run) => run?.steps[run.i] ?? null;
