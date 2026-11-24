// Demo adapter: answers like the Mustang did in real journals (P0302 pending, cyl2 misfires).
export class FakeTransport {
  constructor() {
    this.cb = () => {};
    this.t0 = Date.now();
    this.rpm = 760;
    this.name = "DEMO adapter";
  }

  onData(cb) { this.cb = cb; }

  async connect() { return this; }

  async close() {}

  _pid(pid) {
    const r = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
    const hex = (v, n) => Math.max(0, Math.round(v)).toString(16).toUpperCase().padStart(n, "0");
    const el = (Date.now() - this.t0) / 1000;
    const rpm = this.rpm ? this.rpm + r(-20, 20) : 0;
    return {
      0x01: "00076500", 0x04: hex(64, 2), 0x05: hex(Math.min(92, 20 + el) + 40, 2),
      0x06: hex(128 + r(-5, 5), 2), 0x07: hex(131, 2), 0x0b: "23", 0x0c: hex(rpm * 4, 4),
      0x0d: "00", 0x0e: hex((8 + 64) * 2, 2), 0x0f: "3A", 0x10: hex(300 + r(-10, 10), 4),
      0x11: "2C", 0x23: hex((rpm ? 180 : 70) + r(-8, 8), 4), 0x34: hex(32768 + r(-500, 500), 4) + "8000",
      0x44: "80008000", 0x42: hex(rpm ? 14400 : 12300, 4),
    }[pid];
  }

  _answer(s) {
    if (s.startsWith("AT")) {
      if (s === "ATRV") return this.rpm ? "14.4V" : "12.3V";
      return s === "ATI" ? "ELM327 v1.5 (demo)" : "OK";
    }
    if (s === "0100") return "4100BE3FB813";
    if (s === "0120") return "4120A007F011";
    if (s === "0140") return "4140FED08400";
    if (s.startsWith("01") && s.length === 4) {
      const p = this._pid(parseInt(s.slice(2), 16));
      return p ? "41" + s.slice(2) + p : "NO DATA";
    }
    if (s === "03") return "4300";
    if (s === "07") return "47010302";
    if (s === "0A") return "4A00";
    if (s === "020200") return "4202000302";
    if (s.startsWith("02") && s.length === 6) {
      const p = this._pid(parseInt(s.slice(2, 4), 16));
      return p ? "42" + s.slice(2) + p : "NO DATA";
    }
    if (s.startsWith("06A")) {
      const mid = s.slice(2, 4);
      const cyc = { A2: 10, A3: 34 }[mid] ?? 0;
      const h = (v) => v.toString(16).toUpperCase().padStart(4, "0");
      return `46${mid}0B24${h(cyc ? 1 : 0)}0000FFFF${mid}0C24${h(cyc)}0000FFFF`;
    }
    if (s === "221279") return "6212790235";
    return "NO DATA";
  }

  async write(text) {
    const s = text.trim().toUpperCase();
    setTimeout(() => this.cb(this._answer(s) + "\r\r>"), 15 + Math.random() * 20);
  }
}
