// Reference ("normal") ranges per PID, in raw units (kPa, °C, V, %, λ).
// Context-aware: many values only have a meaningful target when the engine runs / is warm / idles.
// Pure functions — tested with `node --test`.

const RUNNING_RPM = 400;
const WARM_C = 80;

/** Derived context from the latest values. */
export function context(latest = {}) {
  const rpm = latest["010C"], ect = latest["0105"];
  const running = rpm > RUNNING_RPM;
  const warm = ect >= WARM_C;
  const idle = running && (latest["010D"] ?? 0) === 0 && (latest["0111"] ?? 0) < 25;
  return { running, warm, idle, lambdaCmd: latest["0144"] };
}

/**
 * -> {lo, hi, label, warn: [lo, hi], bad: [lo, hi]} or null.
 * lo/hi = normal band; outside warn = warn; outside bad = bad. Missing bound = open.
 */
export function refFor(c, latest = {}) {
  const x = context(latest);
  switch (c) {
    case "0142": // module voltage ≈ battery
      return x.running
        ? { lo: 13.5, hi: 14.8, label: "charging", warn: [13.2, 15.0], bad: [12.8, 15.5] }
        : { lo: 12.4, hi: 12.9, label: "engine off", warn: [12.2, 13.0], bad: [11.9, 15.5] };
    case "0105": // coolant
      return x.warm || latest["0105"] > 105
        ? { lo: 85, hi: 105, label: "warm", warn: [80, 108], bad: [-40, 112] }
        : { lo: 85, hi: 105, label: "warming up", warn: [-40, 108], bad: [-40, 112] };
    case "0106": case "0107": // fuel trims
      return x.running ? { lo: -10, hi: 10, label: "", warn: [-10, 10], bad: [-20, 20] } : null;
    case "0134": { // wideband lambda vs commanded
      if (!x.running) return null;
      const t = Number.isFinite(x.lambdaCmd) ? x.lambdaCmd : 1;
      return { lo: t - 0.03, hi: t + 0.03, label: `cmd ${t.toFixed(2)}`, warn: x.warm ? [t - 0.06, t + 0.06] : null, bad: null };
    }
    case "010C": // warm idle
      return x.idle && x.warm ? { lo: 600, hi: 900, label: "warm idle", warn: [550, 1000], bad: null } : null;
    case "0133": // baro, sanity
      return { lo: 94, hi: 104, label: "", warn: [90, 106], bad: null };
    case "013C": // catalyst
      return x.running ? { lo: 300, hi: 850, label: "", warn: [250, 900], bad: [0, 950] } : null;
    default:
      return null;
  }
}

/** "ok" | "warn" | "bad" | null (no reference). */
export function status(c, v, latest = {}) {
  const r = refFor(c, latest);
  if (!r || v == null) return null;
  const out = (b) => b && (v < b[0] || v > b[1]);
  if (out(r.bad)) return "bad";
  if (out(r.warn)) return "warn";
  return "ok";
}
