// OBD-II decoding: mode 01 PIDs, DTCs (03/07/0A), freeze frame (02), mode 06 misfires.
// Pure functions, no DOM — tested with `node --test`.

export const KPA_PSI = 0.145038;

export const u16 = (b) => (b && b.length >= 2 ? (b[0] << 8) | b[1] : null);

export function hexToBytes(hex) {
  if (!hex || hex.length % 2 || /[^0-9a-f]/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** Strip reply prefix ("410C") and return payload bytes, or null. */
export function dataBytes(resp, prefix) {
  if (!resp || !resp.startsWith(prefix)) return null;
  return hexToBytes(resp.slice(prefix.length));
}

export function replyPrefix(cmd) {
  const c = cmd.toUpperCase();
  if (c.startsWith("01")) return "41" + c.slice(2, 4);
  if (c.startsWith("22")) return "62" + c.slice(2, 6);
  return "";
}

// pid -> [name, unit, fn(bytes)]
export const PIDS = {
  0x01: ["MIL / DTC count", "", (b) => b[0] & 0x7f],
  0x04: ["Engine load", "%", (b) => (b[0] * 100) / 255],
  0x05: ["Coolant temp", "°C", (b) => b[0] - 40],
  0x06: ["STFT bank 1", "%", (b) => ((b[0] - 128) * 100) / 128],
  0x07: ["LTFT bank 1", "%", (b) => ((b[0] - 128) * 100) / 128],
  0x0a: ["Fuel pressure (gauge)", "kPa", (b) => b[0] * 3],
  0x0b: ["Intake MAP", "kPa", (b) => b[0]],
  0x0c: ["RPM", "rpm", (b) => u16(b) / 4],
  0x0d: ["Speed", "km/h", (b) => b[0]],
  0x0e: ["Timing advance", "°", (b) => b[0] / 2 - 64],
  0x0f: ["Intake air temp", "°C", (b) => b[0] - 40],
  0x10: ["MAF", "g/s", (b) => u16(b) / 100],
  0x11: ["Throttle", "%", (b) => (b[0] * 100) / 255],
  0x22: ["Fuel rail press. rel. manifold", "kPa", (b) => u16(b) * 0.079],
  0x23: ["Fuel rail press. (DI high side)", "kPa", (b) => u16(b) * 10],
  0x2f: ["Fuel level", "%", (b) => (b[0] * 100) / 255],
  0x33: ["Baro", "kPa", (b) => b[0]],
  0x34: ["Lambda B1S1 (wideband)", "λ", (b) => (u16(b) * 2) / 65536],
  0x3c: ["Catalyst temp B1S1", "°C", (b) => u16(b) / 10 - 40],
  0x42: ["Module voltage", "V", (b) => u16(b) / 1000],
  0x44: ["Commanded lambda", "λ", (b) => (u16(b) * 2) / 65536],
  0x46: ["Ambient temp", "°C", (b) => b[0] - 40],
  0x59: ["Fuel rail absolute press.", "kPa", (b) => u16(b) * 10],
};

/** -> {name, unit, value|null} */
export function decode(cmd, b) {
  const c = cmd.toUpperCase();
  if (c.startsWith("01") && c.length === 4) {
    const def = PIDS[parseInt(c.slice(2), 16)];
    if (def) {
      if (!b) return { name: def[0], unit: def[1], value: null };
      const v = def[2](b);
      return { name: def[0], unit: def[1], value: Number.isFinite(v) ? v : null };
    }
  }
  if (c.startsWith("22")) {
    if (!b) return { name: "Ford DID", unit: "raw", value: null };
    if (b.length === 1) return { name: "Ford DID", unit: "raw", value: b[0] };
    if (b.length === 2) return { name: "Ford DID", unit: "raw", value: u16(b) };
    return { name: "Ford DID", unit: "raw", value: null };
  }
  return { name: "", unit: "", value: null };
}

export function fmt(v, unit) {
  if (v == null) return "";
  if (unit === "kPa") return `${v.toFixed(0)} kPa / ${(v * KPA_PSI).toFixed(0)} psi`;
  if (unit === "λ") return v.toFixed(3);
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** DTC list from 43/47/4A reply (CAN: leading count byte). */
export function parseDtcs(resp, prefix) {
  let b = dataBytes(resp, prefix);
  if (!b) return [];
  if (b.length % 2 === 1) b = b.slice(1);
  const out = [];
  for (let i = 0; i + 1 < b.length; i += 2) {
    const b0 = b[i], b1 = b[i + 1];
    if (!b0 && !b1) continue;
    out.push("PCBU"[b0 >> 6] + ((b0 >> 4) & 3) + (b0 & 0xf).toString(16).toUpperCase()
      + b1.toString(16).toUpperCase().padStart(2, "0"));
  }
  return out;
}

/** CAN mode 06 reply: 46 + records [MID TID UASID V(2) MIN(2) MAX(2)] -> Map("mid:tid" -> value) */
export function parseMode06(resp) {
  const out = new Map();
  if (!resp || !resp.startsWith("46")) return out;
  const b = hexToBytes(resp.slice(2));
  if (!b) return out;
  for (let i = 0; i + 8 < b.length; i += 9) out.set(`${b[i]}:${b[i + 1]}`, u16(b.slice(i + 3, i + 5)));
  return out;
}

export const MISFIRE_MIDS = [[0xa1, "all"], [0xa2, "cyl1"], [0xa3, "cyl2"], [0xa4, "cyl3"], [0xa5, "cyl4"]];

/** Supported-PID bitmap reply (4100/4120/4140) -> Set of pid numbers. */
export function parseSupported(resp, base) {
  const b = dataBytes(resp, "41" + base.toString(16).toUpperCase().padStart(2, "0"));
  const out = new Set();
  if (!b || b.length < 4) return out;
  for (let i = 0; i < 32; i++) if (b[i >> 3] & (0x80 >> (i & 7))) out.add(base + i + 1);
  return out;
}

/** Clean raw ELM text buffer: drop echo, prompt, SEARCHING..., join ISO-TP frames. */
export function cleanElm(buf, sent) {
  let lines = buf.replace(/>/g, "").replace(/\r/g, "\n").split("\n").map((l) => l.trim())
    .filter((l) => l && l !== sent && !l.startsWith("SEARCHING"));
  if (lines.length > 1 && lines.slice(1).every((l) => l.includes(":"))) {
    lines = lines.slice(1).map((l) => l.split(":").slice(1).join(":"));
  }
  return lines.join("").replace(/\s+/g, "");
}
