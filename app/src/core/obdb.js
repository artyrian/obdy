// OBDb (https://github.com/OBDb, CC BY-SA 4.0) signal sets: manufacturer-specific PIDs/DIDs per make/model.
// Pure helpers: parse a signalset for a model year, decode responses, VIN helpers. Tested with `node --test`.

export const RAW_URL = (repo) => `https://raw.githubusercontent.com/OBDb/${repo}/main/signalsets/v3/default.json`;
export const REPO_URL = (repo) => `https://github.com/OBDb/${repo}`;

const UNITS = {
  kilopascal: "kPa", celsius: "°C", fahrenheit: "°F", percent: "%", volts: "V", amps: "A", psi: "psi",
  kilometers: "km", liters: "L", seconds: "s", degrees: "°", rpm: "rpm", scalar: "", offon: "", noyes: "", unknown: "",
  kilometersPerHour: "km/h", gramsPerSecond: "g/s", milliseconds: "ms", hours: "h", minutes: "min",
};
export const unitLabel = (u) => (u in UNITS ? UNITS[u] : u || "");

/** Journal/tile key for a signal id ("[ECU] HPFP Desired" -> "x.ECU_HPFP_Desired"). */
export const keyOf = (id) => "x." + String(id).replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "");

const inYears = (f, y) => !!f && ((f.years || []).includes(y) || (f.from != null && y >= f.from) || (f.to != null && y <= f.to));

/**
 * Commands that apply to a model year. -> [{ key, hdr, cmd, every, verified, signals: [{ key, id, name, path, unit, fmt }] }]
 * `filter` restricts years; `dbgfilter`/`dbg` mark entries not verified for that year (still usable, flagged).
 */
export function commandsFor(signalset, year) {
  const out = [];
  for (const c of signalset?.commands || []) {
    const [svc, did] = Object.entries(c.cmd || {})[0] || [];
    if (!svc || !did || !c.hdr) continue;
    if (c.filter && year && !inYears(c.filter, year)) continue;
    const verified = !c.dbg && !(year && inYears(c.dbgfilter, year));
    const cmd = `${svc}${did}`.toUpperCase();
    out.push({
      key: `${c.hdr}.${cmd}`, hdr: c.hdr.toUpperCase(), cmd, every: Math.max(1000, Math.round((c.freq || 1) * 1000)), verified,
      signals: (c.signals || []).map((s) => ({ key: keyOf(s.id), id: s.id, name: s.name || s.id, path: s.path || "Other",
        unit: unitLabel(s.fmt?.unit), fmt: s.fmt || {}, description: s.description || "" })),
    });
  }
  return out;
}

/** Read `len` bits at bit index `bix` (MSB-first) from bytes. */
export function bits(bytes, bix, len) {
  let v = 0n;
  for (let i = 0; i < len; i++) {
    const b = bix + i, byte = bytes[b >> 3];
    if (byte == null) return null;
    v = (v << 1n) | BigInt((byte >> (7 - (b & 7))) & 1);
  }
  return Number(v);
}

/** Decode one signal from the payload after the service+DID echo. Returns number, string (mapped) or null. */
export function decodeSignal(fmt, payload) {
  const len = fmt.len ?? 8, bix = fmt.bix ?? 0;
  let raw = bits(payload, bix, len);
  if (raw == null) return null;
  if (fmt.map) {
    const m = fmt.map[String(raw)];
    if (m != null) return typeof m === "object" ? m.description ?? m.value ?? String(raw) : m;
  }
  if (fmt.sign && raw >= 2 ** (len - 1)) raw -= 2 ** len;
  const v = (raw * (fmt.mul ?? 1)) / (fmt.div ?? 1) + (fmt.add ?? 0);
  if (fmt.nullmax != null && v > fmt.nullmax) return null; // "not available" marker (e.g. tire sensor missing)
  return Math.round(v * 1e5) / 1e5;
}

/** Payload bytes of a positive response to a mode 22 (or 21/01) request, or null. "62 05 48 03 2A" -> [0x03, 0x2A]. */
export function payloadOf(resp, cmd) {
  if (!resp) return null;
  const echo = (parseInt(cmd.slice(0, 2), 16) + 0x40).toString(16).toUpperCase() + cmd.slice(2);
  const i = resp.toUpperCase().indexOf(echo);
  if (i < 0) return null;
  const hex = resp.slice(i + echo.length).replace(/[^0-9A-Fa-f]/g, "");
  const out = [];
  for (let k = 0; k + 1 < hex.length; k += 2) out.push(parseInt(hex.slice(k, k + 2), 16));
  return out;
}

/** VIN from a mode 09 PID 02 reply (after cleanElm): "4902" + count + 17 ASCII bytes. */
export function parseVin(resp) {
  const r = (resp || "").toUpperCase().replace(/[^0-9A-F]/g, "");
  const i = r.indexOf("4902");
  if (i < 0) return null;
  let hex = r.slice(i + 4);
  if (/^0[0-9]/.test(hex) && hex.length >= 36) hex = hex.slice(2); // message count byte
  let s = "";
  for (let k = 0; k + 1 < hex.length; k += 2) {
    const ch = String.fromCharCode(parseInt(hex.slice(k, k + 2), 16));
    if (/[A-HJ-NPR-Z0-9]/.test(ch)) s += ch;
  }
  return s.length >= 17 ? s.slice(-17) : null;
}

const YEAR_CODES = "ABCDEFGHJKLMNPRSTVWXY123456789";
/** Model year from VIN position 10 (30-year cycle; picks the latest year not in the future). */
export function vinYear(vin, now = new Date().getFullYear() + 1) {
  const i = YEAR_CODES.indexOf((vin || "")[9]);
  if (i < 0) return null;
  let y = 2010 + i;
  while (y > now) y -= 30;
  return y;
}

// minimal offline fallback when vPIC can't be reached (WMI/VDS prefix -> make, model)
const OFFLINE = [["1FA6P8", "Ford", "Mustang"], ["1FA", "Ford", null], ["1FM", "Ford", null], ["1FT", "Ford", null],
  ["5YJ", "Tesla", null], ["7SA", "Tesla", null], ["1G1", "Chevrolet", null], ["JT", "Toyota", null], ["1HG", "Honda", null]];
export function offlineDecode(vin) {
  const hit = OFFLINE.find(([p]) => (vin || "").startsWith(p));
  return { make: hit?.[1] || null, model: hit?.[2] || null, year: vinYear(vin) };
}

const titleCase = (s) => s.toLowerCase().replace(/(^|[\s-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
/** OBDb repo names to try for a make/model, most specific first: ["Ford-Mustang", "Ford"]. */
export function repoCandidates(make, model) {
  if (!make) return [];
  const mk = titleCase(make.trim()).replace(/\s+/g, "-");
  const out = [];
  if (model) out.push(`${mk}-${model.trim().replace(/\s+/g, "-")}`);
  out.push(mk);
  return out;
}
