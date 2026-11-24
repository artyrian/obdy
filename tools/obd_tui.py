#!/usr/bin/env python3
"""OBD TUI — ELM327-over-BLE reader for Ford PCM (UCSI-2100 and similar).

    pip3 install textual bleak
    python3 obd_tui.py            # real adapter
    OBD_FAKE=1 python3 obd_tui.py # demo without a car

Close Car Scanner on the phone first: the adapter accepts one connection.

Everything goes to ONE journal per run: obd_logs/YYYYMMDD_HHMMSS.log
  <date> <time.ms> <TAG> key=value ...
  KEYS  — meaning of cmd keys used in S lines (010C=RPM[rpm], 221279=Ford_DID[raw] ...)
  S     — one sample: sess= phase= t= then cmd=value
  STEP / DTC / DTC_NEW / FF / MISFIRE / MIL / ANOM / BATT / SCAN* / DIFF / STAT / RESULT / RAW / LOG
grep examples:
  grep -E " (DTC_NEW|ANOM) " obd_logs/*.log
  grep " S .*phase=hold" obd_logs/x.log | grep -o "0123=[0-9.]*"
"""
import asyncio
import os
import random
import time

from textual import on, work
from textual.app import App, ComposeResult
from textual.containers import Horizontal, ScrollableContainer, Vertical
from textual.widgets import (Button, DataTable, Footer, Header, Input, Label,
                             ProgressBar, RichLog, Select, Sparkline,
                             TabbedContent, TabPane)

NAME_HINTS = ("UCSI", "UNICAR", "UNISCAN", "OBD", "VLINK", "ELM", "IOS", "VEEPEAK", "KONNWEI")
# service UUIDs typical for BLE ELM327 clones (FFF0, FFE0, 18F0, Vgate/OBDLink custom)
OBD_UUIDS = ("0000fff0", "0000ffe0", "000018f0", "e7810a71", "0000ae30")
SKIP_SERVICES = ("00001800", "00001801", "0000180a", "0000180f")
FAKE = os.environ.get("OBD_FAKE") == "1"
KPA_PSI = 0.145038

# mode 01 decoders: pid -> (name, unit, f(bytes))
PIDS = {
    0x01: ("MIL / DTC count", "", lambda b: b[0] & 0x7F),
    0x04: ("Engine load", "%", lambda b: b[0] * 100 / 255),
    0x05: ("Coolant temp", "°C", lambda b: b[0] - 40),
    0x06: ("STFT bank 1", "%", lambda b: (b[0] - 128) * 100 / 128),
    0x07: ("LTFT bank 1", "%", lambda b: (b[0] - 128) * 100 / 128),
    0x0A: ("Fuel pressure (gauge)", "kPa", lambda b: b[0] * 3),
    0x0B: ("Intake MAP", "kPa", lambda b: b[0]),
    0x0C: ("RPM", "rpm", lambda b: u16(b) / 4),
    0x0D: ("Speed", "km/h", lambda b: b[0]),
    0x0E: ("Timing advance", "°", lambda b: b[0] / 2 - 64),
    0x0F: ("Intake air temp", "°C", lambda b: b[0] - 40),
    0x10: ("MAF", "g/s", lambda b: u16(b) / 100),
    0x11: ("Throttle", "%", lambda b: b[0] * 100 / 255),
    0x22: ("Fuel rail press. rel. manifold", "kPa", lambda b: u16(b) * 0.079),
    0x23: ("Fuel rail press. (DI high side)", "kPa", lambda b: u16(b) * 10),
    0x2F: ("Fuel level", "%", lambda b: b[0] * 100 / 255),
    0x33: ("Baro", "kPa", lambda b: b[0]),
    0x34: ("Lambda B1S1 (wideband)", "λ", lambda b: u16(b) * 2 / 65536),
    0x3C: ("Catalyst temp B1S1", "°C", lambda b: u16(b) / 10 - 40),
    0x42: ("Module voltage", "V", lambda b: u16(b) / 1000),
    0x44: ("Commanded lambda", "λ", lambda b: u16(b) * 2 / 65536),
    0x46: ("Ambient temp", "°C", lambda b: b[0] - 40),
    0x59: ("Fuel rail absolute press.", "kPa", lambda b: u16(b) * 10),
}
FUEL_PIDS = (0x0A, 0x22, 0x23, 0x59)
PRESET = ("0101,0104,0105,0106,0107,010B,010C,010D,010E,010F,0110,0111,"
          "0123,0134,0144,0142")
DTC_POLL_SEC = 20


GUIDED_DIDS = ""  # add live Ford DIDs here once found (1279/16D3/16D4/16D7 proved static)
FAST_CMDS = ["010C", "0123", "0106", "0134", "0144", "0111", "0104", "010D"]  # ~1 s/sample
MISFIRE_MIDS = ((0xA1, "all cyl"), (0xA2, "cyl 1"), (0xA3, "cyl 2"), (0xA4, "cyl 3"), (0xA5, "cyl 4"))


def _koeo(c):
    if not c.alive:
        return 0, "ECU silent — turn ignition on (Start button, no brake)", False
    return c.t / 30, f"{c.t:.0f}/30 s", c.t >= 30


def _offon(c):
    if not c.alive:
        c.acc["off"] = True
        return 0.4, "ignition off — wait 10 s, then turn it back on", False
    if not c.acc.get("off"):
        return 0.1, "turn ignition off…", False
    c.acc.setdefault("on_t", c.t)
    left = c.t - c.acc["on_t"]
    return 0.5 + left / 30, f"back on, logging fuel prime {left:.0f}/15 s", left >= 15


def _start(c):
    if c.rpm and c.rpm > 400:
        c.acc["run"] = c.acc.get("run", 0) + c.dt
    run = c.acc.get("run", 0)
    msg = "start the engine…" if not run else f"running {run:.0f}/90 s, {c.rpm or 0:.0f} rpm"
    return run / 90, msg, run >= 90


def _warm(c):
    if c.ect is None:
        return 0, "no coolant temp data", False
    e0 = c.acc.setdefault("ect0", c.ect)
    p = 1 if c.ect >= 80 else (c.ect - e0) / max(1, 80 - e0)
    return p, f"coolant {c.ect:.0f} °C → 80 °C (Next if it takes too long)", c.ect >= 80


def _hold(c):
    if c.rpm and 2200 < c.rpm < 2800:
        c.acc["hold"] = c.acc.get("hold", 0) + c.dt
    h = c.acc.get("hold", 0)
    return h / 30, f"{c.rpm or 0:.0f} rpm, in 2200–2800 band: {h:.0f}/30 s", h >= 30


def _snap(c):
    n = c.acc.get("n", 0)
    if c.rpm and c.rpm > 3500 and not c.acc.get("hi"):
        n = c.acc["n"] = n + 1
        c.acc["hi"] = True
    if c.rpm and c.rpm < 2000:
        c.acc["hi"] = False
    c.acc["peak"] = max(c.acc.get("peak", 0), c.rpm or 0)
    return n / 3, f"snaps {n}/3, peak {c.acc['peak']:.0f} rpm", n >= 3


def _idle(c):
    if c.rpm and 400 < c.rpm < 1200 and not c.spd:
        c.acc["idle"] = c.acc.get("idle", 0) + c.dt
    i = c.acc.get("idle", 0)
    return i / 60, f"idle {i:.0f}/60 s, {c.rpm or 0:.0f} rpm", i >= 60


