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

test("profile settings: ext values validated per repo", () => {
  const c = S.normalize({ useProfile: false, vehicle: { repo: "Ford-Mustang", year: 2018 },
    ext: { "Ford-Mustang": { "x.MUSTANG_LPFP_ACT": { on: true, every: 0 }, "bad key": { on: true } }, "../evil": {} } });
  assert.equal(c.useProfile, false);
  assert.deepEqual(c.vehicle, { repo: "Ford-Mustang", year: 2018 });
  assert.deepEqual(c.ext, { "Ford-Mustang": { "x.MUSTANG_LPFP_ACT": { on: true, every: 1000 } } });
  assert.equal(S.normalize({ vehicle: { repo: "a b" } }).vehicle, null);
  assert.ok(S.estimateKbPerHour(c, 120, [1000, 1000]) > S.estimateKbPerHour(c));
});

test("profile defaults: first run, upgrade adds new keys, keeps user choices", () => {
  const c = S.defaults();
  const v1 = { version: 1, on: { "x.A": 1000, "x.B": 1000 } };
  assert.ok(S.applyProfileDefaults(c, "Ford-Mustang", v1));
  assert.deepEqual(c.ext["Ford-Mustang"], { "x.A": { on: true, every: 1000 }, "x.B": { on: true, every: 1000 } });
  c.ext["Ford-Mustang"]["x.A"].on = false;           // user turned A off
  assert.ok(!S.applyProfileDefaults(c, "Ford-Mustang", v1)); // same version: no-op
  const v2 = { version: 2, on: { "x.A": 5000, "x.B": 2000, "x.C": 1000 } };
  assert.ok(S.applyProfileDefaults(c, "Ford-Mustang", v2, { "x.B": 1000 }));
  const e = c.ext["Ford-Mustang"];
  assert.equal(e["x.A"].on, false);                  // user choice kept
  assert.equal(e["x.B"].every, 2000);                // old default interval moved
  assert.deepEqual(e["x.C"], { on: true, every: 1000 }); // new key added
  const back = S.normalize(JSON.parse(JSON.stringify(c)));
  assert.equal(back.extV["Ford-Mustang"], 2);
});

test("Series.since uses the sorted time index", () => {
  const s = new Series();
  for (let i = 0; i < 100; i++) s.push(i * 10, i);
  assert.deepEqual(s.since(495).v.slice(0, 2), [50, 51]);
  assert.equal(s.since(0).v.length, 100);
  assert.equal(s.since(10000).v.length, 0);
});

test("decimate keeps spikes and order, shrinks to ~4 points per column", async () => {
  const { decimate } = await import("../app/src/ui/chart.js");
  const t = Array.from({ length: 10000 }, (_, i) => i), v = t.map((i) => (i === 5003 ? 99 : i === 7001 ? -5 : 1));
  const out = decimate(t, v, (x) => Math.floor(x / 100)); // 100 columns
  assert.ok(out.t.length <= 400);
  assert.ok(out.v.includes(99) && out.v.includes(-5));
  assert.ok(out.t.every((x, i) => !i || x > out.t[i - 1]));
  assert.equal(out.t[0], 0); assert.equal(out.t.at(-1), 9999);
});
