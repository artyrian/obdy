import test from "node:test";
import assert from "node:assert/strict";
import { line } from "../app/src/core/journal.js";
import { parseLine, analyze, dtcText, toText, aiPrompt } from "../app/src/core/report.js";
import { thin, reportHtml, chartKeys } from "../app/src/ui/report.js";

const T0 = new Date("2026-11-25T10:00:00");
const at = (s) => new Date(T0.getTime() + s * 1000);
const KEYS = line("KEYS", { "010C": "RPM[rpm]", "0105": "Coolant_temp[°C]", "0107": "LTFT_bank_1[%]", "0142": "Module_voltage[V]",
  "0123": "Fuel_rail_press[kPa]", "x.MUSTANG_LPFP_ACT": "Fuel_pressure_low_actual[psi]{7E0.220548}",
  "x.MUSTANG_LPFP_DES": "Fuel_pressure_low_desired[psi]{7E0.22041F}" }, at(0));

/** n samples, 1 s apart, warm idle unless overridden. */
function samples(n, f = () => ({})) {
  return Array.from({ length: n }, (_, i) => line("S", { sess: "r1", t: i, "010C": 750, "010D": 0, "0111": 15, "0105": 90,
    "0107": 2, "0142": 14.2, ...f(i) }, at(i + 1)));
}
const log = (...parts) => [line("SESSION", { event: "start", app: "0.4.0", adapter: "UCSI-2100" }, at(0)),
  line("VEH", { vin: "1FA6P8TH0J5100000", make: "Ford", model: "Mustang", year: 2018 }, at(0)), KEYS, ...parts.flat()].join("\n");

test("parseLine: quotes, numbers, codes stay strings", () => {
  const x = parseLine('2026-11-25 10:00:01.250 DTC tag=before type=pending codes=P0302 raw=47010302 msg="a b" n=-1.5');
  assert.equal(x.tag, "DTC");
  assert.equal(x.kv.codes, "P0302");
  assert.equal(x.kv.msg, "a b");
  assert.equal(x.kv.n, -1.5);
  assert.equal(x.kv.raw, "47010302"); // hex replies stay strings
  assert.equal(parseLine("garbage"), null);
});

test("healthy warm idle: ok, no findings", () => {
  const r = analyze(log(samples(30)));
  assert.equal(r.verdict, "ok");
  assert.deepEqual(r.findings, []);
  assert.equal(r.meta.car, "2018 Ford Mustang");
  assert.equal(r.summary["010C"].n, 30);
});

test("lean LTFT while warm: warn with the lean explanation", () => {
  const r = analyze(log(samples(30, () => ({ "0107": 14 }))));
  const f = r.findings.find((x) => x.key === "0107");
  assert.equal(f.level, "warn");
  assert.match(f.title, /high/);
  assert.match(f.detail, /lean/);
  assert.equal(r.verdict, "warn");
});

test("battery: weak engine-off and no charging", () => {
  const r = analyze(log(line("BATT", { v: 11.7, rpm: 0, state: "engine off" }, at(1)), line("BATT", { v: 12.6, rpm: 760, state: "not charging?" }, at(20))));
  assert.ok(r.findings.some((f) => f.level === "bad" && /engine off/.test(f.title)));
  assert.ok(r.findings.some((f) => /Charging voltage/.test(f.title)));
});

test("low-side fuel pressure below desired", () => {
  const r = analyze(log(samples(30, (i) => ({ "x.MUSTANG_LPFP_ACT": i % 2 ? 40 : 64, "x.MUSTANG_LPFP_DES": 65 }))));
  const f = r.findings.find((x) => x.key === "x.MUSTANG_LPFP_ACT");
  assert.equal(f.level, "bad");
  assert.match(f.detail, /P008A/);
});

test("rail pressure kPa vs desired psi are compared in the same unit", () => {
  // 4000 kPa = 580 psi ≈ desired 590 psi -> fine
  const r = analyze(log(samples(30, () => ({ "0123": 4000, "x.ECU_HPFP_Desired": 590 }))));
  assert.ok(!r.findings.some((f) => f.key === "0123"));
});

test("UDS raw gives flags; confirmed module code is a problem", () => {
  const r = analyze(log(line("DTC", { tag: "before", type: "uds", codes: "P008A,P0302", raw: "5902FF008A002F03020024" }, at(1)), samples(5)));
  const c = r.codes.find((x) => x.code === "P008A");
  assert.ok(c.flags.includes("confirmed"));
  assert.equal(c.level, "bad");
  assert.equal(r.codes.find((x) => x.code === "P0302").level, "warn");
  assert.equal(r.verdict, "bad");
});