def _drive(c):
    c.acc["vmax"] = max(c.acc.get("vmax", 0), c.spd or 0)
    c.acc["rmax"] = max(c.acc.get("rmax", 0), c.rpm or 0)
    return min(1, c.t / 600), (f"{c.t / 60:.1f} min, max {c.acc['vmax'] * 0.621:.0f} mph, "
                               f"{c.acc['rmax']:.0f} rpm — Next when back"), False


# (id, title, instructions, check, fast sampling)
STEPS = [
    ("koeo", "1/8  Ignition ON, do NOT start",
     "Fuel pump primes. Logging rail pressure, DID candidates and voltage. 30 s.",
     _koeo, False),
    ("offon", "2/8  Ignition off → 10 s → on",
     "Second prime: watch pressure build from zero. Don't start.", _offon, True),
    ("start", "3/8  Start, hands off the pedal",
     "Cold start + 90 s idle. Listen for misfire, watch the exhaust.", _start, False),
    ("warm", "4/8  Idle until warm",
     "Wait for ~80 °C. Meanwhile: coolant tank (bubbles, level), leaks under the car.", _warm, False),
    ("hold", "5/8  Hold ~2500 rpm for 30 s",
     "Steady pedal. Watching pressure and trims under constant load.", _hold, False),
    ("snap", "6/8  3 quick snaps to ~4000",
     "Snap → release, 3 times with pauses. Fast polling catches pressure dips.", _snap, True),
    ("idle", "7/8  Idle 60 s",
     "Hands off. Compared with cold idle. Keep running until \"Done\".", _idle, False),
    ("drive", "8/8  (optional) Drive 10–15 min",
     "Normal driving + 2–3 pulls to 4000 (load — this is where P008A shows). "
     "Next when back; keep the engine running until \"Done\".",
     _drive, True),
]


# deadband for journal writes: key -> min change that forces an extra S line
DEADBAND = {"010C": 50, "0123": 300, "0106": 2, "0134": 0.02, "0144": 0.02, "0111": 2,
            "0104": 5, "010D": 3}


def _moved(prev, cur):
    for k, d in DEADBAND.items():
        a, b = prev.get(k), cur.get(k)
        if isinstance(a, (int, float)) and isinstance(b, (int, float)) and abs(a - b) >= d:
            return True
    return False


class StepCtx:
    def __init__(self):
        self.t = self.dt = 0.0
        self.rpm = self.ect = self.spd = None
        self.alive = False
        self.acc = {}


def decode(cmd, b):
    """-> (name, unit, value or None)"""
    if b is None:
        return "", "", None
    if cmd.startswith("01") and len(cmd) == 4 and int(cmd[2:], 16) in PIDS:
        name, unit, f = PIDS[int(cmd[2:], 16)]
        try:
            return name, unit, f(b)
        except (IndexError, TypeError):
            return name, unit, None
    if cmd.startswith("22") and len(b) <= 2:
        return "Ford DID", "raw", (u16(b) if len(b) == 2 else b[0])
    return "", "", None


def fmt(v, unit):
    if v is None:
        return ""
    if unit == "kPa":
        return f"{v:.0f} kPa / {v * KPA_PSI:.0f} psi"
    if unit == "λ":
        return f"{v:.3f}"
    return f"{v:.1f}" if isinstance(v, float) else str(v)


def parse_mode06(resp):
    """CAN mode 06: 46 + records [MID TID UASID V(2) MIN(2) MAX(2)] -> {(mid, tid): value}"""
    if not resp.startswith("46"):
        return {}
    try:
        b = bytes.fromhex(resp[2:])
    except ValueError:
        return {}
    out = {}
    for i in range(0, len(b) - 8, 9):
        out[(b[i], b[i + 1])] = u16(b[i + 3:i + 5])
    return out


def parse_dtcs(resp, prefix):
    b = data_bytes(resp, prefix)
    if not b:
        return []
    if len(b) % 2 == 1:  # CAN: leading count byte
        b = b[1:]
    out = []
    for i in range(0, len(b) - 1, 2):
        b0, b1 = b[i], b[i + 1]
        if b0 or b1:
            out.append("PCBU"[b0 >> 6] + str((b0 >> 4) & 3) + f"{b0 & 0xF:X}{b1:02X}")
    return out


class Anomalies:
    """Rule checks on each sample; debounced log + per-rule counters."""

    def __init__(self, log, emit=None):
        self.log, self.prev, self.phase = log, {}, ""
        self.emit = emit or (lambda *a, **k: None)
        self.run_since = None
        self.count, self.first, self.last_logged = {}, {}, {}
        self.events = []

    def hit(self, rule, msg):
        now = time.time()
        self.count[rule] = self.count.get(rule, 0) + 1
        self.first.setdefault(rule, time.strftime("%H:%M:%S"))
        self.emit("ANOM", rule=rule, phase=self.phase or "-", msg=msg)
        if self.phase:
            msg = f"[{self.phase}] {msg}"
        self.events.append(f"{time.strftime('%H:%M:%S')}  {msg}")
        if now - self.last_logged.get(rule, 0) > 10:
            self.last_logged[rule] = now
            self.log(f"⚠ {msg}")

    def check(self, s, raw01=None):
        p = self.prev
        rpm, spd = s.get(0x0C), s.get(0x0D)
        running = rpm is not None and rpm > 400
        if running and not self.run_since:
            self.run_since = time.time()
        if not running:
            self.run_since = None
        settled = running and time.time() - self.run_since > 20  # ignore crank/flare
        ect = s.get(0x05)
        cold = ect is not None and ect < 50  # cat-heating strategy: retard + lean lambda
        idle = settled and spd == 0 and rpm < 1200
        if raw01 and raw01[0] & 0x80 and not (p.get("mil")):
            self.hit("mil", "MIL (check engine) is ON")
        if raw01:
            p["mil"] = bool(raw01[0] & 0x80)
        for pid, label in ((0x06, "STFT"), (0x07, "LTFT")):
            v = s.get(pid)
            if v is not None and abs(v) > 10:
                self.hit(label, f"{label} {v:+.1f}% (>±10)")
        if s.get(0x06) is not None and s.get(0x07) is not None and abs(s[0x06] + s[0x07]) > 15:
            self.hit("trim_sum", f"total fuel trim {s[0x06] + s[0x07]:+.1f}% (>±15)")
        rail, prail = s.get(0x23), p.get(0x23)
        tps, ptps = s.get(0x11), p.get(0x11)
        if settled and rail is not None:
            # no "desired" pressure PID, so only flag clearly abnormal values / unexplained drops
            if rail < 1000:
                self.hit("rail_low", f"DI rail pressure low {rail:.0f} kPa at {rpm:.0f} rpm")
            steady = abs(rpm - (p.get(0x0C) or rpm)) < 150 and (tps is None or ptps is None
                                                               or abs(tps - ptps) < 2)
            if prail and rail < prail * 0.6 and steady:
                self.hit("rail_drop", f"DI rail pressure drop {prail:.0f}->{rail:.0f} kPa "
                                      f"at steady {rpm:.0f} rpm")
        if idle and p.get(0x0C) and p[0x0C] < 1200 and p.get(0x0D) == 0 and abs(rpm - p[0x0C]) > 150:
            self.hit("idle_rpm", f"idle rpm jump {p[0x0C]:.0f}->{rpm:.0f}")
        if ect is not None and ect > 108:
            self.hit("ect_high", f"coolant {ect:.0f}°C (>108)")
        v = s.get(0x42)
        if v is not None:
            if running and not 13.0 <= v <= 15.2:
                self.hit("volt_run", f"voltage {v:.2f} V while running (13.0–15.2)")
            if not running and v < 11.8:
                self.hit("volt_off", f"voltage {v:.2f} V engine off (<11.8)")
        lam, clam = s.get(0x34), s.get(0x44)
        if settled and not cold and lam and clam and lam < 1.5 and abs(lam - clam) > 0.08:
            self.hit("lambda", f"lambda {lam:.3f} vs commanded {clam:.3f}")
        tim = s.get(0x0E)
        if idle and not cold and tim is not None and tim < -5:
            self.hit("timing", f"timing {tim:.1f}° at idle (retard)")
        self.prev = {**p, **s}

    def summary(self):
        if not self.count:
            return ["no anomalies by rules"]
        return [f"{r}: {n}x (first {self.first[r]})" for r, n in self.count.items()]


