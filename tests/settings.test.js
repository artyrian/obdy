import { test } from "node:test";
import assert from "node:assert/strict";
import * as S from "../app/src/core/settings.js";
import { Series, yRange, rateLabel } from "../app/src/ui/chart.js";

test("defaults: RPM first and on", () => {
  const d = S.defaults();
  assert.equal(S.enabled(d)[0], "010C");
  assert.ok(S.enabled(d).length >= 8);
});

test("normalize drops junk, keeps RPM on", () => {
  const c = S.normalize({ logEvery: 7, window: 5, pids: { "010C": { on: false }, "0105": { on: false, every: 123 }, XX: {} } });
  assert.equal(c.logEvery, 1000);
  assert.equal(c.pids["010C"].on, true);
  assert.equal(c.pids["0105"].on, false);
  assert.equal(c.pids["0105"].every, 5000);
  assert.ok(!("XX" in c.pids));
  assert.deepEqual(S.normalize("garbage"), S.defaults());
});

test("due respects per-PID intervals", () => {
  const c = S.defaults();
  const all = S.due(c, {}, 1000);
  assert.deepEqual(all, S.enabled(c));
  const last = Object.fromEntries(all.map((p) => [p, 1000]));
  const next = S.due(c, last, 1500); // 0.5 s later: only every-cycle PIDs
  assert.ok(next.includes("010C") && next.includes("0123"));
  assert.ok(!next.includes("0105") && !next.includes("0107") && !next.includes("0144"));
  assert.ok(S.due(c, last, 6000).includes("0105"));
});

test("nextDueIn waits for the slowest when only slow PIDs are on", () => {
  const c = S.defaults();
  for (const p of Object.keys(c.pids)) c.pids[p] = { on: p === "010C" || p === "0105", every: p === "010C" ? 1000 : 5000 };
  assert.equal(S.nextDueIn(c, { "010C": 0, "0105": 0 }, 400), 600);
  assert.equal(S.nextDueIn(c, {}, 0), 0);
});

test("slower settings shrink the log estimate", () => {
  const fast = S.defaults();
  const slow = S.normalize({ ...fast, logEvery: 5000, deadband: false });
  assert.ok(S.estimateKbPerHour(slow) < S.estimateKbPerHour(fast) / 3);
});

test("settings round-trip through storage", () => {
  const mem = new Map();
  const store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const c = S.defaults(); c.logEvery = 2000; c.pids["0110"].on = true;
  S.save(c, store);
  assert.deepEqual(S.load(store), c);
  assert.deepEqual(S.load({ getItem: () => "{bad json" }), S.defaults());
});

test("Series trims by time and cap, skips nulls", () => {
  const s = new Series(5);
  for (let i = 0; i < 8; i++) s.push(i * 1000, i);
  s.push(9000, null);
  assert.deepEqual(s.v, [3, 4, 5, 6, 7]);
  assert.deepEqual(s.since(5000).v, [5, 6, 7]);
  s.trim(6000);
  assert.deepEqual(s.t, [6000, 7000]);
});

test("yRange pads flat lines", () => {
  const [lo, hi] = yRange([14, 14, 14]);
  assert.ok(lo < 14 && hi > 14);
});

test("rateLabel: period in seconds, empty when stale", () => {
  const fast = Array.from({ length: 21 }, (_, i) => 100000 + i * 140);
  assert.equal(rateLabel(fast, 103000), "0.14 s");
  const slow = [100000, 105000, 110000, 115000]; // every 5 s
  assert.equal(rateLabel(slow, 115500), "5.0 s");
  assert.equal(rateLabel([100000, 110000, 120000], 120500), "10 s");
  assert.equal(rateLabel([100000], 100500), "");
  assert.equal(rateLabel(slow, 300000), "");
});
