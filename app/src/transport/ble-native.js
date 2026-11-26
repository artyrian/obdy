// Native BLE transport for the iOS/Android app (Capacitor + @capacitor-community/bluetooth-le).
// Same interface as BleTransport; loaded only inside the native app (see app.js).
import { BleClient } from "@capacitor-community/bluetooth-le";
import { pickPair, short, SKIP } from "./ble.js";
import { openPicker } from "../ui/picker.js";

const LAST = "obdy.ble.last";
// names ELM327 clones and branded adapters advertise; anything else goes to "Other devices"
export const OBD_NAME = /obd|elm|v-?link|vgate|icar|veepeak|obdlink|ucsi|unicar|konnwei|kiwi|viecar|bafx|thinkcar|scan|carista|bimmer|motoscan/i;
const OBD_SVC = ["fff0", "ffe0", "18f0", "e7810a71"];
export const looksLikeObd = (name, uuids = []) => OBD_NAME.test(name) || uuids.some((u) => OBD_SVC.includes(short(u).slice(0, 8)));
const loadLast = () => { try { return JSON.parse(localStorage.getItem(LAST)); } catch { return null; } };

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
    const dev = await this.pick();
    this.id = dev.id;
    this.name = dev.name;
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
    try { localStorage.setItem(LAST, JSON.stringify({ id: this.id, name: this.name })); } catch { /* ignore */ }
    return this;
  }

  /** Scan with our own sheet; the last used adapter is picked automatically when it shows up. */
  async pick() {
    const last = loadLast(), found = new Map();
    let ui, timer;
    const choice = new Promise((resolve, reject) => {
      ui = openPicker({
        onPick: resolve,
        onCancel: () => reject(Object.assign(new Error("User cancelled the requestDevice() chooser."), { name: "NotFoundError" })),
      });
      ui.update([]);
      timer = setTimeout(() => ui.hint("Don't see it? Check that the adapter's light is on and no other app is connected to it."), 12000);
      BleClient.requestLEScan({}, (r) => {
        const name = (r.localName || r.device?.name || "").trim();
        if (!name) return; // unnamed gadgets ("Unknown") are never shown
        const d = { id: r.device.deviceId, name, rssi: r.rssi, obd: looksLikeObd(name, r.uuids), saved: last?.id === r.device.deviceId };
        found.set(d.id, d);
        if (d.saved) { this.log(`BLE: last used adapter ${name} found`); resolve(d); return; }
        ui.update([...found.values()]);
      }).catch(reject);
    });
    try { return await choice; }
    finally {
      clearTimeout(timer);
      ui.close();
      await BleClient.stopLEScan().catch(() => {});
      this.log(`BLE scan: ${found.size} named device(s)`);
    }
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