# ---------------------------------------------------------------- journal
LOG_DIR = os.environ.get("OBD_LOG_DIR", "obd_logs")


class Journal:
    """One greppable text file per app session:
    2026-11-24 00:28:01.123 TAG key=value key="value with spaces" ...
    Tags: SESSION CONN ELM KEYS S STEP DTC DTC_NEW FF MISFIRE ANOM BATT SCAN SCAN_DONE
          STAT RESULT RAW LOG
    """

    def __init__(self):
        os.makedirs(LOG_DIR, exist_ok=True)
        self.path = os.path.abspath(os.path.join(LOG_DIR, time.strftime("%Y%m%d_%H%M%S") + ".log"))
        self.f = open(self.path, "a", buffering=1)

    @staticmethod
    def _v(v):
        if isinstance(v, float):
            v = round(v, 3)
        s = str(v)
        if s == "" or any(ch in s for ch in ' ="'):
            s = '"' + s.replace('"', "'") + '"'
        return s

    def w(self, _tag, **kv):
        now = time.time()
        ts = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(now)) + f".{int(now % 1 * 1000):03d}"
        self.f.write(" ".join([ts, _tag] + [f"{k}={self._v(v)}" for k, v in kv.items()]) + "\n")

    def sample(self, values, **ctx):
        """S line: context first, then cmd=value pairs."""
        now = time.time()
        ts = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(now)) + f".{int(now % 1 * 1000):03d}"
        parts = [ts, "S"] + [f"{k}={self._v(v)}" for k, v in ctx.items()]
        parts += [f"{c}={self._v(v)}" for c, v in values.items() if v is not None]
        self.f.write(" ".join(parts) + "\n")

    def keys(self, cmds):
        """KEYS header: what each cmd column means."""
        kv = {}
        for c in cmds:
            name, unit, _ = decode(c, b"\0\0\0\0")
            kv[c] = f"{(name or 'raw').replace(' ', '_').replace('/', '')}[{unit or 'raw'}]"
        self.w("KEYS", **kv)


def read_scans(label):
    """Latest SCAN block with this label across all journals -> {did: hex}."""
    import glob
    import re
    out = {}
    for p in sorted(glob.glob(os.path.join(LOG_DIR, "*.log"))):
        cur, cur_label = {}, None
        with open(p) as fh:
            for line in fh:
                m = re.search(r" SCAN label=(\S+) did=(\w+) hex=(\w+)", line)
                if m and m.group(1) == label:
                    cur[m.group(2)] = m.group(3)
                    cur_label = label
                elif " SCAN_DONE " in line and f"label={label} " in line + " " and cur:
                    out = cur
                    cur = {}
        if cur and cur_label:
            out = cur
    return out


# ---------------------------------------------------------------- helpers
def u16(b):
    return (b[0] << 8 | b[1]) if b and len(b) >= 2 else None


def data_bytes(resp, prefix):
    if not resp.startswith(prefix):
        return None
    try:
        return bytes.fromhex(resp[len(prefix):])
    except ValueError:
        return None


def reply_prefix(cmd):
    cmd = cmd.upper()
    if cmd.startswith("01"):
        return "41" + cmd[2:4]
    if cmd.startswith("22"):
        return "62" + cmd[2:6]
    return ""


def parse_ranges(spec):
    out = []
    for part in spec.replace(" ", "").split(","):
        if not part:
            continue
        a, _, b = part.partition("-")
        out.extend(range(int(a, 16), int(b or a, 16) + 1))
    return out


# ---------------------------------------------------------------- adapter
class ELM:
    """ELM327 over a BLE notify/write characteristic pair."""

    def __init__(self, client, log):
        self.c, self.log = client, log
        self.buf, self.done, self.lock = "", asyncio.Event(), asyncio.Lock()
        self.wr = self.nt = None

    def _on_data(self, _h, data):
        self.buf += data.decode(errors="ignore")
        if ">" in self.buf:
            self.done.set()

    async def setup(self):
        for svc in self.c.services:
            if svc.uuid.lower().startswith(SKIP_SERVICES):
                continue
            nt = wr = None
            for ch in svc.characteristics:
                p = ch.properties
                if nt is None and ("notify" in p or "indicate" in p):
                    nt = ch
                if wr is None and ("write" in p or "write-without-response" in p):
                    wr = ch
            if nt and wr:
                self.nt, self.wr = nt, wr
                break
        if not (self.nt and self.wr):
            raise RuntimeError("no notify+write characteristic pair found")
        self.log(f"BLE notify={self.nt.uuid} write={self.wr.uuid}")
        await self.c.start_notify(self.nt, self._on_data)
        await init_elm(self)

    async def cmd(self, s, timeout=3.0):
        async with self.lock:
            self.buf = ""
            self.done.clear()
            resp = "write" in self.wr.properties
            await self.c.write_gatt_char(self.wr, (s + "\r").encode(), response=resp)
            try:
                await asyncio.wait_for(self.done.wait(), timeout)
            except asyncio.TimeoutError:
                return "TIMEOUT"
            return clean(self.buf, s)

    async def close(self):
        await self.c.disconnect()


