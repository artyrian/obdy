// Native BLE transport for the iOS/Android app (Capacitor + @capacitor-community/bluetooth-le).
// Same interface as BleTransport; loaded only inside the native app (see app.js).
import { BleClient } from "@capacitor-community/bluetooth-le";
import { pickPair, short, SKIP } from "./ble.js";

const props = (p) => ["read", "write", "writeWithoutResponse", "notify", "indicate"].filter((k) => p[k]).join("+");

export class NativeBleTransport {
  constructor(log = () => {}) {
    this.cb = () => {};
    this.onDisconnect = () => {};
    this.log = log;
    this.dec = new TextDecoder();
    this.enc = new TextEncoder();
  }

  onData(cb) { this.cb = cb; }

  async connect() {
    await BleClient.initialize();
    // native device picker; no service filter: clones advertise different (or no) services
    const dev = await BleClient.requestDevice({});
    this.id = dev.deviceId;
    this.name = dev.name || "adapter";
    this.log(`BLE device: ${this.name} (${this.id})`);
    for (let attempt = 1; ; attempt++) {
      try {
        this.log(`BLE connect, attempt ${attempt}…`);
        await BleClient.connect(this.id, () => this.onDisconnect(), { timeout: 15000 });
        break;
      } catch (e) {
        this.log(`BLE connect failed: ${e.message}`);
        if (attempt >= 2) throw new Error(`can't connect to ${this.name}: ${e.message}. Is the adapter plugged in and not connected to another app?`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    const services = await BleClient.getServices(this.id);
    this.log(`BLE services: ${services.map((s) => short(s.uuid)).join(", ") || "none"}`);
    for (const svc of services) {
      const id = short(svc.uuid);
      if (SKIP.includes(id)) continue;
      this.log(`BLE ${id}: ${svc.characteristics.map((c) => `${short(c.uuid)}[${props(c.properties)}]`).join(" ")}`);
      const pair = pickPair(id, svc.characteristics);
      if (pair) { this.svc = svc.uuid; this.nt = pair.nt; this.wr = pair.wr; this.service = id; break; }
    }
    if (!this.nt) throw new Error(`no ELM327 notify/write pair on ${this.name} — is it an OBD adapter?`);
    this.log(`BLE using ${this.service}: notify=${short(this.nt.uuid)} write=${short(this.wr.uuid)}`);
    await BleClient.startNotifications(this.id, this.svc, this.nt.uuid, (v) => this.cb(this.dec.decode(v)), { timeout: 8000 });
    return this;
  }

  async write(text) {
    const data = this.enc.encode(text);
    const p = this.wr.properties;
    for (let i = 0; i < data.length; i += 20) {
      const chunk = new DataView(data.slice(i, i + 20).buffer);
      if (p.write) await BleClient.write(this.id, this.svc, this.wr.uuid, chunk);
      else await BleClient.writeWithoutResponse(this.id, this.svc, this.wr.uuid, chunk);
    }
  }

  async close() {
    try { await BleClient.stopNotifications(this.id, this.svc, this.nt.uuid); } catch { /* already gone */ }
    try { await BleClient.disconnect(this.id); } catch { /* ignore */ }
  }
}
