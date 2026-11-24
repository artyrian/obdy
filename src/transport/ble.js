// Web Bluetooth transport for BLE ELM327 clones (UniCarScan UCSI-2100 = FFF0 service).
const SERVICES = [0xfff0, 0xffe0, 0x18f0, 0xae30, "e7810a71-73ae-499d-8c15-faa9aef0c3f2"];

export const bleAvailable = () => typeof navigator !== "undefined" && !!navigator.bluetooth;

export class BleTransport {
  constructor() {
    this.cb = () => {};
    this.onDisconnect = () => {};
    this.dec = new TextDecoder();
    this.enc = new TextEncoder();
  }

  onData(cb) { this.cb = cb; }

  async connect() {
    this.device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: SERVICES });
    this.name = this.device.name || "adapter";
    this.device.addEventListener("gattserverdisconnected", () => this.onDisconnect());
    const server = await this.device.gatt.connect();
    for (const svc of await server.getPrimaryServices()) {
      let nt = null, wr = null;
      for (const ch of await svc.getCharacteristics()) {
        const p = ch.properties;
        if (!nt && (p.notify || p.indicate)) nt = ch;
        if (!wr && (p.write || p.writeWithoutResponse)) wr = ch;
      }
      if (nt && wr) {
        this.nt = nt;
        this.wr = wr;
        this.service = svc.uuid;
        break;
      }
    }
    if (!this.nt) throw new Error("no notify+write characteristic pair found on the adapter");
    this.nt.addEventListener("characteristicvaluechanged", (e) => this.cb(this.dec.decode(e.target.value)));
    await this.nt.startNotifications();
    return this;
  }

  async write(text) {
    const data = this.enc.encode(text);
    for (let i = 0; i < data.length; i += 20) {  // BLE default MTU payload
      const chunk = data.slice(i, i + 20);
      if (this.wr.properties.writeWithoutResponse) await this.wr.writeValueWithoutResponse(chunk);
      else await this.wr.writeValue(chunk);
    }
  }

  async close() {
    try { await this.nt?.stopNotifications(); } catch { /* already gone */ }
    this.device?.gatt?.disconnect();
  }
}
