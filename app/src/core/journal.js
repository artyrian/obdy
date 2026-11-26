// Journal: one greppable text log per session, same format as obd_tui.py:
//   2026-11-24 00:28:01.123 TAG key=value key="value with spaces" ...
// Lines are persisted to IndexedDB immediately (survive a tab crash / dead phone).

const pad = (n, w = 2) => String(n).padStart(w, "0");

export function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function fmtValue(v) {
  if (typeof v === "number") v = Math.round(v * 1000) / 1000;
  let s = String(v ?? "");
  if (s === "" || /[ ="]/.test(s)) s = `"${s.replace(/"/g, "'")}"`;
  return s;
}

export function line(tag, kv = {}, d = new Date()) {
  return [stamp(d), tag, ...Object.entries(kv).filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${fmtValue(v)}`)].join(" ");
}

// ---------------------------------------------------------------- storage
const DB = "odb_scanner", STORE = "lines", SESS = "sessions";

function openDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      const s = db.createObjectStore(STORE, { autoIncrement: true });
      s.createIndex("sess", "sess");
      db.createObjectStore(SESS, { keyPath: "id" });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

const tx = (db, stores, mode, fn) => new Promise((res, rej) => {
  const t = db.transaction(stores, mode);
  const out = fn(t);
  t.oncomplete = () => res(out?.result ?? out);
  t.onerror = () => rej(t.error);
});

export class Journal {
  /** memoryOnly: for environments without IndexedDB (tests). */
  constructor(id, { memoryOnly = false, onLine } = {}) {
    this.id = id;
    this.lines = [];
    this.memoryOnly = memoryOnly || typeof indexedDB === "undefined";
    this.onLine = onLine;
    this.dbp = this.memoryOnly ? null : openDb();
    this.pending = Promise.resolve();
  }

  static newId(d = new Date()) {
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }

  async start(meta = {}) {
    if (!this.memoryOnly) {
      const db = await this.dbp;
      this.rec = { id: this.id, started: Date.now(), ...meta };
      await tx(db, [SESS], "readwrite", (t) => t.objectStore(SESS).put(this.rec));
    }
    this.w("SESSION", { event: "start", ...meta });
  }

  w(tag, kv) {
    const l = line(tag, kv);
    this.lines.push(l);
    this.onLine?.(l, tag);
    if (!this.memoryOnly) {
      this.pending = this.pending.then(async () => {
        const db = await this.dbp;
        await tx(db, [STORE], "readwrite", (t) => t.objectStore(STORE).add({ sess: this.id, l }));
        // keep the session's last-write time and size current (Logs list), at most every 10 s
        const now = Date.now();
        if (this.rec && (!this.rec.last || now - this.rec.last > 10000)) {
          Object.assign(this.rec, { last: now, lines: this.lines.length });
          await tx(db, [SESS], "readwrite", (t) => t.objectStore(SESS).put(this.rec));
        }
      }).catch(() => {});
    }
    return l;
  }

  /** S line: context first, then cmd=value. */
  sample(values, ctx = {}) {
    const kv = { ...ctx };
    for (const [k, v] of Object.entries(values)) if (v != null) kv[k] = v;
    return this.w("S", kv);
  }

  text() {
    return this.lines.join("\n") + "\n";
  }

  async flush() {
    await this.pending;
  }
}

export async function listSessions() {
  if (typeof indexedDB === "undefined") return [];
  const db = await openDb();
  const all = await tx(db, [SESS], "readonly", (t) => t.objectStore(SESS).getAll());
  return all.sort((a, b) => b.started - a.started);
}

export async function sessionText(id) {
  const db = await openDb();
  const rows = await tx(db, [STORE], "readonly", (t) => t.objectStore(STORE).index("sess").getAll(id));
  return rows.map((r) => r.l).join("\n") + "\n";
}

export async function deleteSession(id) {
  const db = await openDb();
  const keys = await tx(db, [STORE], "readonly", (t) => t.objectStore(STORE).index("sess").getAllKeys(id));
  await tx(db, [STORE, SESS], "readwrite", (t) => {
    keys.forEach((k) => t.objectStore(STORE).delete(k));
    t.objectStore(SESS).delete(id);
  });
}
