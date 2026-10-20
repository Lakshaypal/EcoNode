# EcoNode — Ultra-Low-Power Smart Farm Node

A Semixthon smart-agriculture project combining an ESP32-S3 sensor-node design with a React monitoring dashboard and a Python serial-to-WebSocket bridge. This repository contains the **dashboard and bridge software**.

## Hardware project

The project reports an ESP32-S3 PCB with MOSFET-based sensor power gating, SX1278 LoRa communication at 433 MHz, and solar-assisted power management.

| Reported specification | Value |
| --- | --- |
| Node current before / after power gating | 150 mA → approximately 0.65 mA |
| Current reduction from those figures | approximately **99.57%** |
| Sensor channels | 9, plus RSSI link telemetry |
| LoRa range | approximately 2 km |
| Off-grid operation | approximately 6 months |

These are author-reported hardware figures. PCB/CAD files, ESP32 firmware, range-test records, current measurements and a battery/solar budget are not included here. The dashboard does not measure or establish these results; current reduction is not itself a battery-life calculation.

## Software features

- Nine sensor channels: air quality, rain, soil moisture, temperature, relative humidity, UV, light, pH and NPK; RSSI is displayed separately.
- Per-node views, network averages, recent sensor trends and an activity log.
- JSON or CSV telemetry from a USB-connected LoRa receiver through a Python WebSocket bridge.
- Pump, valve, servo and sleep/wake command controls for compatible receiver/node firmware.
- Farming recommendations generated from rules and templates using the current readings.
- A browser-side demonstration of a 15-minute sleep / 3-second wake cycle.

The dashboard starts with synthetic readings and can merge incoming telemetry. Energy, water-saving and other impact indicators are illustrative estimates. Recommendation generation does not currently call a trained ML model or an LLM. Node registration updates the interface; it does not pair a radio. Controls send commands without hardware acknowledgements, and the browser sleep timer does not put an ESP32 into deep sleep.

## Run the dashboard

Install Node.js with npm, then run from the repository root:

```sh
npm ci
npm start
```

Open `http://localhost:3000`. The interface works as a demonstration without a receiver. To use a different bridge address, set `REACT_APP_WS_URL` before starting or building; the default is `ws://127.0.0.1:8765`.

```sh
npm run build
```

The production bundle is written to `build/`.

## Connect a receiver

In a second terminal, use Python 3.10 or newer:

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r server/requirements.txt
LORA_SERIAL=/dev/ttyUSB0 python server/lora_bridge.py
```

Replace the serial device with your receiver, for example `/dev/cu.usbserial-…` on macOS. On Windows, activate `.venv\Scripts\activate`, set `LORA_SERIAL` to the appropriate `COM` port, then run the Python command.

| Setting | Default | Purpose |
| --- | --- | --- |
| `LORA_SERIAL` | empty | Receiver serial device; empty means WebSocket-only mode |
| `LORA_BAUD` | `9600` | Receiver baud rate |
| `WS_HOST` | `127.0.0.1` | Bridge bind address |
| `WS_PORT` | `8765` | Bridge WebSocket port |
| `REACT_APP_WS_URL` | `ws://127.0.0.1:8765` | Dashboard connection URL |

Without an available serial device, the bridge does not produce sensor measurements. The unauthenticated bridge is intended for local development; do not expose it directly to the Internet.

### Telemetry format

The receiver must output one complete JSON object per newline:

```json
{"mac":"AA:BB:CC:DD:EE:01","aqi":65,"rain":0.2,"moisture":58,"temp":26.5,"rh":62,"uv":4,"lux":420,"pH":6.4,"npk":210,"rssi":-88}
```

Alternatively, use newline-terminated CSV in this order:

```text
mac,aqi,rain,moisture,temp,rh,uv,lux,pH,npk,rssi
```

The line above describes the field order; send actual values, not a header. The bridge wraps readings as `{"type":"telemetry","payload":{...}}`.

### Downlink commands

The dashboard sends `{"type":"downlink","payload":"…"}`. The bridge forwards the string to serial with a trailing newline. Compatible firmware must implement:

```text
WAKE:MANUAL
SLEEP:AUTO:ON
SLEEP:AUTO:OFF
PUMP:ON
PUMP:OFF
VALVE:0:ON
VALVE:0:OFF
SERVO:0:90
```

Valve/servo indexes are zero-based (0–3); servo angles span 0–180 degrees. UI changes alone do not confirm physical actuation.

## Repository layout

```text
src/App.js             Dashboard, synthetic readings, charts and controls
src/index.css          Dashboard styling
public/                HTML entry point and application assets
server/lora_bridge.py  Serial telemetry and WebSocket command bridge
server/requirements.txt
```

Built with React, Recharts, Lucide, Python, websockets and pyserial.