test("misfire count growing during recording is a problem", () => {
  const m = (s, n) => line("MISFIRE", { tag: "live", cyl: "cyl2", cycle: n, rpm: 760 }, at(s));
  assert.equal(analyze(log(m(1, 5), m(20, 5))).findings[0].level, "warn");
  assert.equal(analyze(log(m(1, 5), m(20, 9))).findings[0].level, "warn"); // a few more: watch it
  assert.equal(analyze(log(m(1, 5), m(20, 12))).findings[0].level, "bad");
});

test("misfires spread over cylinders point to a shared cause", () => {
  const m = (c, n) => line("MISFIRE", { tag: "live", cyl: c, cycle: n, rpm: 760 }, at(1));
  const r = analyze(log(m("cyl1", 2), m("cyl2", 3), m("cyl3", 4)));
  assert.ok(r.findings.some((f) => /3 cylinders/.test(f.title)));
});

test("low-side pressure: zero readings are a sensor dropout, not part of the ratio", () => {
  const r = analyze(log(samples(30, (i) => ({ "x.MUSTANG_LPFP_ACT": i % 10 ? 62 : 0, "x.MUSTANG_LPFP_DES": 65 }))));
  assert.ok(r.findings.some((f) => /reads 0/.test(f.title) && f.level === "bad"));
  assert.ok(!r.findings.some((f) => /below desired/.test(f.title))); // 62/65 is fine
});

test("lambda at fuel cut isn't 'lean'; values use running samples; band carries its condition", () => {
  const r = analyze(log(line("S", { "010C": 0, "0105": 60 }, at(0)),
    samples(30, (i) => ({ "0134": i % 3 ? 1.0 : 2.0, "0144": 1.0, "0111": i % 3 ? 15 : 0 }))));
  assert.ok(!r.findings.some((f) => f.key === "0134"));
  assert.equal(r.summary["010C"].min, 750); // the engine-off 0 rpm isn't in the stats
  assert.match(toText(r), /600 rpm–900 rpm at warm idle/);
  assert.match(toText(r), /≈ commanded/);
});

test("battery: cranking dip right before start isn't 'weak battery'", () => {
  const r = analyze(log(line("BATT", { v: 12.6, rpm: 0, state: "engine off" }, at(0)),
    line("BATT", { v: 10.9, rpm: 0, state: "engine off" }, at(1)), samples(10)));
  assert.ok(!r.findings.some((f) => /engine off/.test(f.title)));
});

test("P018C has a plain-words text", () => assert.match(dtcText("P018C"), /sensor/));

test("guided steps are listed with their titles", () => {
  const r = analyze(log(line("STEP", { id: "begin", event: "start", preset: "quick" }, at(1)),
    line("STEP", { id: "koeo", event: "start", title: "Ignition ON, engine OFF" }, at(1)),
    line("STEP", { id: "koeo", event: "done", t: 15.2 }, at(16))));
  assert.equal(r.meta.preset, "quick");
  assert.deepEqual(r.steps.map((s) => [s.title, s.state]), [["Ignition ON, engine OFF", "done"]]);
});

test("dtcText: dictionary, misfire cylinder, family fallback", () => {
  assert.match(dtcText("P0171"), /lean/);
  assert.match(dtcText("P0304"), /cylinder 4/);
  assert.match(dtcText("U0100"), /communication/);
});

test("text, AI prompt and HTML contain the essentials", () => {
  const r = analyze(log(line("DTC", { tag: "before", type: "pending", codes: "P0302" }, at(1)), samples(30, () => ({ "0107": 14 }))));
  const t = toText(r);
  assert.match(t, /P0302/);
  assert.match(t, /VIN 1FA6P8TH0J5100000/);
  assert.match(aiPrompt(r), /plain words/);
  const h = reportHtml(r, { version: "v0.4.0" });
  assert.match(h, /Worth a look/);
  assert.match(h, /<svg class="spark"/);
  assert.equal(chartKeys(r)[0], "0107"); // the finding is charted first
});

test("thin keeps min and max of each bucket", () => {
  const pts = Array.from({ length: 1000 }, (_, i) => [i, i === 500 ? 99 : 0]);
  const out = thin(pts, 100);
  assert.ok(out.length <= 102);
  assert.ok(out.some((p) => p[1] === 99));
});