class FakeELM:
    """Demo adapter: a few DIDs, one behaves like low-side pressure."""

    def __init__(self, log):
        self.log, self.t0 = log, time.time()
        self.dids = {d: bytes([random.randrange(256) for _ in range(random.choice((1, 2)))])
                     for d in random.sample(range(0x1100, 0x1200), 25)}
        self.low_did = 0x11A7
        self.rpm, self.ign = 760, True  # tests can drive these

    async def setup(self):
        await init_elm(self)

    def _pid(self, pid):
        r = random.randint
        el = time.time() - self.t0
        rpm = (self.rpm + r(-20, 20) + (200 if r(0, 30) == 0 else 0)) if self.rpm else 0
        data = {
            0x01: "81076500", 0x04: "40", 0x05: f"{min(90, 40 + int(el)) + 40:02X}",
            0x06: f"{128 + r(-6, 6):02X}", 0x07: f"{128 + 4:02X}", 0x0B: "23",
            0x0C: f"{rpm * 4:04X}", 0x0D: "00", 0x0E: f"{(10 + 64) * 2:02X}", 0x0F: "46",
            0x10: f"{300 + r(-10, 10):04X}", 0x11: "28",
            0x23: f"{(500 if r(0, 25) else 300) + r(-10, 10):04X}",
            0x34: f"{32768 + r(-600, 600):04X}8000", 0x44: "80008000",
            0x42: f"{14100 + r(-50, 50):04X}",
        }
        return data.get(pid)

    async def cmd(self, s, timeout=3.0):
        await asyncio.sleep(0.01)
        s = s.upper()
        if s.startswith("AT"):
            if s == "ATRV":
                return f"{12.4 - (time.time() - self.t0) / 600:.1f}V"
            return "ELM327 v1.5" if s == "ATI" else "OK"
        if s in ("0100", "0120", "0140"):
            return {"0100": "4100BE3FB813", "0120": "4120A007F011", "0140": "4140FED08400"}[s]
        if not self.ign and s[:2] in ("01", "02", "03", "06", "07", "0A", "22"):
            return "NODATA"
        if s.startswith("01") and len(s) == 4 and self._pid(int(s[2:], 16)):
            return "41" + s[2:] + self._pid(int(s[2:], 16))
        if s == "03":
            return "4301008A"
        if s == "07":
            return "4701008A" if time.time() - self.t0 > 30 else "4700"
        if s == "0A":
            return "4A010302"
        if s == "020200":
            return "420200008A"
        if s.startswith("02") and len(s) == 6 and self._pid(int(s[2:4], 16)):
            return "42" + s[2:] + self._pid(int(s[2:4], 16))
        if s.startswith("06A"):
            mid = s[2:4]
            n = 3 if mid == "A3" else 0
            return f"46{mid}0B24{n:04X}0000FFFF{mid}0C24{n:04X}0000FFFF"
        if s.startswith("22") and len(s) == 6:
            d = int(s[2:], 16)
            if d == self.low_did:
                kpa = 450 + random.randint(-15, 15)
                return f"62{d:04X}{kpa:04X}"
            if d in self.dids:
                return f"62{d:04X}{self.dids[d].hex().upper()}"
            return f"7F2231"
        return "NODATA"

    async def close(self):
        pass


def clean(buf, sent):
    lines = [l.strip() for l in buf.replace(">", "").replace("\r", "\n").split("\n")]
    lines = [l for l in lines if l and l != sent and not l.startswith("SEARCHING")]
    if len(lines) > 1 and all(":" in l for l in lines[1:]):  # ISO-TP multi-frame
        lines = [l.split(":", 1)[1] for l in lines[1:]]
    return "".join(lines).replace(" ", "")


async def init_elm(elm):
    for c, t in (("ATZ", 5), ("ATE0", 2), ("ATL0", 2), ("ATS0", 2), ("ATH0", 2),
                 ("ATSP6", 2), ("ATAT2", 2), ("ATSH7E0", 2)):
        await elm.cmd(c, t)
    elm.log(f"ELM: {await elm.cmd('ATI')} | 0100 -> {await elm.cmd('0100', 6)}")


