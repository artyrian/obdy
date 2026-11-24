import { test } from "node:test";
import assert from "node:assert/strict";
import { commandsFor, decodeSignal, payloadOf, parseVin, vinYear, repoCandidates, keyOf, offlineDecode } from "../app/src/core/obdb.js";
import { readFileSync } from "node:fs";

const mustang = JSON.parse(readFileSync(new URL("../app/profiles/Ford-Mustang.json", import.meta.url), "utf8"));
const sig = (cmds, id) => cmds.flatMap((c) => c.signals.map((s) => ({ c, s }))).find((x) => x.s.id === id);

// expected values from OBDb's own test cases (tests/test_cases/2018|2019 in OBDb/Ford-Mustang)
const CASES = [
  ["MUSTANG_LPFP_ACT", "220548", "62054803 2A", 58.74162],
  ["MUSTANG_LPFP_ACT", "220548", "6205480434", 78.03208],
  ["MUSTANG_PCM_MISF_ACCEL_CYL1_NORM", "220382", "620382FF", -0.01562],
  ["MUSTANG_PCM_MISF_ACCEL_CYL1_NORM", "220382", "62038200", 0],
  ["[ECU] HPFP Desired", "2203DC", "6203DC06C6", 2514.95441],
  ["[ECU] HPFP Desired", "2203DC", "6203DC0022", 49.31283],
];

test("decode matches OBDb test cases (Ford Mustang)", () => {
  const cmds = commandsFor(mustang, 2019);
  for (const [id, cmd, resp, want] of CASES) {
    const { c, s } = sig(cmds, id);
    assert.equal(c.cmd, cmd);
    const got = decodeSignal(s.fmt, payloadOf(resp.replace(/ /g, ""), cmd));
    assert.ok(Math.abs(got - want) < 1e-3, `${id} ${resp}: ${got} != ${want}`);
  }
});

test("year filter and verified flag", () => {
  const y2018 = commandsFor(mustang, 2018), y2010 = commandsFor(mustang, 2010);
  assert.ok(sig(y2018, "[ECU] HPFP Desired"));            // filter from 2015
  assert.equal(sig(y2010, "[ECU] HPFP Desired"), undefined);
  assert.equal(sig(y2018, "MUSTANG_LPFP_ACT").c.verified, false); // 2018 in dbgfilter years
  assert.equal(sig(commandsFor(mustang, 2019), "MUSTANG_LPFP_ACT").c.verified, true);
});

test("nullmax, sign, bits", () => {
  assert.equal(decodeSignal({ len: 16, div: 20, nullmax: 150 }, [0xff, 0xff]), null);
  assert.equal(decodeSignal({ len: 16, div: 20, nullmax: 150 }, [0x02, 0xbc]), 35);
  assert.equal(decodeSignal({ bix: 4, len: 4 }, [0x0a]), 10);
  assert.equal(decodeSignal({ len: 8 }, []), null);
});

test("payloadOf ignores negative responses", () => {
  assert.equal(payloadOf("7F2231", "220548"), null);
  assert.equal(payloadOf("NODATA", "220548"), null);
  assert.deepEqual(payloadOf("6205480434", "220548"), [0x04, 0x34]);
});

test("VIN parse, year, repo names", () => {
  const hex = [..."1FA6P8TH0J5100000"].map((c) => c.charCodeAt(0).toString(16)).join("").toUpperCase();
  assert.equal(parseVin("490201" + hex), "1FA6P8TH0J5100000");
  assert.equal(vinYear("1FA6P8TH0J5100000", 2027), 2018);
  assert.equal(vinYear("5YJ3E1EA7MF000000", 2027), 2021);
  assert.deepEqual(repoCandidates("FORD", "Mustang"), ["Ford-Mustang", "Ford"]);
  assert.deepEqual(repoCandidates("MERCEDES-BENZ", "C Class"), ["Mercedes-Benz-C-Class", "Mercedes-Benz"]);
  assert.deepEqual(offlineDecode("1FA6P8TH0J5100000").model, "Mustang");
  assert.equal(keyOf("[ECU] HPFP Desired"), "x.ECU_HPFP_Desired");
});

test("demo adapter answers VIN and Mustang DIDs decodable with the profile", async () => {
  const { FakeTransport } = await import("../app/src/transport/fake.js");
  const f = new FakeTransport();
  assert.equal(parseVin(f._answer("0902")), "1FA6P8TH0J5100000");
  const cmds = commandsFor(mustang, 2018);
  const { s } = sig(cmds, "MUSTANG_LPFP_ACT");
  const v = decodeSignal(s.fmt, payloadOf(f._answer("220548"), "220548"));
  assert.ok(v > 40 && v < 80, String(v));
  assert.equal(payloadOf(f._answer("22ABCD"), "22ABCD"), null);
});
