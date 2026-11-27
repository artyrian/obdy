// Report view: HTML for a report object (core/report.js). Inline SVG charts so it prints as-is.
import { VERDICT_TEXT, labelFor, fmtKey, orderedKeys, CORE_KEYS, normalTxt } from "../core/report.js";
import { KPA_PSI } from "../core/pids.js";

const esc = (x) => String(x ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const ICON = { ok: "✓", warn: "!", bad: "✕" };
const DESIRED = { "0123": "x.ECU_HPFP_Desired", "x.MUSTANG_LPFP_ACT": "x.MUSTANG_LPFP_DES", "0134": "0144" };
const KIND = { module: "engine module", stored: "stored", pending: "pending", permanent: "permanent" };

/** Downsample to <= max points keeping each bucket's min and max (spikes stay visible). */
export function thin(pts, max = 240) {
  if (pts.length <= max) return pts;
  const out = [], size = Math.ceil(pts.length / (max / 2));
  for (let i = 0; i < pts.length; i += size) {
    const b = pts.slice(i, i + size);
    let lo = b[0], hi = b[0];
    for (const p of b) { if (p[1] < lo[1]) lo = p; if (p[1] > hi[1]) hi = p; }
    out.push(...(lo[0] <= hi[0] ? [lo, hi] : [hi, lo]));
  }
  return out;
}

function spark(rep, k) {
  const conv = (key) => (rep.keys[key]?.unit === "kPa" || (key === "0123" && !rep.keys[key]) ? KPA_PSI : 1);
  const main = thin(rep.series[k] || []).map(([t, v]) => [t, v * conv(k)]);
  if (main.length < 2) return "";
  const dk = DESIRED[k], des = dk && rep.series[dk] ? thin(rep.series[dk]).map(([t, v]) => [t, v * conv(dk)]) : [];
  const band = rep.summary[k]?.band?.map((v) => v * conv(k));
  const t0 = main[0][0], t1 = main[main.length - 1][0];
  let lo = Infinity, hi = -Infinity;
  for (const [, v] of [...main, ...des]) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  if (band) { lo = Math.min(lo, band[0]); hi = Math.max(hi, band[1]); }
  const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad;
  const W = 300, H = 64;
  const X = (t) => ((t - t0) / Math.max(1, t1 - t0)) * W, Y = (v) => H - ((v - lo) / (hi - lo)) * H;
  const line = (pts) => pts.map(([t, v]) => `${X(t).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
  let svg = `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(labelFor(k, rep.keys))} chart">`;
  if (band) svg += `<rect x="0" width="${W}" y="${Y(band[1]).toFixed(1)}" height="${Math.max(1, Y(band[0]) - Y(band[1])).toFixed(1)}" class="sp-band"/>`;
  if (des.length > 1) svg += `<polyline points="${line(des)}" class="sp-ref"/>`;
  svg += `<polyline points="${line(main)}" class="sp-line"/></svg>`;
  const s = rep.summary[k];
  const f = rep.findings.find((x) => x.key === k);
  return `<figure class="sp ${f ? f.level : ""}"><figcaption><b>${esc(labelFor(k, rep.keys))}</b>
    <span class="muted small">${esc(fmtKey(k, s.min, rep.keys))} – ${esc(fmtKey(k, s.max, rep.keys))}${dk && des.length ? " · dashed: desired" : ""}</span></figcaption>${svg}</figure>`;
}

/** Charts: keys with findings first, then core values; at most `max`. */
export function chartKeys(rep, max = 6) {
  const out = [];
  for (const k of [...rep.findings.map((f) => f.key), ...CORE_KEYS]) {
    if (k && !out.includes(k) && (rep.series[k]?.length ?? 0) >= 2) out.push(k);
  }
  return out.slice(0, max);
}

export function reportHtml(rep, { version = "", lookup = true } = {}) {
  const m = rep.meta;
  const when = m.start ? new Date(m.start).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "";
  const mins = Math.max(1, Math.round(m.durationS / 60));
  let h = `<div class="rep-head v-${rep.verdict}"><div class="rep-icon" aria-hidden="true">${ICON[rep.verdict]}</div><div>
    <div class="rep-verdict">${VERDICT_TEXT[rep.verdict]}</div>
    <div class="muted small">${esc(m.car || "Unknown car")}${m.vin ? ` · ${esc(m.vin)}` : ""}</div>
    <div class="muted small">${esc(when)} · ${mins} min${m.preset ? ` · ${esc(m.preset)} test` : ""}${m.demo ? ` · <b>demo data</b>` : ""}</div></div></div>`;

  h += `<section class="card"><h4>Trouble codes</h4>`;
  if (!rep.codes.length) h += `<p class="ok small rep-none">No codes stored in the engine computer.</p>`;
  else {
    h += `<ul class="rep-list">`;
    for (const c of rep.codes) {
      const q = encodeURIComponent(`${c.code} ${m.car || ""}`.trim());
      h += `<li><span class="lv ${c.level}" aria-hidden="true"></span><div><b class="code">${esc(c.code)}</b> ${esc(c.text)}
        ${lookup ? `<a class="small noprint" href="https://www.google.com/search?q=${q}" target="_blank" rel="noopener">look up</a>` : ""}
        <div class="chips">${c.kinds.map((x) => `<span class="chip">${esc(KIND[x] || x)}</span>`).join("")}
        ${c.flags.filter((x) => !c.kinds.includes(x)).map((x) => `<span class="chip${/now|confirmed|check/.test(x) ? " hot" : ""}">${esc(x)}</span>`).join("")}
        ${c.during ? `<span class="chip hot">new during recording</span>` : ""}</div></div></li>`;
    }
    h += `</ul>`;
  }
  h += `</section>`;

  h += `<section class="card"><h4>What we found</h4>`;
  if (!rep.findings.length) h += `<p class="ok small rep-none">All checked values stayed in their normal ranges.</p>`;
  else {
    h += `<ul class="rep-list">`;
    for (const f of rep.findings) h += `<li><span class="lv ${f.level}" aria-hidden="true"></span><div><b>${esc(f.title)}</b><div class="small">${esc(f.detail)}</div></div></li>`;
    h += `</ul>`;
  }
  h += `</section>`;

  const ck = chartKeys(rep);
  if (ck.length) h += `<section class="card"><h4>Charts</h4><div class="sp-grid">${ck.map((k) => spark(rep, k)).join("")}</div>
    <p class="muted small">Green band: normal range. Whole recording, left to right.</p></section>`;

  const vk = orderedKeys(rep);
  if (vk.length) {
    h += `<section class="card"><h4>Values</h4><p class="muted small">While the engine ran. Lambda at fuel cut (coasting) is not counted as lean.</p><table class="rep-vals small"><tr><th></th><th>min</th><th>avg</th><th>max</th><th>normal</th></tr>`;
    for (const k of vk) {
      const s = rep.summary[k];
      h += `<tr><td>${esc(labelFor(k, rep.keys))}</td><td>${esc(fmtKey(k, s.min, rep.keys))}</td><td>${esc(fmtKey(k, s.mean, rep.keys))}</td>
        <td>${esc(fmtKey(k, s.max, rep.keys))}</td><td class="muted">${esc(normalTxt(k, s, rep.keys))}</td></tr>`;
    }
    h += `</table></section>`;
  }

  if (rep.steps.length) {
    h += `<section class="card"><h4>Test steps</h4><ol class="checklist small">`;
    for (const s of rep.steps) h += `<li class="${esc(s.state)}"><span class="mk">${s.state === "done" ? "✔" : s.state === "skipped" ? "–" : "○"}</span>
      <span class="tt">${esc(s.title)}</span><span class="muted">${s.t != null ? Math.round(s.t) + " s" : ""}</span></li>`;
    h += `</ol></section>`;
  }

  h += `<section class="card noprint rep-ai"><h4>Explain with AI</h4>
    <p class="small muted">Copies a short summary of this report with a prompt. Paste it into any AI chat — obdy sends nothing anywhere.</p>
    <div class="bar"><button data-ai="copy" class="primary">Copy for AI</button><button data-ai="chatgpt">Open ChatGPT</button><button data-ai="claude">Open Claude</button></div></section>`;
  h += `<p class="muted small rep-foot">obdy ${esc(version)} · normal ranges are generic and Ford-tuned; this is a hint, not a professional diagnosis.</p>`;
  return h;
}
