import { test } from "node:test";
import assert from "node:assert/strict";
import { refFor, status, context } from "../src/core/refs.js";

const idleWarm = { "010C": 750, "0105": 90, "010D": 0, "0111": 15, "0144": 1 };

test("battery: charging vs engine off", () => {
  assert.equal(refFor("0142", idleWarm).label, "charging");
  assert.equal(status("0142", 14.3, idleWarm), "ok");
  assert.equal(status("0142", 13.0, idleWarm), "warn");
  assert.equal(status("0142", 12.5, idleWarm), "bad");
  const off = { "010C": 0 };
  assert.equal(status("0142", 12.6, off), "ok");
  assert.equal(status("0142", 12.1, off), "warn");
  assert.equal(status("0142", 11.6, off), "bad");
});

test("coolant: cold is not a problem, overheating is", () => {
  assert.equal(status("0105", 30, { "0105": 30 }), "ok");
  assert.equal(status("0105", 95, idleWarm), "ok");
  assert.equal(status("0105", 110, { "0105": 110 }), "warn");
  assert.equal(status("0105", 115, { "0105": 115 }), "bad");
});

test("trims only when running", () => {
  assert.equal(refFor("0106", { "010C": 0 }), null);
  assert.equal(status("0107", 4, idleWarm), "ok");
  assert.equal(status("0107", 14, idleWarm), "warn");
  assert.equal(status("0106", -25, idleWarm), "bad");
});

test("lambda follows commanded", () => {
  const rich = { ...idleWarm, "0144": 0.85 };
  assert.ok(Math.abs(refFor("0134", rich).lo - 0.82) < 1e-9);
  assert.equal(status("0134", 0.86, rich), "ok");
  assert.equal(status("0134", 1.0, rich), "warn");
});

test("rpm reference only at warm idle", () => {
  assert.equal(refFor("010C", { ...idleWarm, "010D": 60 }), null);
  assert.equal(refFor("010C", { ...idleWarm, "0105": 40 }), null);
  assert.equal(status("010C", 1100, idleWarm), "warn");
  assert.ok(context(idleWarm).idle);
});
