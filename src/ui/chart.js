// Tiny canvas charts: per-PID time series + sparkline / expanded line chart. No dependencies.

/** Time series trimmed to a window (ms) and a hard point cap. */
export class Series {
  constructor(cap = 3000) { this.t = []; this.v = []; this.cap = cap; }

  push(t, v) {
    if (v == null || !Number.isFinite(v)) return;
    this.t.push(t); this.v.push(v);
    if (this.t.length > this.cap) { this.t.splice(0, this.t.length - this.cap); this.v.splice(0, this.v.length - this.cap); }
  }

  /** Points with t >= from. */
  since(from) {
    let i = 0;
    while (i < this.t.length && this.t[i] < from) i++;
    return { t: this.t.slice(i), v: this.v.slice(i) };
  }

  trim(from) {
    let i = 0;
    while (i < this.t.length && this.t[i] < from) i++;
    if (i) { this.t.splice(0, i); this.v.splice(0, i); }
  }
}

/** min/max with a little padding; flat lines get a visible band. */
export function yRange(v) {
  let lo = Math.min(...v), hi = Math.max(...v);
  if (!Number.isFinite(lo)) return [0, 1];
  if (hi - lo < 1e-9) { const p = Math.abs(hi) * 0.05 || 1; lo -= p; hi += p; }
  const pad = (hi - lo) * 0.08;
  return [lo - pad, hi + pad];
}

const css = (name, el) => getComputedStyle(el).getPropertyValue(name).trim();

/**
 * Draw series s over [now - windowMs, now] into canvas.
 * big: axes labels + grid. fmtY: value -> label.
 */
export function draw(canvas, s, { now, windowMs: windowMs0, big = false, gapMs = 10000, fmtY = (x) => x.toFixed(1) }) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  }
  const g = canvas.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  let windowMs = windowMs0;
  const all = s.since(now - windowMs);
  // fit the x axis to the data until the window is full (min 30 s)
  windowMs = Math.min(windowMs, Math.max(30000, all.t.length ? now - all.t[0] : 0));
  const from = now - windowMs;
  const { t, v } = all;
  const muted = css("--muted", canvas), line = css("--line", canvas), accent = css("--accent", canvas);
  const L = big ? 48 : 2, R = 4, T = big ? 8 : 3, B = big ? 18 : 3;
  const pw = w - L - R, ph = h - T - B;
  const X = (x) => L + ((x - from) / windowMs) * pw;

  if (!v.length) {
    if (big) { g.fillStyle = muted; g.font = "12px -apple-system, sans-serif"; g.fillText("no data yet", L + 6, T + 16); }
    return;
  }
  const [lo, hi] = yRange(v);
  const Y = (y) => T + ph - ((y - lo) / (hi - lo)) * ph;

  if (big) {
    g.strokeStyle = line; g.fillStyle = muted; g.lineWidth = 1;
    g.font = "11px -apple-system, sans-serif"; g.textBaseline = "middle";
    for (let i = 0; i <= 4; i++) {
      const y = lo + ((hi - lo) * i) / 4;
      g.beginPath(); g.moveTo(L, Y(y)); g.lineTo(w - R, Y(y)); g.stroke();
      g.textAlign = "right"; g.fillText(fmtY(y), L - 6, Y(y));
    }
    g.textAlign = "center"; g.textBaseline = "alphabetic";
    const step = [5, 10, 15, 30, 60, 120, 300, 600].map((x) => x * 1000).find((x) => windowMs / x <= 6) || 600000;
    for (let ms = 0; ms <= windowMs + 1; ms += step) {
      const x = X(now - ms);
      g.textAlign = ms === 0 ? "right" : x < L + 20 ? "left" : "center";
      g.fillText(ms === 0 ? "now" : ms < 60000 ? `-${ms / 1000}s` : `-${+(ms / 60000).toFixed(1)}m`, x, h - 4);
    }
  }

  g.strokeStyle = accent; g.lineWidth = big ? 1.6 : 1.3; g.lineJoin = "round";
  g.beginPath();
  // long gaps are drawn as breaks (disconnects, paused polling)
  for (let i = 0; i < v.length; i++) {
    const gap = i && t[i] - t[i - 1] > gapMs;
    if (!i || gap) g.moveTo(X(t[i]), Y(v[i])); else g.lineTo(X(t[i]), Y(v[i]));
  }
  g.stroke();
  if (v.length < 60) { // sparse data: dots make single samples visible
    g.fillStyle = accent;
    for (let i = 0; i < v.length; i++) { g.beginPath(); g.arc(X(t[i]), Y(v[i]), big ? 2.2 : 1.4, 0, 7); g.fill(); }
  }
}

/** Actual poll rate from the last minute of samples: "2.4 Hz" or "5 s" (period). */
export function rateLabel(t, now) {
  let i = t.length - 1;
  while (i > 0 && now - t[i - 1] <= 60000) i--;
  const n = t.length - 1 - i;
  if (n < 1 || now - t.at(-1) > 60000) return "";
  const hz = (n * 1000) / (t.at(-1) - t[i]);
  if (!Number.isFinite(hz)) return "";
  return hz >= 0.95 ? `${hz.toFixed(hz >= 10 ? 0 : 1)} Hz` : `${(1 / hz).toFixed(1 / hz >= 10 ? 0 : 1)} s`;
}