# ---------------------------------------------------------------- app
class OBDApp(App):
    TITLE = "OBD BLE — Ford PCM" + ("  [DEMO]" if FAKE else "")
    CSS = """
    Screen { overflow: hidden; }
    #top { height: 3; }
    TabbedContent { height: 1fr; }
    TabbedContent ContentSwitcher { height: 1fr; }
    TabPane { height: 1fr; }
    #s-prog { height: 1; margin: 0 1; }
    #top Select { width: 46; }
    #status { padding: 1 2; }
    .bar { height: 3; }
    .bar Input { width: 1fr; }
    .bar Input.short { width: 12; }
    DataTable { height: 1fr; }
    #log { height: 9; border-top: solid $accent; }
    #dash { layout: grid; grid-size: 2; grid-rows: 6; grid-gutter: 0 1; height: 1fr; }
    .panel { border: round $accent; height: 6; padding: 0 1; }
    .panel Sparkline { height: 3; }
    #batt { padding: 1 2; width: auto; }
    #g-title { text-style: bold; color: $warning; padding: 1 1 0 1; }
    #g-text { padding: 0 1 1 1; }
    #g-prog { margin: 0 1; }
    #g-status { padding: 1 1 0 1; color: $success; }
    #g-live { padding: 1; }
    Label.hint { color: $text-muted; padding: 0 1; }
    """
    ENABLE_COMMAND_PALETTE = False
    BINDINGS = [("ctrl+q", "quit", "Quit"), ("ctrl+l", "clear_log", "Clear log")]

    def __init__(self):
        super().__init__()
        self.elm = None
        self.watching = self.scanning = self.guiding = self.g_skip = False

    # ---- layout
    def compose(self) -> ComposeResult:
        yield Header()
        with Horizontal(id="top"):
            yield Select([], prompt="Adapter (press Find)", id="dev")
            yield Button("Find", id="find")
            yield Button("Connect", id="connect", variant="primary")
            yield Button("Disconnect", id="disconnect")
            yield Label("not connected", id="status")
            yield Label("🔋 --", id="batt")
        with TabbedContent(initial="t-guided"):
            with TabPane("Guided", id="t-guided"):
                with Horizontal(classes="bar"):
                    yield Input(GUIDED_DIDS, placeholder="extra Ford DIDs (22XXXX, ...)", id="g-dids")
                    yield Button("Start session", id="g-start", variant="success")
                    yield Button("Fast: OFF", id="g-fast")
                    yield Button("Next ▶", id="g-next", variant="primary")
                    yield Button("Stop", id="g-stop", variant="error")
                yield Label("Guided diagnostics", id="g-title")
                yield Label("Connect the adapter and press Start session. Open the garage door. "
                            "Everything goes to one log: obd_logs/<time>.log.", id="g-text")
                yield ProgressBar(id="g-prog", total=100, show_eta=False)
                yield Label("", id="g-status")
                yield Label("", id="g-live")
            with TabPane("Info", id="t-info"):
                with Horizontal(classes="bar"):
                    yield Button("Read fuel pressure PIDs", id="info")
                    yield Button("Diagnostics: DTC + freeze frame + misfires", id="diag",
                                 variant="warning")
                yield Label("", id="supported", classes="hint")
                yield DataTable(id="info-table")
            with TabPane("Watch / Record", id="t-watch"):
                with Horizontal(classes="bar"):
                    yield Input(PRESET, placeholder="commands: 010C, 0123, 22XXXX, ...", id="w-cmds")
                    yield Input("0.2", placeholder="sec", id="w-int", classes="short")
                    yield Button("Preset", id="w-preset")
                    yield Button("All supported", id="w-all")
                with Horizontal(classes="bar"):
                    yield Button("Start", id="w-start", variant="success")
                    yield Button("Stop", id="w-stop", variant="error")
                yield Label(f"Every sample -> journal (S lines); anomalies -> ANOM; "
                            f"DTCs polled every {DTC_POLL_SEC}s", classes="hint")
                yield DataTable(id="w-table")
            with TabPane("Scan", id="t-scan"):
                with Horizontal(classes="bar"):
                    yield Input("1100-1FFF,DD00-DDFF", placeholder="hex ranges", id="s-ranges")
                    yield Input("off", placeholder="label (off / idle / ...)", id="s-label", classes="short")
                    yield Button("Start", id="s-start", variant="success")
                    yield Button("Stop", id="s-stop", variant="error")
                yield ProgressBar(id="s-prog", show_eta=True)
                yield DataTable(id="s-table")
            with TabPane("Diff", id="t-diff"):
                with Horizontal(classes="bar"):
                    yield Input("off", placeholder="scan label A", id="d-a")
                    yield Input("idle", placeholder="scan label B", id="d-b")
                    yield Button("Compare", id="d-run", variant="primary")
                yield Label("Enter on a row -> add DID to Watch", classes="hint")
                yield DataTable(id="d-table", cursor_type="row")
            with TabPane("Dash", id="t-dash"):
                yield Label("Live graphs of the commands in Watch / Record (last ~150 samples). "
                            "Start recording there.", classes="hint")
                yield ScrollableContainer(id="dash")
            with TabPane("Raw", id="t-raw"):
                with Horizontal(classes="bar"):
                    yield Input(placeholder="e.g. ATRV, 010C, 22F40D", id="r-cmd")
                    yield Button("Send", id="r-send", variant="primary")
                yield Label("Response goes to the log below", classes="hint")
        yield RichLog(id="log", markup=False, wrap=True)
        yield Footer()

    def on_mount(self):
        t = self.query_one("#info-table", DataTable)
        t.add_columns("PID", "Name", "kPa", "psi", "Advertised")
        t = self.query_one("#w-table", DataTable)
        for k in ("cmd", "name", "value", "unit", "raw", "min", "max", "time"):
            t.add_column(k, key=k)
        self.query_one("#s-table", DataTable).add_columns("DID", "hex", "u16")
        self.query_one("#d-table", DataTable).add_columns("DID", "A", "B", "u16 A", "u16 B", "Δ")
        self.set_interval(15, self.poll_batt)
        self.j = Journal()
        self.j.w("SESSION", event="start", fake=FAKE, journal=self.j.path)
        self.log_line(f"journal: {self.j.path}")
        if FAKE:
            self.query_one("#dev", Select).set_options([("DEMO adapter", "fake")])
            self.query_one("#dev", Select).value = "fake"

    # ---- utils
    def log_line(self, msg):
        self.query_one("#log", RichLog).write(f"{time.strftime('%H:%M:%S')}  {msg}")
        if hasattr(self, "j"):
            self.j.w("LOG", msg=msg)

    def action_clear_log(self):
        self.query_one("#log", RichLog).clear()

    def status(self, msg):
        self.query_one("#status", Label).update(msg)

    # ---- battery (ATRV = voltage at OBD pin 16, read by the adapter itself)
    @work(group="batt")
    async def poll_batt(self):
        if not self.elm:
            return
        r = await self.elm.cmd("ATRV", 2)
        try:
            v = float(r.rstrip("Vv"))
        except ValueError:
            return
        rpm = None
        if not self.scanning:
            b = data_bytes(await self.elm.cmd("010C", 2), "410C")
            rpm = u16(b) / 4 if b else None
        if rpm and rpm > 400:
            state = "charging" if v >= 13.2 else "⚠ not charging?"
        else:
            soc = max(0, min(100, (v - 11.9) / (12.7 - 11.9) * 100))
            state = f"~{soc:.0f}% (rough, ignition load)"
            if v < 12.0:
                state += "  ⚠ LOW — start engine or disconnect"
        self.query_one("#batt", Label).update(f"🔋 {v:.2f} V {state}")
        self.j.w("BATT", v=v, rpm=rpm or 0, state=state)
        if v < 12.0 and not (rpm and rpm > 400):
            self.log_line(f"⚠ battery {v:.2f} V — start the engine or switch ignition off")
            self.bell()

    def need_elm(self):
        if not self.elm:
            self.log_line("not connected")
            return False
        return True

    # ---- connection
    @on(Button.Pressed, "#find")
    @work(exclusive=True, group="ble")
    async def find(self):
        if FAKE:
            return
        from bleak import BleakScanner
        self.status("scanning BLE...")
        found = await BleakScanner.discover(timeout=6.0, return_adv=True)
        opts = []
        for addr, (dev, adv) in sorted(found.items(), key=lambda kv: -kv[1][1].rssi):
            name = dev.name or adv.local_name or "?"
            uuids = [u.lower() for u in (adv.service_uuids or [])]
            obd_uuid = any(u.startswith(OBD_UUIDS) for u in uuids)
            star = "★ " if obd_uuid or any(h in name.upper() for h in NAME_HINTS) else ""
            svc = ",".join(u[4:8] if u.endswith("-0000-1000-8000-00805f9b34fb") else u[:8]
                           for u in uuids)
            opts.append((f"{star}{name}  {adv.rssi}dBm  {addr[-8:]}  {svc}", addr))
            self.log_line(f"BLE {addr}  {name!r}  {adv.rssi}dBm  svc=[{svc}]")
        opts.sort(key=lambda o: not o[0].startswith("★"))
        sel = self.query_one("#dev", Select)
        sel.set_options(opts)
        if opts and opts[0][0].startswith("★"):
            sel.value = opts[0][1]
        self.status(f"found {len(opts)} devices")

    @on(Button.Pressed, "#connect")
    @work(exclusive=True, group="ble")
    async def connect(self):
        addr = self.query_one("#dev", Select).value
        if not isinstance(addr, str):
            self.log_line("pick an adapter first (Find)")
            return
        if self.elm:
            await self.elm.close()
        self.status("connecting...")
        try:
            if addr == "fake":
                elm = FakeELM(self.log_line)
            else:
                from bleak import BleakClient
                client = BleakClient(addr, disconnected_callback=self._lost)
                await client.connect(timeout=15)
                elm = ELM(client, self.log_line)
            await elm.setup()
            self.elm = elm
            self.status(f"connected {addr[-8:]}")
            self.j.w("CONN", event="connected", addr=addr)
            self.poll_batt()
        except Exception as e:  # noqa: BLE001
            self.status("connect failed")
            self.log_line(f"connect error: {e!r}")

    def _lost(self, _client):
        self.j.w("CONN", event="lost")
        self.elm = None
        self.watching = self.scanning = False
        self.call_later(self.status, "disconnected")

    @on(Button.Pressed, "#disconnect")
    async def disconnect(self):
        self.watching = self.scanning = False
        if self.elm:
            await self.elm.close()
            self.elm = None
        self.status("not connected")

    # ---- info
    @on(Button.Pressed, "#info")
    @work(exclusive=True, group="io")
    async def info(self):
        if not self.need_elm():
            return
        sup = await self.supported()
        self.query_one("#supported", Label).update(
            "Supported mode 01: " + " ".join(f"{p:02X}" for p in sorted(sup)))
        t = self.query_one("#info-table", DataTable)
        t.clear()
        for pid in FUEL_PIDS:
            b = data_bytes(await self.elm.cmd(f"01{pid:02X}"), f"41{pid:02X}")
            _, _, kpa = decode(f"01{pid:02X}", b)
            t.add_row(f"01{pid:02X}", PIDS[pid][0],
                      f"{kpa:.0f}" if kpa is not None else "no data",
                      f"{kpa * KPA_PSI:.1f}" if kpa is not None else "",
                      "yes" if pid in sup else "no")
        await self.read_dtcs()

    @on(Button.Pressed, "#diag")
    @work(exclusive=True, group="io")
    async def diag(self):
        if not self.need_elm():
            return
        self.log_line("=== DIAGNOSTICS ===")
        st = data_bytes(await self.elm.cmd("0101"), "4101")
        if st:
            self.j.w("MIL", on=bool(st[0] & 0x80), dtc_count=st[0] & 0x7F)
            self.log_line(f"MIL {'ON' if st[0] & 0x80 else 'off'}, DTC count {st[0] & 0x7F}")
        await self.read_dtcs()
        ff = data_bytes(await self.elm.cmd("020200", 5), "420200")
        if ff and len(ff) >= 2 and (ff[0] or ff[1]):
            code = parse_dtcs("43" + ff[:2].hex(), "43")
            self.log_line(f"freeze frame for {code[0] if code else ff.hex()}:")
            ffv = {}
            for pid in (0x04, 0x05, 0x06, 0x07, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x11, 0x23, 0x42):
                b = data_bytes(await self.elm.cmd(f"02{pid:02X}00"), f"42{pid:02X}00")
                name, unit, v = decode(f"01{pid:02X}", b)
                if v is not None:
                    ffv[f"01{pid:02X}"] = v
                    self.log_line(f"  FF {name}: {fmt(v, unit)} {'' if unit == 'kPa' else unit}")
            self.j.w("FF", dtc=code[0] if code else ff.hex(), **ffv)
        else:
            self.log_line("freeze frame: none")
        await self.read_misfires()
        vin = await self.elm.cmd("0902", 5)
        self.j.w("VIN", raw=vin)
        self.log_line(f"VIN raw: {vin}")
        self.log_line("=== END ===")

    async def read_ff(self, quiet=False):
        ff = data_bytes(await self.elm.cmd("020200", 5), "420200")
        if not (ff and len(ff) >= 2 and (ff[0] or ff[1])):
            return {}
        code = parse_dtcs("43" + ff[:2].hex(), "43")
        out = {"dtc": code[0] if code else ff.hex()}
        for pid in (0x04, 0x05, 0x06, 0x07, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x11, 0x23, 0x42):
            b = data_bytes(await self.elm.cmd(f"02{pid:02X}00"), f"42{pid:02X}00")
            _, _, v = decode(f"01{pid:02X}", b)
            if v is not None:
                out[f"01{pid:02X}"] = v
        if not quiet:
            self.log_line(f"freeze frame: {out}")
        return out

    async def read_misfires(self, tag="read"):
        self.log_line("misfire counters (mode 06; this/last cycle, avg 10 cycles):")
        out = {}
        for mid, label in MISFIRE_MIDS:
            r = await self.elm.cmd(f"06{mid:02X}", 5)
            recs = parse_mode06(r)
            cur, avg = recs.get((mid, 0x0C)), recs.get((mid, 0x0B))
            out[label] = (cur, avg)
            self.j.w("MISFIRE", tag=tag, cyl=label, cycle=cur if cur is not None else "",
                     avg10=avg if avg is not None else "", raw=r)
            if cur is None and avg is None:
                self.log_line(f"  {label}: no data")
            else:
                warn = "  ⚠" if (cur or 0) > 0 or (avg or 0) > 0 else ""
                self.log_line(f"  {label}: cycle {cur}, avg {avg}{warn}")
        return out

    # ---- guided session
    @on(Button.Pressed, "#g-next")
    def g_next(self):
        self.g_skip = True

    @on(Button.Pressed, "#g-fast")
    def g_fast_toggle(self):
        self.g_fast = not getattr(self, "g_fast", False)
        self.query_one("#g-fast", Button).label = f"Fast: {'ON' if self.g_fast else 'OFF'}"
        self.log_line(f"fast polling {'ON' if self.g_fast else 'OFF'} "
                      f"({len(FAST_CMDS)} key params, ~1 s; full set ~2.5 s)")
        if hasattr(self, "j"):
            self.j.w("LOG", msg=f"fast={self.g_fast}")

    @on(Button.Pressed, "#g-stop")
    def g_stop(self):
        self.guiding = False

    @on(Button.Pressed, "#g-start")
    @work(exclusive=True, group="io")
    async def guided(self):
        if not self.need_elm():
            return
        dids = [c.strip().upper() for c in self.query_one("#g-dids", Input).value.split(",") if c.strip()]
        full = ["010C"] + [c.strip() for c in PRESET.split(",") if c.strip() != "010C"] + dids
        fast = FAST_CMDS + dids
        title, text = self.query_one("#g-title", Label), self.query_one("#g-text", Label)
        status, live = self.query_one("#g-status", Label), self.query_one("#g-live", Label)
        prog = self.query_one("#g-prog", ProgressBar)
        self.guiding, self.g_skip = True, False
        sess = time.strftime("g%H%M%S")
        J = self.j
        J.w("STEP", sess=sess, id="begin", event="start")
        J.keys(full)
        title.update("0/8  Pre-test snapshot")
        text.update("Reading DTCs, freeze frame and misfire counters…")
        self.log_line(f"=== GUIDED {sess} -> {J.path} ===")
        before_dtc = await self.read_dtcs(tag="before")
        before_mis = await self.read_misfires(tag="before")
        J.w("BATT", v=(await self.elm.cmd("ATRV", 2)).rstrip("Vv"), tag="before")
        an = Anomalies(self.log_line, J.w)
        dtcs_seen = {c for v in before_dtc.values() for c in v}
        stats = {}  # phase -> cmd -> [n, sum, min, max]
        mis_live = {}
        last_dtc = time.time()
        for sid, stitle, stext, check, is_fast in STEPS:
            if not (self.guiding and self.elm):
                break
            title.update(stitle)
            text.update(stext)
            an.phase = sid
            J.w("STEP", sess=sess, id=sid, event="start", title=stitle)
            ctx, self.g_skip = StepCtx(), False
            ts0 = last = time.time()
            last_w, last_vals = 0.0, {}
            while self.guiding and self.elm:
                cmds = fast if (is_fast or getattr(self, "g_fast", False)) else full
                sample, vals, raw01 = {}, {}, None
                for c in cmds:
                    r = await self.elm.cmd(c, 2)
                    b = data_bytes(r, reply_prefix(c))
                    if c == "010C":
                        ctx.alive = b is not None
                        if not ctx.alive:
                            vals["ecu"] = r
                            break  # ECU asleep: don't wait on every command
                    _, unit, v = decode(c, b)
                    if c == "0101":
                        raw01 = b
                    if v is not None:
                        vals[c] = v
                        if c.startswith("01"):
                            sample[int(c[2:], 16)] = v
                        st = stats.setdefault(sid, {}).setdefault(c, [0, 0.0, v, v])
                        st[0] += 1
                        st[1] += v
                        st[2], st[3] = min(st[2], v), max(st[3], v)
                    elif b is not None:
                        vals[c] = b.hex()
                now = time.time()
                ctx.dt, last = now - last, now
                ctx.t = now - ts0
                ctx.rpm, ctx.ect, ctx.spd = sample.get(0x0C), sample.get(0x05), sample.get(0x0D)
                if ctx.alive:
                    an.check(sample, raw01)
                p, msg, ok = check(ctx)
                # write every ≥1 s, or immediately if something moved noticeably
                if now - last_w >= 1.0 or _moved(last_vals, vals) or not ctx.alive:
                    J.sample(vals, sess=sess, phase=sid, t=round(ctx.t, 2))
                    last_w, last_vals = now, dict(vals)
                prog.update(progress=max(0, min(100, p * 100)))
                status.update(("✔ " if ok else "▶ ") + msg)
                live.update(self._live_text(vals))
                if ctx.alive and now - last_dtc > DTC_POLL_SEC:
                    last_dtc = now
                    if ctx.rpm and ctx.rpm > 400:  # live misfire counters (current cycle)
                        for mid, lab in MISFIRE_MIDS[1:]:
                            recs = parse_mode06(await self.elm.cmd(f"06{mid:02X}", 3))
                            cur = recs.get((mid, 0x0C))
                            if cur is None:
                                continue
                            J.w("MISFIRE", tag="live", sess=sess, phase=sid, cyl=lab, cycle=cur,
                                rpm=ctx.rpm, ect=ctx.ect or "")
                            if cur > mis_live.get(lab, 0):
                                an.hit(f"misfire_{lab}", f"misfires {lab}: {mis_live.get(lab, 0)}->{cur}"
                                       f" (ect {ctx.ect}, {ctx.rpm:.0f} rpm)")
                            mis_live[lab] = cur
                    for m, label in (("07", "pending"), ("03", "stored")):
                        for code in parse_dtcs(await self.elm.cmd(m, 5), f"4{m[1]}"):
                            if code not in dtcs_seen:
                                dtcs_seen.add(code)
                                J.w("DTC_NEW", sess=sess, phase=sid, type=label, code=code,
                                    rpm=ctx.rpm or 0, ect=ctx.ect or "")
                                if code.startswith(("P0", "P1")):
                                    ff = await self.read_ff(quiet=True)
                                    if ff:
                                        J.w("FF", sess=sess, phase=sid, **ff)
                                an.hit(f"dtc_{code}", f"NEW {label} DTC {code}"
                                       + (f" at {ctx.rpm:.0f} rpm" if ctx.rpm else ""))
                if ok or self.g_skip:
                    res = "done" if ok else "skipped"
                    J.w("STEP", sess=sess, id=sid, event=res, t=round(ctx.t, 1), status=msg)
                    self.log_line(f"step {sid}: {res} ({ctx.t:.0f}s)")
                    break
                if not is_fast:
                    await asyncio.sleep(0.1)
        title.update("Post-test snapshot — keep the engine running")
        text.update("Reading DTCs and misfire counters again…")
        alive = self.elm and data_bytes(await self.elm.cmd("010C", 2), "410C") is not None
        if not alive:
            J.w("RESULT", sess=sess, what="after_snapshot", status="skipped_ecu_off")
            self.log_line("⚠ after-snapshot skipped: ECU not answering (engine/ignition off?)")
        if alive:
            after_dtc = await self.read_dtcs(tag="after")
            after_mis = await self.read_misfires(tag="after")
            J.w("BATT", v=(await self.elm.cmd("ATRV", 2)).rstrip("Vv"), tag="after")
            for m, n in (("03", "stored"), ("07", "pending"), ("0A", "permanent")):
                J.w("RESULT", sess=sess, what=f"dtc_{n}", before=",".join(before_dtc.get(m, [])) or "-",
                    after=",".join(after_dtc.get(m, [])) or "-")
            for _, lab in MISFIRE_MIDS:
                J.w("RESULT", sess=sess, what="misfire", cyl=lab, before=before_mis.get(lab),
                    after=after_mis.get(lab))
        for sid, cs in stats.items():
            for c in full:
                if c in cs:
                    n, sm, lo, hi = cs[c]
                    J.w("STAT", sess=sess, phase=sid, key=c, min=lo, mean=sm / n, max=hi, n=n)
        for line in an.summary():
            J.w("RESULT", sess=sess, what="anomalies", summary=line)
        J.w("STEP", sess=sess, id="end", event="done")
        title.update("Done ✔")
        text.update(f"Log: {J.path}\nSession: {sess}. Send the log file for review.")
        self.guiding = False
        self.log_line(f"=== GUIDED {sess} DONE ===")

    def _live_text(self, vals):
        keys = (("010C", "RPM"), ("0105", "Coolant °C"), ("0123", "Rail kPa"), ("0106", "STFT %"),
                ("0107", "LTFT %"), ("0142", "Volt"), ("010D", "km/h"), ("0111", "Throttle %"))
        parts = []
        for c, n in keys:
            v = vals.get(c)
            if v is not None:
                parts.append(f"{n}: {v:.1f}" if isinstance(v, float) else f"{n}: {v}")
        extra = [f"{c}: {v}" for c, v in vals.items() if c.startswith("22")]
        if "ecu" in vals:
            parts.append(f"ECU: {vals['ecu']}")
        return "   ".join(parts) + ("\n" + "   ".join(extra) if extra else "")

    async def supported(self):
        sup = set()
        for base in (0x00, 0x20, 0x40):
            b = data_bytes(await self.elm.cmd(f"01{base:02X}"), f"41{base:02X}")
            if not b:
                break
            bits = int.from_bytes(b[:4], "big")
            sup |= {base + i + 1 for i in range(32) if bits >> (31 - i) & 1}
        return sup

    async def read_dtcs(self, modes=("03", "07", "0A"), tag="read"):
        names = {"03": "stored", "07": "pending", "0A": "permanent"}
        found = {}
        for m in modes:
            r = await self.elm.cmd(m, 5)
            codes = parse_dtcs(r, f"4{m[1]}")
            found[m] = codes
            self.j.w("DTC", tag=tag, type=names[m], codes=",".join(codes) or "-", raw=r)
            self.log_line(f"DTC {names[m]}: {', '.join(codes) or 'none'}")
        return found

    # ---- watch
    @on(Button.Pressed, "#w-start")
    @work(exclusive=True, group="io")
    async def watch(self):
        if not self.need_elm():
            return
        cmds = [c.strip().upper() for c in self.query_one("#w-cmds", Input).value.split(",") if c.strip()]
        try:
            interval = float(self.query_one("#w-int", Input).value)
        except ValueError:
            interval = 0.2
        J = self.j
        sess = time.strftime("w%H%M%S")
        t = self.query_one("#w-table", DataTable)
        t.clear()
        stats = {}
        for c in cmds:
            name, _, _ = decode(c, b"\x00\x00\x00\x00")
            t.add_row(c, name, "", "", "", "", "", "", key=c)
        dash = self.query_one("#dash")
        await dash.remove_children()
        hist = {}
        for c in cmds:
            if c == "0101":
                continue
            hist[c] = []
            name, _, _ = decode(c, b"\x00\x00\x00\x00")
            await dash.mount(Vertical(Label(f"{c} {name}", id=f"dl-{c}"),
                                      Sparkline([], id=f"ds-{c}"), classes="panel"))
        dead, misses = set(), {}  # commands that never answer get skipped after 3 tries
        an = Anomalies(self.log_line, J.w)
        an.phase = sess
        J.w("STEP", sess=sess, id="watch", event="start")
        J.keys(cmds)
        self.log_line(f"recording {sess} -> {J.path}")
        dtcs_seen = {c for v in (await self.read_dtcs(tag="before")).values() for c in v}
        t0 = last_dtc = time.time()
        self.watching = True
        while self.watching and self.elm:
            sample, vals, raw01 = {}, {}, None
            for c in cmds:
                if c in dead:
                    continue
                r = await self.elm.cmd(c)
                b = data_bytes(r, reply_prefix(c))
                if b is None:
                    misses[c] = misses.get(c, 0) + 1
                    if misses[c] >= 3 and c not in stats:
                        dead.add(c)
                        self.log_line(f"{c}: no answer ({r}), skipping")
                name, unit, v = decode(c, b)
                if c == "0101":
                    raw01 = b
                if v is not None:
                    vals[c] = v
                    if c.startswith("01"):
                        sample[int(c[2:], 16)] = v
                    lo, hi = stats.get(c, (v, v))
                    stats[c] = (min(lo, v), max(hi, v))
                elif b is not None:
                    vals[c] = b.hex()
                lo, hi = stats.get(c, (None, None))
                if v is not None and c in hist:
                    hist[c] = (hist[c] + [float(v)])[-150:]
                    try:
                        self.query_one(f"#ds-{c}", Sparkline).data = hist[c]
                        self.query_one(f"#dl-{c}", Label).update(
                            f"{c} {name}: [b]{fmt(v, unit)}[/b] {'' if unit == 'kPa' else unit}"
                            f"   min {fmt(lo, unit)}  max {fmt(hi, unit)}")
                    except Exception:  # noqa: BLE001 (dash not mounted)
                        pass
                for col, val in (("value", fmt(v, unit) if v is not None else r),
                                 ("unit", unit), ("raw", b.hex().upper() if b else ""),
                                 ("min", fmt(lo, unit)), ("max", fmt(hi, unit)),
                                 ("time", time.strftime("%H:%M:%S"))):
                    t.update_cell(c, col, val)
            an.check(sample, raw01)
            J.sample(vals, sess=sess, phase="watch", t=round(time.time() - t0, 2))
            if time.time() - last_dtc > DTC_POLL_SEC:
                last_dtc = time.time()
                for m, label in (("07", "pending"), ("03", "stored")):
                    for code in parse_dtcs(await self.elm.cmd(m, 5), f"4{m[1]}"):
                        if code not in dtcs_seen:
                            dtcs_seen.add(code)
                            rpm = sample.get(0x0C)
                            J.w("DTC_NEW", sess=sess, phase="watch", type=label, code=code, rpm=rpm or 0)
                            an.hit(f"dtc_{code}", f"NEW {label} DTC {code}"
                                   + (f" at {rpm:.0f} rpm" if rpm else ""))
            await asyncio.sleep(interval)
        for c, (lo, hi) in stats.items():
            J.w("STAT", sess=sess, phase="watch", key=c, min=lo, max=hi)
        for line in an.summary():
            J.w("RESULT", sess=sess, what="anomalies", summary=line)
        J.w("STEP", sess=sess, id="watch", event="stop", t=round(time.time() - t0, 1))
        self.log_line(f"stopped {sess} after {time.time() - t0:.0f}s")
        for line in an.summary():
            self.log_line(f"  {line}")

    @on(Button.Pressed, "#w-stop")
    def stop_watch(self):
        self.watching = False

    @on(Button.Pressed, "#w-preset")
    def preset(self):
        self.query_one("#w-cmds", Input).value = PRESET

    @on(Button.Pressed, "#w-all")
    @work(exclusive=True, group="io")
    async def all_supported(self):
        if not self.need_elm():
            return
        sup = await self.supported()
        dids = [c.strip() for c in self.query_one("#w-cmds", Input).value.split(",")
                if c.strip().upper().startswith("22")]
        cmds = [f"01{p:02X}" for p in sorted(sup) if p in PIDS] + dids
        self.query_one("#w-cmds", Input).value = ", ".join(cmds)
        self.log_line(f"{len(cmds)} commands selected (supported & decodable)")

    # ---- scan
    @on(Button.Pressed, "#s-start")
    @work(exclusive=True, group="io")
    async def scan(self):
        if not self.need_elm():
            return
        spec = self.query_one("#s-ranges", Input).value
        try:
            dids = parse_ranges(spec)
        except ValueError:
            self.log_line("bad ranges, use e.g. 1100-1FFF,DD00-DDFF")
            return
        label = self.query_one("#s-label", Input).value.strip() or "scan"
        prog = self.query_one("#s-prog", ProgressBar)
        prog.update(total=len(dids), progress=0)
        t = self.query_one("#s-table", DataTable)
        t.clear()
        self.scanning = True
        hits, t0, done = 0, time.time(), 0
        rpm_b = data_bytes(await self.elm.cmd("010C", 2), "410C")
        self.j.w("SCAN_START", label=label, ranges=spec, n=len(dids),
                 rpm=(u16(rpm_b) / 4 if rpm_b else "off"))
        for d in dids:
            if not (self.scanning and self.elm):
                break
            b = data_bytes(await self.elm.cmd(f"22{d:04X}", 1.5), f"62{d:04X}")
            if b is not None:
                hits += 1
                self.j.w("SCAN", label=label, did=f"{d:04X}", hex=b.hex(),
                         u16=(u16(b) if len(b) == 2 else ""))
                t.add_row(f"{d:04X}", b.hex().upper(), str(u16(b) if len(b) == 2 else ""))
            done += 1
            prog.advance(1)
        complete = done == len(dids)
        self.scanning = False
        self.j.w("SCAN_DONE", label=label, hits=hits, done=done, total=len(dids),
                 complete=complete, sec=round(time.time() - t0))
        self.log_line(f"scan '{label}': {hits} DIDs, {done}/{len(dids)} "
                      f"{'complete' if complete else 'INCOMPLETE'} ({time.time() - t0:.0f}s)")

    @on(Button.Pressed, "#s-stop")
    def stop_scan(self):
        self.scanning = False

    # ---- diff
    @on(Button.Pressed, "#d-run")
    def diff(self):
        la = self.query_one("#d-a", Input).value.strip()
        lb = self.query_one("#d-b", Input).value.strip()
        a, b = read_scans(la), read_scans(lb)
        if not a or not b:
            self.log_line(f"diff: no SCAN data for label '{la if not a else lb}' in {LOG_DIR}/")
            return
        t = self.query_one("#d-table", DataTable)
        t.clear()
        n = 0
        for did in sorted(set(a) | set(b)):
            if a.get(did) == b.get(did):
                continue
            ha, hb = a.get(did, ""), b.get(did, "")
            ba, bb = bytes.fromhex(ha), bytes.fromhex(hb)
            ua = u16(ba) if len(ba) == 2 else None
            ub = u16(bb) if len(bb) == 2 else None
            delta = str(ub - ua) if ua is not None and ub is not None else ""
            t.add_row(did, ha.upper() or "-", hb.upper() or "-",
                      "" if ua is None else str(ua), "" if ub is None else str(ub), delta, key=did)
            self.j.w("DIFF", a=la, b=lb, did=did, hex_a=ha or "-", hex_b=hb or "-",
                     u16_a=ua if ua is not None else "", u16_b=ub if ub is not None else "")
            n += 1
        self.log_line(f"diff {la} vs {lb}: {n} DIDs changed")

    @on(DataTable.RowSelected, "#d-table")
    def diff_to_watch(self, ev: DataTable.RowSelected):
        did = str(ev.row_key.value)
        inp = self.query_one("#w-cmds", Input)
        cmds = [c.strip() for c in inp.value.split(",") if c.strip()]
        if f"22{did}" not in cmds:
            cmds.append(f"22{did}")
        inp.value = ", ".join(cmds)
        self.log_line(f"added 22{did} to Watch")

    # ---- raw
    @on(Button.Pressed, "#r-send")
    @on(Input.Submitted, "#r-cmd")
    @work(group="io")
    async def raw(self):
        if not self.need_elm():
            return
        c = self.query_one("#r-cmd", Input).value.strip().upper()
        if c:
            r = await self.elm.cmd(c, 5)
            self.j.w("RAW", cmd=c, resp=r)
            self.log_line(f"> {c}   < {r}")

    async def on_unmount(self):
        self.j.w("SESSION", event="end")
        if self.elm:
            await self.elm.close()


if __name__ == "__main__":
    OBDApp().run()
