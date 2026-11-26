// Adapter picker for the native app: our own sheet instead of the plugin's system list,
// which shows every nearby BLE gadget (mostly "Unknown") and overflows on a busy street.
const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const bars = (rssi) => (rssi >= -60 ? 4 : rssi >= -70 ? 3 : rssi >= -80 ? 2 : 1);

/** Opens the sheet. onPick(device) / onCancel(). Returns { update(list), hint(text), close() }. */
export function openPicker({ onPick, onCancel }) {
  const el = document.createElement("div");
  el.className = "picker-wrap";
  el.innerHTML = `<div class="picker" role="dialog" aria-modal="true" aria-labelledby="pk-title">
    <h3 id="pk-title">Choose your OBD adapter</h3>
    <p class="muted small" id="pk-sub"><span class="spin" aria-hidden="true"></span> Searching… plug the adapter in, ignition on.</p>
    <div id="pk-list" class="pk-list"></div>
    <details id="pk-other" class="pk-other" hidden><summary class="small muted"></summary><div class="pk-list"></div></details>
    <p id="pk-hint" class="small muted" hidden></p>
    <div class="bar"><button id="pk-cancel" type="button">Cancel</button></div>
  </div>`;
  document.body.append(el);
  let done = false;
  const finish = (f) => { if (!done) { done = true; f(); } };
  el.querySelector("#pk-cancel").onclick = () => finish(onCancel);
  el.onclick = (e) => { if (e.target === el) finish(onCancel); };
  const row = (d) => `<button type="button" class="pk-row" data-id="${esc(d.id)}">
      <span class="pk-name">${esc(d.name)}</span>
      ${d.saved ? `<span class="chip">last used</span>` : d.obd ? `<span class="chip">OBD</span>` : ""}
      <span class="pk-sig s${bars(d.rssi)}" aria-label="signal ${bars(d.rssi)} of 4"><i></i><i></i><i></i><i></i></span></button>`;
  let byId = new Map();
  el.addEventListener("click", (e) => {
    const b = e.target.closest(".pk-row");
    if (b && byId.has(b.dataset.id)) finish(() => onPick(byId.get(b.dataset.id)));
  });
  return {
    update(list) {
      byId = new Map(list.map((d) => [d.id, d]));
      const sort = (a, b) => (b.saved - a.saved) || (b.rssi ?? -999) - (a.rssi ?? -999);
      const obd = list.filter((d) => d.obd || d.saved).sort(sort), other = list.filter((d) => !d.obd && !d.saved).sort(sort);
      el.querySelector("#pk-list").innerHTML = obd.length ? obd.map(row).join("")
        : `<p class="muted small pk-empty">No OBD adapter yet…</p>`;
      const det = el.querySelector("#pk-other");
      det.hidden = !other.length;
      det.querySelector("summary").textContent = `Other Bluetooth devices (${other.length})`;
      det.querySelector(".pk-list").innerHTML = other.map(row).join("");
    },
    hint(text) { const h = el.querySelector("#pk-hint"); h.textContent = text; h.hidden = !text; },
    close() { done = true; el.remove(); },
  };
}
