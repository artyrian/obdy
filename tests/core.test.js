import { test } from "node:test";
import assert from "node:assert/strict";
import { decode, dataBytes, parseDtcs, parseMode06, parseSupported, cleanElm, replyPrefix } from "../src/core/pids.js";
import { line, Journal } from "../src/core/journal.js";
import { Elm } from "../src/core/elm.js";
import { FakeTransport } from "../src/transport/fake.js";

test("decode rpm / rail / lambda", () => {
  assert.equal(decode("010C", dataBytes("410C0BB8", "410C")).value, 750);
  assert.equal(decode("0123", dataBytes("41230037", "4123")).value, 550); // from real log: 0037 -> 550 kPa
  assert.ok(Math.abs(decode("0134", dataBytes("413480008000", "4134")).value - 1.0) < 1e-9);
  assert.equal(decode("221279", dataBytes("6212790235", replyPrefix("221279"))).value, 565);
});

test("DTCs from real replies", () => {
  assert.deepEqual(parseDtcs("47010302", "47"), ["P0302"]);
  assert.deepEqual(parseDtcs("4301008A", "43"), ["P008A"]);
  assert.deepEqual(parseDtcs("4300", "43"), []);
});

test("mode 06 misfire record", () => {
  const m = parseMode06("46A30B240003000000FFA30C240022000000FF");
  assert.equal(m.get(`${0xa3}:${0x0b}`), 3);
  assert.equal(m.get(`${0xa3}:${0x0c}`), 0x22);
});

test("supported bitmap", () => {
  const s = parseSupported("4100BE3EB813", 0x00);
  assert.ok(s.has(0x01) && s.has(0x0c) && s.has(0x0d));
  assert.ok(!s.has(0x02));
});

test("ELM cleaning: echo, SEARCHING, multi-frame", () => {
  assert.equal(cleanElm("010C\rSEARCHING...\r410C0BB8\r\r>", "010C"), "410C0BB8");
  assert.equal(cleanElm("014\r0:490201314654\r1:41503855483742\r>", "0902"), "49020131465441503855483742");
});

test("journal line format matches obd_tui", () => {
  const l = line("ANOM", { rule: "rail_drop", msg: "drop 5010->3080 kPa" }, new Date(2026, 10, 24, 0, 32, 33, 821));
  assert.equal(l, '2026-11-24 00:32:33.821 ANOM rule=rail_drop msg="drop 5010->3080 kPa"');
  const j = new Journal("t", { memoryOnly: true });
  j.sample({ "010C": 750.25, "0105": null }, { phase: "idle" });
  assert.match(j.lines[0], / S phase=idle 010C=750.25$/);
});

test("Elm over fake transport", async () => {
  const elm = new Elm(new FakeTransport());
  await elm.init();
  const rpm = decode("010C", dataBytes(await elm.cmd("010C"), "410C")).value;
  assert.ok(rpm > 600 && rpm < 1200);
  const d = await elm.dtcs();
  assert.deepEqual(d.pending.codes, ["P0302"]);
  const mis = await elm.misfires();
  assert.equal(mis.cyl2.cycle, 34);
  assert.ok((await elm.voltage()) > 11);
});

test("app VERSION matches package.json", async () => {
  const { readFile } = await import("node:fs/promises");
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  assert.equal(app.match(/const VERSION = "([^"]+)"/)[1], pkg.version);
});
