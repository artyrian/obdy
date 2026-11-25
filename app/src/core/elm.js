// ELM327 command layer over any transport with {write(str), onData(cb), close()}.
import { parseUdsDtcs, cleanElm, dataBytes, parseDtcs, parseMode06, MISFIRE_MIDS, parseSupported, decode } from "./pids.js";

export const INIT = [["ATZ", 5000], ["ATE0"], ["ATL0"], ["ATS0"], ["ATH0"], ["ATSP6"], ["ATAT2"], ["ATSH7E0"]];

export class Elm {
  constructor(transport) {
    this.t = transport;
    this.buf = "";
    this.waiter = null;
    this.queue = Promise.resolve();
    this.stats = { cmds: 0, ms: 0 };
    transport.onData((text) => {
      this.buf += text;
      if (this.buf.includes(">") && this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w();
      }
    });
  }

  /** Serialised: one command in flight at a time. Returns cleaned reply or "TIMEOUT". */
  cmd(s, timeout = 3000) {
    const run = async () => {
      this.buf = "";
      const t0 = performance.now();
      const done = new Promise((res) => {
        this.waiter = res;
        setTimeout(() => {
          if (this.waiter === res) { this.waiter = null; res("timeout"); }
        }, timeout);
      });
      await this.t.write(s + "\r");
      const r = await done;
      this.stats.cmds++;
      this.stats.ms += performance.now() - t0;
      return r === "timeout" ? "TIMEOUT" : cleanElm(this.buf, s);
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  async init(log = () => {}) {
    for (const [c, t] of INIT) {
      const r = await this.cmd(c, t || 2000);
      if (c === "ATZ" && r === "TIMEOUT" && (await this.cmd("ATI", 2000)) === "TIMEOUT") {
        throw new Error("adapter connected but doesn't answer ELM327 commands (no data on notify)");
      }
    }
    const ati = await this.cmd("ATI");
    const probe = await this.cmd("0100", 6000);
    log(`ELM ${ati} | 0100 -> ${probe}`);
    return { ati, probe };
  }

  async voltage() {
    const r = await this.cmd("ATRV", 2000);
    const v = parseFloat(r);
    return Number.isFinite(v) ? v : null;
  }

  async supported() {
    let sup = new Set();
    for (const base of [0x00, 0x20, 0x40]) {
      const s = parseSupported(await this.cmd("01" + base.toString(16).padStart(2, "0").toUpperCase()), base);
      if (!s.size) break;
      sup = new Set([...sup, ...s]);
    }
    return sup;
  }

  async dtcs() {
    const out = {};
    for (const [m, name] of [["03", "stored"], ["07", "pending"], ["0A", "permanent"]]) {
      const raw = await this.cmd(m, 5000);
      out[name] = { codes: parseDtcs(raw, "4" + m[1]), raw };
    }
    out.uds = await this.udsDtcs();
    return out;
  }

  /**
   * Module DTC memory via UDS 19 02 (what dealer tools and Car Scanner's Ford mode read): shows codes with their status
   * even when OBD modes 03/07 don't report them. Header must already point at the module (7E0 = PCM by default).
   */
  async udsDtcs() {
    let raw = "";
    for (const req of ["1902FF", "19028F", "190208"]) {
      raw = await this.cmd(req, 6000);
      const p = parseUdsDtcs(raw);
      if (p) return { ...p, raw, req };
    }
    return { items: [], codes: [], raw, req: "-", unsupported: true };
  }

  async misfires() {
    const out = {};
    for (const [mid, lab] of MISFIRE_MIDS) {
      const raw = await this.cmd("06" + mid.toString(16).toUpperCase(), 4000);
      const recs = parseMode06(raw);
      out[lab] = { cycle: recs.get(`${mid}:${0x0c}`) ?? null, avg10: recs.get(`${mid}:${0x0b}`) ?? null };
    }
    return out;
  }

  async freezeFrame() {
    const ff = dataBytes(await this.cmd("020200", 5000), "420200");
    if (!ff || ff.length < 2 || (!ff[0] && !ff[1])) return null;
    const code = parseDtcs("43" + [...ff.slice(0, 2)].map((x) => x.toString(16).padStart(2, "0")).join(""), "43");
    const out = { dtc: code[0] || "?" };
    for (const pid of [0x04, 0x05, 0x06, 0x07, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x11, 0x23, 0x42]) {
      const h = pid.toString(16).toUpperCase().padStart(2, "0");
      const b = dataBytes(await this.cmd(`02${h}00`), `42${h}00`);
      const d = decode("01" + h, b);
      if (d.value != null) out["01" + h] = d.value;
    }
    return out;
  }

  get rate() {
    return this.stats.cmds ? this.stats.ms / this.stats.cmds : 0;
  }
}
