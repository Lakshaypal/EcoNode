#!/usr/bin/env python3
"""
LoRa USB receiver → WebSocket bridge for EcoNode dashboard.

Demo: LoRa receiver module connected to laptop (USB serial). Packets from the
field node are newline-terminated JSON or CSV.

JSON (preferred), one object per line:
  {"mac":"AA:BB:CC:DD:EE:01","aqi":65,"rain":0.2,"moisture":58,"temp":26.5,
   "rh":62,"uv":4,"lux":420,"pH":6.4,"npk":210,"rssi":-88}

CSV (Arduino-friendly), same field order:
  MAC,aqi,rain,moisture,temp,rh,uv,lux,pH,npk,rssi

Downlink: dashboard sends JSON {"type":"downlink","payload":"SERVO:0:90\\n"}
which is written to serial (LoRa module TX to field).

Env:
  LORA_SERIAL   e.g. /dev/ttyUSB0  /dev/cu.usbserial-*  COM3  (empty = WS only)
  LORA_BAUD     default 9600
  WS_HOST       default 127.0.0.1
  WS_PORT       default 8765
"""

from __future__ import annotations

import asyncio
import json
import os
import sys

try:
    import websockets
except ImportError:
    print("Install deps: pip install -r requirements.txt", file=sys.stderr)
    raise

try:
    import serial
except ImportError:
    serial = None  # type: ignore

WS_HOST = os.environ.get("WS_HOST", "127.0.0.1")
WS_PORT = int(os.environ.get("WS_PORT", "8765"))
SERIAL_PATH = os.environ.get("LORA_SERIAL", "").strip()
BAUD = int(os.environ.get("LORA_BAUD", "9600"))

def normalize_mac(m: str) -> str:
    s = m.strip().upper()
    parts = s.split(":") if ":" in s else s.split("-")
    if len(parts) == 6 and all(len(p) == 2 for p in parts):
        return ":".join(p.upper() for p in parts)
    return s


def parse_serial_line(line: str) -> dict | None:
    line = line.strip()
    if not line:
        return None
    try:
        obj = json.loads(line)
        if isinstance(obj, dict) and "mac" in obj:
            obj["mac"] = normalize_mac(str(obj["mac"]))
            return obj
    except json.JSONDecodeError:
        pass
    parts = [p.strip() for p in line.split(",")]
    if len(parts) < 11:
        return None
    mac, aqi, rain, mo, te, rh, uv, lx, ph, npk, rssi = parts[:11]
    try:
        return {
            "mac": normalize_mac(mac),
            "aqi": float(aqi),
            "rain": float(rain),
            "moisture": float(mo),
            "temp": float(te),
            "rh": float(rh),
            "uv": float(uv),
            "lux": float(lx),
            "pH": float(ph),
            "npk": float(npk),
            "rssi": float(rssi),
        }
    except ValueError:
        return None


class Bridge:
    def __init__(self) -> None:
        self.clients: set = set()
        self.ser = None
        if SERIAL_PATH and serial:
            try:
                self.ser = serial.Serial(SERIAL_PATH, BAUD, timeout=0.05)
                print(f"Serial open: {SERIAL_PATH} @ {BAUD}", flush=True)
            except OSError as e:
                print(f"Serial failed ({e}); WebSocket-only mode.", flush=True)

    async def broadcast(self, msg: dict) -> None:
        raw = json.dumps(msg)
        dead = []
        for ws in self.clients:
            try:
                await ws.send(raw)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)

    async def serial_loop(self) -> None:
        if not self.ser:
            return
        while True:
            try:
                line = self.ser.readline().decode("utf-8", errors="ignore")
                payload = parse_serial_line(line)
                if payload:
                    await self.broadcast({"type": "telemetry", "payload": payload})
            except Exception as exc:
                print("serial_loop:", exc, flush=True)
            await asyncio.sleep(0.01)

    async def handler(self, ws):
        self.clients.add(ws)
        try:
            await ws.send(json.dumps({"type": "hello", "serial": bool(self.ser)}))
            async for message in ws:
                try:
                    data = json.loads(message)
                except json.JSONDecodeError:
                    continue
                if not isinstance(data, dict):
                    continue
                mtype = data.get("type")
                if mtype == "downlink" and self.ser:
                    pl = data.get("payload", "")
                    if isinstance(pl, str) and pl:
                        b = pl.encode("utf-8")
                        if not pl.endswith("\n"):
                            b += b"\n"
                        self.ser.write(b)
                        await self.broadcast(
                            {"type": "bridge_log", "payload": f"TX serial: {pl.strip()}"}
                        )
                elif mtype == "register_node":
                    await self.broadcast({"type": "node_registered", "payload": data})
        finally:
            self.clients.discard(ws)

    async def run(self) -> None:
        async with websockets.serve(self.handler, WS_HOST, WS_PORT):
            task = None
            if self.ser:
                task = asyncio.create_task(self.serial_loop())
            print(
                f"LoRa bridge listening ws://{WS_HOST}:{WS_PORT} "
                f"(serial={'yes' if self.ser else 'no'})",
                flush=True,
            )
            try:
                await asyncio.Future()
            finally:
                if task:
                    task.cancel()


if __name__ == "__main__":
    asyncio.run(Bridge().run())
