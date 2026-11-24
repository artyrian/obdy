// Web Bluetooth transport for BLE ELM327 clones (UniCarScan UCSI-2100 = FFF0 service).
// Works in Chrome/Edge (desktop, Android) and Bluefy (iOS). Every step is logged so a failed
// connection on a phone can be diagnosed from Info → Log.

// full 128-bit strings: some iOS Web Bluetooth browsers mishandle numeric aliases
const SERVICES = ["fff0", "ffe0", "18f0", "ae30"].map((x) => `0000${x}-0000-1000-8000-00805f9b34fb`)
  .concat("e7810a71-73ae-499d-8c15-faa9aef0c3f2");
// known notify/write pairs (short 16-bit ids inside the 0000xxxx-0000-1000-8000-00805f9b34fb base)
const PAIRS = { fff0: ["fff1", "fff2"], ffe0: ["ffe1", "ffe1"], "18f0": ["2af0", "2af1"], ae30: ["ae02", "ae01"] };
const SKIP = ["1800", "1801", "180a", "180f"]; // GAP, GATT, device info, battery

export const bleAvailable = () => typeof navigator !== "undefined" && !!navigator.bluetooth;

const short = (uuid) => (/^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/i.exec(uuid)?.[1] || uuid).toLowerCase();
const props = (p) => ["read", "write", "writeWithoutResponse", "notify", "indicate"].filter((k) => p[k]).join("+");

function withTimeout(p, ms, what) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: timeout ${ms / 1000} s`)), ms); })])
    .finally(() => clearTimeout(t));
}

/** Pick notify + write characteristics: known pair first, else first notify + first write in the service. */
export function pickPair(serviceShort, chars) {
  const by = (id) => chars.find((c) => short(c.uuid) === id);
  const known = PAIRS[serviceShort];
  if (known) {
    const nt = by(known[0]), wr = by(known[1]);
    if (nt && wr && (nt.properties.notify || nt.properties.indicate) && (wr.properties.write || wr.properties.writeWithoutResponse)) return { nt, wr };
  }
  const nt = chars.find((c) => c.properties.notify || c.properties.indicate);
  const wr = chars.find((c) => c.properties.write || c.properties.writeWithoutResponse);
  return nt && wr ? { nt, wr } : null;
}

export class BleTransport {
  constructor(log = () => {}) {
    this.cb = () => {};
    this.onDisconnect = () => {};
    this.log = log;
    this.dec = new TextDecoder();
    this.enc = new TextEncoder();
  }

  onData(cb) { this.cb = cb; }

  async connect() {
    // must be the first await: requestDevice needs the click's user gesture
    this.device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: SERVICES });
    this.name = this.device.name || "adapter";
    this.log(`BLE device: ${this.name} (${this.device.id || "?"})`);
    this.device.addEventListener("gattserverdisconnected", () => this.onDisconnect());

    let server;
    for (let attempt = 1; ; attempt++) {
      try {
        this.log(`BLE GATT connect, attempt ${attempt}…`);
        server = await withTimeout(this.device.gatt.connect(), 15000, "GATT connect");
        break;
      } catch (e) {
        this.log(`BLE GATT connect failed: ${e.message}`);
        if (attempt >= 2) throw new Error(`can't connect to ${this.name}: ${e.message}. Is the adapter plugged in and not connected to another app?`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    const services = await this.services(server);
    this.log(`BLE services: ${services.map((s) => short(s.uuid)).join(", ") || "none"}`);
    for (const svc of services) {
      const id = short(svc.uuid);
      if (SKIP.includes(id)) continue;
      let chars;
      try { chars = await withTimeout(svc.getCharacteristics(), 8000, "characteristics"); } catch (e) { this.log(`BLE ${id}: ${e.message}`); continue; }
      this.log(`BLE ${id}: ${chars.map((c) => `${short(c.uuid)}[${props(c.properties)}]`).join(" ")}`);
      const pair = pickPair(id, chars);
      if (pair) { this.nt = pair.nt; this.wr = pair.wr; this.service = id; break; }
    }
    if (!this.nt) throw new Error(`no ELM327 notify/write pair on ${this.name} — is it an OBD adapter?`);
    this.log(`BLE using ${this.service}: notify=${short(this.nt.uuid)} write=${short(this.wr.uuid)}`);
    this.nt.addEventListener("characteristicvaluechanged", (e) => this.cb(this.dec.decode(e.target.value)));
    await withTimeout(this.nt.startNotifications(), 8000, "start notifications");
    return this;
  }

  /** All services; falls back to asking for each known one (some iOS browsers can't list all). */
  async services(server) {
    try {
      return await withTimeout(server.getPrimaryServices(), 8000, "services");
    } catch (e) {
      this.log(`BLE getPrimaryServices: ${e.message}; trying known services one by one`);
      const out = [];
      for (const u of SERVICES) {
        try { out.push(await withTimeout(server.getPrimaryService(u), 4000, "service")); } catch { /* not there */ }
      }
      return out;
    }
  }

  async write(text) {
    const data = this.enc.encode(text);
    const p = this.wr.properties;
    for (let i = 0; i < data.length; i += 20) { // BLE default MTU payload
      const chunk = data.slice(i, i + 20);
      // like obd_tui: write-with-response when supported (some clones drop write-without-response)
      if (p.write && this.wr.writeValueWithResponse) await this.wr.writeValueWithResponse(chunk);
      else if (!p.write && p.writeWithoutResponse && this.wr.writeValueWithoutResponse) await this.wr.writeValueWithoutResponse(chunk);
      else await this.wr.writeValue(chunk);
    }
  }

  async close() {
    try { await this.nt?.stopNotifications(); } catch { /* already gone */ }
    try { this.device?.gatt?.disconnect(); } catch { /* ignore */ }
  }
}
