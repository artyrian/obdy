import { test } from "node:test";
import assert from "node:assert/strict";
import { PRESETS, newRun, tick, advance, active } from "../app/src/core/guide.js";

const run1 = (run, from, to, step, vals, alive = true) => {
  let r;
  for (let t = from; t <= to; t += step) r = tick(run, { now: t, alive, latest: vals(t), fresh: vals(t) });
  return r;
};

test("presets: quick ⊂ standard ⊂ full by step ids", () => {
  const ids = (p) => PRESETS[p].steps().map((s) => s.id);
  assert.deepEqual(ids("quick"), ["koeo", "start"]);
  assert.deepEqual(ids("standard"), ["koeo", "offon", "start", "warm", "idle"]);
  assert.deepEqual(ids("full"), [...ids("standard").slice(0, 4), "hold", "snap", "idle"]);
  assert.deepEqual(ids("drive"), ["drive"]);
});

test("quick: koeo needs ignition, then start counts running time", () => {
  const run = newRun("quick", 0);
  let r = run1(run, 0, 3000, 500, () => ({}), false);
  assert.match(r.msg, /ignition on/);
  assert.equal(active(run).id, "koeo");
  // ignition on, engine off: 15 s
  r = run1(run, 3500, 19000, 500, () => ({ "010C": 0, "0105": 30 }));
  assert.equal(run.steps[0].state, "done");
  assert.equal(active(run).id, "start");
  // engine running 60 s
  run1(run, 19500, 81000, 500, () => ({ "010C": 800, "0105": 35 }));
  assert.equal(run.steps[1].state, "done");
  assert.equal(active(run), null);
  assert.equal(tick(run, { now: 82000, alive: true, latest: {} }), null);
});

test("offon waits for off then on", () => {
  const run = newRun("standard", 0);
  advance(run, 0, "skipped");
  assert.equal(active(run).id, "offon");
  let r = run1(run, 0, 2000, 500, () => ({ "010C": 0 }));
  assert.match(r.msg, /turn the ignition off/);
  run1(run, 2500, 5000, 500, () => ({}), false);
  r = run1(run, 5500, 21000, 500, () => ({ "010C": 0 }));
  assert.equal(run.steps[1].state, "done");
});

test("snaps counted on rising edges only", () => {
  const run = newRun("full", 0);
  while (active(run).id !== "snap") advance(run, 0, "skipped");
  const rpm = [800, 3800, 3900, 1500, 3700, 1200, 1900, 3600, 900];
  rpm.forEach((v, i) => tick(run, { now: i * 300, alive: true, latest: { "010C": v } }));
  assert.equal(run.steps.find((s) => s.id === "snap").state, "done");
});

test("drive is manual; stats collected per step", () => {
  const run = newRun("drive", 0);
  const r = run1(run, 0, 700000, 1000, () => ({ "010C": 2000, "010D": 100, "0123": 9000 }));
  assert.equal(r.ok, false);
  assert.equal(run.stats.drive["0123"].max, 9000);
  assert.ok(run.stats.drive["010C"].n > 100);
  assert.equal(advance(run, 700000, "done"), false);
});
