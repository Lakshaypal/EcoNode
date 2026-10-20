import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Activity,
  BatteryCharging,
  Bot,
  CloudRain,
  Droplets,
  Leaf,
  Moon,
  Plus,
  Power,
  Radio,
  RefreshCw,
  Sun,
  Thermometer,
  Waves,
  Wind,
  Zap,
} from "lucide-react";

const WS_URL = process.env.REACT_APP_WS_URL || "ws://127.0.0.1:8765";
/** Each cycle: short wake (sample + TX), then long deep sleep — real wall-clock, not accelerated. */
const SLEEP_PHASE_MS = 15 * 60 * 1000;
const WAKE_PHASE_MS = 3000;
const CYCLE_MS = SLEEP_PHASE_MS + WAKE_PHASE_MS;
const LIVE_MERGE_MS = 15_000;

const SENSOR_DEFS = [
  { key: "aqi", label: "Air quality", icon: Wind, unit: " AQI", min: 0, max: 300, ideal: [0, 100], color: "#5eb8ff", cat: "air" },
  { key: "rain", label: "Rain", icon: CloudRain, unit: " mm", min: 0, max: 25, ideal: [0, 8], color: "#7eb6ff", cat: "weather" },
  { key: "moisture", label: "Soil moisture", icon: Droplets, unit: " %", min: 0, max: 100, ideal: [45, 72], color: "#5eead4", cat: "soil" },
  { key: "temp", label: "Temperature", icon: Thermometer, unit: " °C", min: 8, max: 45, ideal: [20, 34], color: "#fdba74", cat: "weather" },
  { key: "rh", label: "Humidity", icon: Waves, unit: " %", min: 15, max: 95, ideal: [40, 75], color: "#6ee7b7", cat: "weather" },
  { key: "uv", label: "UV index", icon: Sun, unit: "", min: 0, max: 11, ideal: [0, 6], color: "#fcd34d", cat: "weather" },
  { key: "lux", label: "Light (LDR)", icon: Zap, unit: " lx", min: 0, max: 1200, ideal: [200, 900], color: "#fde047", cat: "weather" },
  { key: "pH", label: "pH", icon: Activity, unit: "", min: 4, max: 9, ideal: [6.0, 7.2], color: "#d8b4fe", cat: "soil" },
  { key: "npk", label: "NPK", icon: Leaf, unit: "", min: 60, max: 400, ideal: [180, 320], color: "#86efac", cat: "soil" },
  { key: "rssi", label: "LoRa link", icon: Radio, unit: " dBm", min: -130, max: -60, ideal: [-110, -70], color: "#bef264", cat: "link" },
];

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function normalizeMac(input) {
  const s = String(input || "")
    .trim()
    .toUpperCase()
    .replace(/-/g, ":");
  const parts = s.split(":").filter(Boolean);
  if (parts.length !== 6 || parts.some((p) => !/^[0-9A-F]{2}$/.test(p))) return null;
  return parts.join(":");
}

function randomize(base, spread, min, max) {
  return clamp(base + (Math.random() - 0.5) * spread, min, max);
}

function createReading(prev, tOverride) {
  const p = prev || {};
  return {
    t: tOverride ?? new Date().toLocaleTimeString("en-IN", { hour12: false }),
    aqi: randomize(p.aqi ?? 68, 14, 35, 180),
    rain: clamp((p.rain ?? 0.2) + (Math.random() > 0.92 ? 0.8 : -0.05), 0, 20),
    moisture: randomize(p.moisture ?? 58, 4, 28, 92),
    temp: randomize(p.temp ?? 26.5, 1.2, 17, 39),
    rh: randomize(p.rh ?? 62, 5, 22, 92),
    uv: randomize(p.uv ?? 4.2, 0.8, 0, 10),
    lux: randomize(p.lux ?? 420, 60, 40, 1100),
    pH: randomize(p.pH ?? 6.45, 0.12, 5.4, 7.8),
    npk: randomize(p.npk ?? 210, 12, 95, 340),
    rssi: randomize(p.rssi ?? -88, 6, -125, -65),
    harvestedWh: clamp((p.harvestedWh ?? 1.6) + Math.random() * 0.002, 1.2, 2.6),
    consumedWh: clamp((p.consumedWh ?? 0.32) + Math.random() * 0.0008, 0.25, 0.85),
  };
}

function telemetryToPatch(payload) {
  const o = {};
  const num = (v) => (typeof v === "number" ? v : parseFloat(v));
  if (payload.aqi != null) o.aqi = num(payload.aqi);
  if (payload.rain != null) o.rain = num(payload.rain);
  if (payload.moisture != null) o.moisture = num(payload.moisture);
  if (payload.temp != null) o.temp = num(payload.temp);
  if (payload.rh != null) o.rh = num(payload.rh);
  if (payload.humidity != null) o.rh = num(payload.humidity);
  if (payload.uv != null) o.uv = num(payload.uv);
  if (payload.lux != null) o.lux = num(payload.lux);
  if (payload.pH != null) o.pH = num(payload.pH);
  if (payload.npk != null) o.npk = num(payload.npk);
  if (payload.rssi != null) o.rssi = num(payload.rssi);
  return Object.fromEntries(Object.entries(o).filter(([, value]) => Number.isFinite(value)));
}

function scoreHealth(d) {
  let score = 100;
  if (d.moisture < 42 || d.moisture > 78) score -= 16;
  if (d.pH < 5.8 || d.pH > 7.4) score -= 18;
  if (d.temp < 17 || d.temp > 36) score -= 12;
  if (d.npk < 165) score -= 16;
  if (d.aqi > 120) score -= 14;
  if (d.rssi < -118) score -= 10;
  return clamp(score, 0, 100);
}

function chipClass(ok) {
  return ok ? "chip chip-ok" : "chip chip-warn";
}

function formatEtaMs(ms) {
  if (ms <= 0) return "0s";
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r ? `${m}m ${r}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mr = m % 60;
  return mr ? `${h}h ${mr}m` : `${h}h`;
}

function SensorCard({ sensor, latest, history, gated }) {
  const Icon = sensor.icon;
  const val = latest[sensor.key];
  const pct = ((val - sensor.min) / (sensor.max - sensor.min)) * 100;
  const ok = val >= sensor.ideal[0] && val <= sensor.ideal[1];
  const display =
    sensor.key === "pH"
      ? val.toFixed(2)
      : sensor.key === "rain" || sensor.key === "uv"
        ? val.toFixed(1)
        : Number.isInteger(Math.round(val))
          ? Math.round(val)
          : val.toFixed(0);

  const gradId = `spark-${sensor.key}`;
  const chartData = history?.length ? history : [latest];
  /** RH spark is line-only; soil moisture & temp use filled area like other sensors. Trends chart stays all lines. */
  const lineOnlySpark = sensor.key === "rh";

  return (
    <section className={`card sensor-card sensor-cat-${sensor.cat || "air"} ${gated ? "sensor-gated" : ""}`}>
      <div className="sensor-head">
        <div className="sensor-title">
          <Icon size={14} color={sensor.color} />
          <span>{sensor.label}</span>
        </div>
        <span className={chipClass(ok && !gated)}>{gated ? "idle" : ok ? "ok" : "check"}</span>
      </div>
      <div className="sensor-value" style={{ color: sensor.color }}>
        {gated ? "—" : display}
        <span>{gated ? "" : sensor.unit}</span>
      </div>
      <div className="meter">
        <div className="meter-fill" style={{ width: `${pct}%`, backgroundColor: sensor.color }} />
      </div>
      <div className={`sensor-spark-wrap ${gated ? "sensor-spark-frozen" : ""}`}>
        <ResponsiveContainer width="100%" height={40}>
          {lineOnlySpark ? (
            <LineChart data={chartData} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
              <Tooltip
                contentStyle={{ background: "#0f172a", border: `1px solid ${sensor.color}55`, borderRadius: 8, fontSize: 10 }}
                labelStyle={{ color: "#94a3b8" }}
                formatter={(v) => [typeof v === "number" ? v.toFixed(sensor.key === "pH" ? 2 : 1) : v, sensor.label]}
              />
              <Line
                type="monotone"
                dataKey={sensor.key}
                stroke={sensor.color}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          ) : (
            <AreaChart data={chartData} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={sensor.color} stopOpacity={0.45} />
                  <stop offset="100%" stopColor={sensor.color} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <Tooltip
                contentStyle={{ background: "#0f172a", border: `1px solid ${sensor.color}55`, borderRadius: 8, fontSize: 10 }}
                labelStyle={{ color: "#94a3b8" }}
                formatter={(v) => [typeof v === "number" ? v.toFixed(sensor.key === "pH" ? 2 : 1) : v, sensor.label]}
              />
              <Area
                type="monotone"
                dataKey={sensor.key}
                stroke={sensor.color}
                strokeWidth={2}
                fill={`url(#${gradId})`}
                fillOpacity={1}
                dot={false}
                isAnimationActive={false}
              />
            </AreaChart>
          )}
        </ResponsiveContainer>
      </div>
    </section>
  );
}

function AqueductSlider({ zoneLetter, zoneClass, value, onChange }) {
  const pct = value / 180;
  return (
    <div className={`aqueduct-row ${zoneClass}`} style={{ "--servo-pct": pct }}>
      <span className="aqueduct-zone-badge" aria-hidden>
        {zoneLetter}
      </span>
      <div className="aqueduct-slider-shell">
        <input
          type="range"
          className="aqueduct-slider-input"
          min={0}
          max={180}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label={`Servo zone ${zoneLetter}, ${value} degrees`}
        />
      </div>
      <span className="aqueduct-value">{value}°</span>
    </div>
  );
}

function ActivityLog({ entries }) {
  return (
    <section className="card log-card">
      <div className="panel-title">Farm log → main dashboard</div>
      <ul className="activity-log">
        {entries.map((e) => (
          <li key={e.id}>
            <span className="log-time">{e.t}</span>
            <span className="log-msg">{e.msg}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function AIPanel({ recommendation, loading, refresh, className }) {
  return (
    <section className={`card ai-card ai-top-right ${className || ""}`}>
      <div className="panel-head">
        <div className="panel-title">
          <Bot size={15} /> Farming recommendation
        </div>
        <button type="button" className="icon-btn" onClick={refresh} aria-label="Refresh recommendations">
          <RefreshCw size={14} className={loading ? "spin" : ""} />
        </button>
      </div>
      <p className="ai-text">{loading ? "Correlating soil, weather, LoRa health, and irrigation logs…" : recommendation}</p>
    </section>
  );
}

function aggregateReadings(nodesMap, macs) {
  const ids = macs.length ? macs : Object.keys(nodesMap);
  if (!ids.length) return createReading(null);
  let sum = {};
  let n = 0;
  for (const mac of ids) {
    const L = nodesMap[mac]?.latest;
    if (!L) continue;
    n += 1;
    for (const k of SENSOR_DEFS.map((s) => s.key)) {
      sum[k] = (sum[k] || 0) + L[k];
    }
    sum.harvestedWh = (sum.harvestedWh || 0) + L.harvestedWh;
    sum.consumedWh = (sum.consumedWh || 0) + L.consumedWh;
  }
  if (n === 0) return createReading(null);
  const avg = { t: new Date().toLocaleTimeString("en-IN", { hour12: false }) };
  for (const k of SENSOR_DEFS.map((s) => s.key)) {
    avg[k] = sum[k] / n;
  }
  avg.harvestedWh = sum.harvestedWh / n;
  avg.consumedWh = sum.consumedWh / n;
  return avg;
}

const DEMO_MAC = "AA:BB:CC:DD:EE:01";

export default function App() {
  const [nodesConfig, setNodesConfig] = useState(() => [{ mac: DEMO_MAC, label: "LR-01" }]);
  const [selectedMac, setSelectedMac] = useState(null);
  const [nodesMap, setNodesMap] = useState(() => {
    const r0 = createReading(null);
    return { [DEMO_MAC]: { history: [r0], latest: r0 } };
  });
  const [liveOverlay, setLiveOverlay] = useState({});
  const liveOverlayRef = useRef({});
  useEffect(() => {
    liveOverlayRef.current = liveOverlay;
  }, [liveOverlay]);

  const [addModalOpen, setAddModalOpen] = useState(false);
  const [macInput, setMacInput] = useState("");
  const [macError, setMacError] = useState("");

  const [autoSleep, setAutoSleep] = useState(true);
  const [manualWakeUntil, setManualWakeUntil] = useState(0);
  const [mosfetGating, setMosfetGating] = useState(true);
  const [valves, setValves] = useState([false, true, false, false]);
  const [servoAngles, setServoAngles] = useState([90, 90, 90, 90]);
  const [autoIrrigation, setAutoIrrigation] = useState(true);
  const [pumpOn, setPumpOn] = useState(false);

  const [aiLoading, setAiLoading] = useState(false);
  const [rec, setRec] = useState(
    "Connect the LoRa USB receiver on your laptop, run the Python bridge, and telemetry will stream live. Use the irrigation panel to run pump, valves, and zone servos."
  );
  const [log, setLog] = useState(() => [
    { id: 1, t: new Date().toLocaleTimeString("en-IN", { hour12: false }), msg: "Tip: set LORA_SERIAL when starting the bridge (see server/lora_bridge.py)." },
  ]);
  const [chartHistory, setChartHistory] = useState(() => []);
  const [wsStatus, setWsStatus] = useState("disconnected");
  const wsRef = useRef(null);
  const logId = useRef(2);
  const cycleStart = useRef(Date.now());
  const [clock, setClock] = useState(0);

  const macs = useMemo(() => nodesConfig.map((n) => n.mac), [nodesConfig]);

  useEffect(() => {
    const id = setInterval(() => setClock((c) => c + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const inWakeWindow = useMemo(() => {
    void clock;
    if (!autoSleep) return true;
    if (Date.now() < manualWakeUntil) return true;
    const elapsed = (Date.now() - cycleStart.current) % CYCLE_MS;
    return elapsed < WAKE_PHASE_MS;
  }, [autoSleep, manualWakeUntil, clock]);

  const sleepWakeEta = useMemo(() => {
    void clock;
    const now = Date.now();
    if (!autoSleep) {
      return { title: "Sampling", detail: "Sleep policy off — always awake", variant: "off" };
    }
    if (now < manualWakeUntil) {
      return {
        title: "Manual wake",
        detail: `Ends in ${formatEtaMs(manualWakeUntil - now)}`,
        variant: "manual",
      };
    }
    const elapsed = (now - cycleStart.current) % CYCLE_MS;
    if (elapsed < WAKE_PHASE_MS) {
      return {
        title: "Wake window",
        detail: `Sensors + TX · ends in ${formatEtaMs(WAKE_PHASE_MS - elapsed)}`,
        variant: "wake",
      };
    }
    return {
      title: "Deep sleep",
      detail: `Next wake in ${formatEtaMs(CYCLE_MS - elapsed)}`,
      variant: "sleep",
    };
  }, [autoSleep, manualWakeUntil, clock]);

  const gated = mosfetGating && !inWakeWindow;

  const pushLog = useCallback((msg) => {
    setLog((prev) => {
      const row = { id: logId.current++, t: new Date().toLocaleTimeString("en-IN", { hour12: false }), msg };
      return [row, ...prev].slice(0, 8);
    });
  }, []);

  const sendWs = useCallback(
    (obj) => {
      try {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify(obj));
        }
      } catch {
        /* ignore */
      }
    },
    []
  );

  const sendDownlink = useCallback(
    (line) => {
      sendWs({ type: "downlink", payload: line });
      pushLog(`Downlink queued: ${line.trim()}`);
    },
    [sendWs, pushLog]
  );

  const macsRef = useRef(macs);
  useEffect(() => {
    macsRef.current = macs;
  }, [macs]);

  useEffect(() => {
    let ws;
    let reconnectTimer;
    const connect = () => {
      setWsStatus("connecting");
      ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.onopen = () => {
        setWsStatus("connected");
        pushLog(`WebSocket connected (${WS_URL}).`);
      };
      ws.onclose = () => {
        setWsStatus("disconnected");
        wsRef.current = null;
        reconnectTimer = setTimeout(connect, 2500);
      };
      ws.onerror = () => {
        setWsStatus("error");
      };
      ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data.type === "telemetry" && data.payload?.mac) {
            const mac = normalizeMac(data.payload.mac);
            if (!mac) return;
            const patch = telemetryToPatch(data.payload);
            setLiveOverlay((prev) => ({ ...prev, [mac]: { ...patch, _ts: Date.now() } }));
            const t = new Date().toLocaleTimeString("en-IN", { hour12: false });
            setNodesMap((prev) => {
              const block = prev[mac] || { history: [], latest: createReading(null, t) };
              const merged = { ...block.latest, ...patch, t };
              const hist = [...block.history.slice(-35), merged];
              const next = { ...prev, [mac]: { history: hist, latest: merged } };
              queueMicrotask(() => {
                const agg = aggregateReadings(next, macsRef.current);
                setChartHistory((ch) => [...ch.slice(-35), { t, moisture: agg.moisture, temp: agg.temp, rh: agg.rh }]);
              });
              return next;
            });
          } else if (data.type === "bridge_log" && data.payload) {
            pushLog(String(data.payload));
          } else if (data.type === "hello") {
            pushLog(`Bridge ready (USB serial: ${data.serial ? "yes" : "no"}).`);
          }
        } catch {
          /* ignore */
        }
      };
    };
    connect();
    return () => {
      clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [pushLog]);

  useEffect(() => {
    const id = setInterval(() => {
      const t = new Date().toLocaleTimeString("en-IN", { hour12: false });
      setNodesMap((prev) => {
        const next = { ...prev };
        for (const mac of macs) {
          const block = next[mac] || { history: [], latest: createReading(null, t) };
          const prevR = block.latest;
          const ov = liveOverlayRef.current[mac];
          const liveFresh = ov && Date.now() - (ov._ts || 0) < LIVE_MERGE_MS;
          const base = inWakeWindow ? createReading(prevR, t) : prevR;
          const livePatch = ov && liveFresh ? { ...ov } : {};
          delete livePatch._ts;
          const nr = liveFresh ? { ...base, ...livePatch, t, harvestedWh: base.harvestedWh, consumedWh: base.consumedWh } : base;
          const hist = inWakeWindow ? [...block.history.slice(-35), nr] : block.history;
          next[mac] = { history: hist, latest: nr };
        }
        if (inWakeWindow) {
          const agg = aggregateReadings(next, macs);
          queueMicrotask(() => {
            setChartHistory((ch) => [...ch.slice(-35), { t, moisture: agg.moisture, temp: agg.temp, rh: agg.rh }]);
          });
        }
        return next;
      });
    }, gated ? 4000 : 900);
    return () => clearInterval(id);
  }, [macs, inWakeWindow, gated]);

  const overview = selectedMac === null;
  const activeLatest = overview
    ? aggregateReadings(nodesMap, macs)
    : nodesMap[selectedMac]?.latest || aggregateReadings(nodesMap, macs);

  const activeHistory = overview
    ? chartHistory
    : (nodesMap[selectedMac]?.history || []).map((row) => ({
        t: row.t,
        moisture: row.moisture,
        temp: row.temp,
        rh: row.rh,
      }));

  const sparkHistory = useMemo(() => {
    const base = aggregateReadings(nodesMap, macs);
    if (!overview && selectedMac && nodesMap[selectedMac]?.history?.length) {
      return nodesMap[selectedMac].history;
    }
    if (!chartHistory.length) return [base];
    return chartHistory.map((row) => ({ ...base, ...row }));
  }, [overview, selectedMac, nodesMap, macs, chartHistory]);

  const health = scoreHealth(activeLatest);
  const harvested = activeLatest.harvestedWh;
  const consumed = activeLatest.consumedWh;
  const surplus = harvested - consumed;
  const carbonKg = useMemo(
    () => (0.00082 * Math.max(0, surplus * 24 * macs.length)).toFixed(3),
    [surplus, macs.length]
  );
  const fertPct = useMemo(() => clamp(12 + (activeLatest.npk > 200 ? 8 : 4) + macs.length * 2, 8, 35), [activeLatest.npk, macs.length]);
  const waterSavedL = useMemo(() => Math.round(180 + activeLatest.moisture * 1.2 + (activeLatest.rain > 1 ? 60 : 0)), [activeLatest.moisture, activeLatest.rain]);

  const refreshAI = async () => {
    setAiLoading(true);
    await new Promise((r) => setTimeout(r, 900));
    const ctx = overview ? "Network overview" : `Node ${nodesConfig.find((n) => n.mac === selectedMac)?.label || selectedMac}`;
    const tips = [
      `${ctx}: AQI ${Math.round(activeLatest.aqi)}, soil ${activeLatest.moisture.toFixed(0)}%, RH ${activeLatest.rh.toFixed(0)}%. ${autoIrrigation ? "Smart irrigation: trim next cycle if LoRa rain trend holds." : "Enable auto irrigation for closed-loop logging."}`,
      `${ctx}: pH ${activeLatest.pH.toFixed(2)}, NPK ${Math.round(activeLatest.npk)}. Fertilizer minimization: split dose after ${activeLatest.rain.toFixed(1)} mm rain signal.`,
      `${ctx}: UV ${activeLatest.uv.toFixed(1)}, LDR ${Math.round(activeLatest.lux)} lx, RSSI ${Math.round(activeLatest.rssi)} dBm. ${wsStatus === "connected" ? "Live bridge active." : "Start Python bridge for live LoRa."}`,
      `${ctx}: Tune zone servos A–D from the irrigation panel when the node is listening.`,
    ];
    setRec(tips[Math.floor(Math.random() * tips.length)]);
    pushLog(`AI digest (${ctx}).`);
    setAiLoading(false);
  };

  const openAddModal = () => {
    setMacInput("");
    setMacError("");
    setAddModalOpen(true);
  };

  const confirmAddNode = () => {
    const mac = normalizeMac(macInput);
    if (!mac) {
      setMacError("Enter a valid MAC, e.g. AA:BB:CC:DD:EE:02");
      return;
    }
    if (nodesConfig.some((n) => n.mac === mac)) {
      setMacError("This MAC is already registered.");
      return;
    }
    const label = `LR-${String(nodesConfig.length + 1).padStart(2, "0")}`;
    setNodesConfig((prev) => [...prev, { mac, label }]);
    const r0 = createReading(null);
    setNodesMap((prev) => ({ ...prev, [mac]: { history: [r0], latest: r0 } }));
    setSelectedMac(mac);
    sendWs({ type: "register_node", mac, label });
    pushLog(`Registered node ${label} (${mac}) — pair on LoRa receiver.`);
    setAddModalOpen(false);
    setMacInput("");
    setMacError("");
  };

  const selectOverview = () => setSelectedMac(null);
  const selectNode = (mac) => setSelectedMac(mac);

  const manualWake = () => {
    setManualWakeUntil(Date.now() + 45_000);
    cycleStart.current = Date.now();
    sendDownlink("WAKE:MANUAL\n");
    pushLog("Manual wake sent (WAKE:MANUAL).");
  };

  const toggleAutoSleep = () => {
    setAutoSleep((v) => {
      const next = !v;
      sendDownlink(next ? "SLEEP:AUTO:ON\n" : "SLEEP:AUTO:OFF\n");
      pushLog(next ? "Auto sleep policy ON (ESP 15 min cycle)." : "Auto sleep OFF.");
      return next;
    });
  };

  const toggleValve = (i) => {
    setValves((v) => {
      const next = v.map((x, idx) => (idx === i ? !x : x));
      const on = next[i];
      sendDownlink(`VALVE:${i}:${on ? "ON" : "OFF"}\n`);
      return next;
    });
  };

  const setServo = (i, angle) => {
    const a = clamp(Math.round(angle), 0, 180);
    setServoAngles((prev) => {
      const next = [...prev];
      next[i] = a;
      return next;
    });
    sendDownlink(`SERVO:${i}:${a}\n`);
  };

  const togglePump = () => {
    setPumpOn((p) => {
      const next = !p;
      sendDownlink(`PUMP:${next ? "ON" : "OFF"}\n`);
      return next;
    });
  };

  const sleepLabel = autoSleep
    ? inWakeWindow
      ? "Wake window (TX + sensors)"
      : "Deep sleep (LoRa listen / idle)"
    : "Sleep policy off";

  return (
    <main className="app">
      <div className="bg-orb orb-a" />
      <div className="bg-orb orb-b" />

      <div className="top-row">
        <header className="topbar card topbar-left">
          <div>
            <p className="eyebrow">ECONODE · LoRa → laptop receiver → dashboard</p>
            <h1>{overview ? "Overall field view" : nodesConfig.find((n) => n.mac === selectedMac)?.label || "Node"}</h1>
            <p className="sub-head">{overview ? "All registered MACs" : selectedMac}</p>
          </div>
          <div className="topbar-meta">
            <span
              className={`ws-pill ${
                wsStatus === "connected" ? "ws-on" : wsStatus === "connecting" ? "ws-busy" : "ws-off"
              }`}
            >
              {wsStatus}
            </span>
            <div className="live-wrap">
              <span className="live-dot" />
              <span>Health {health}%</span>
              <span>{inWakeWindow ? "LIVE" : "SLEEP"}</span>
            </div>
          </div>
        </header>
        <AIPanel recommendation={rec} loading={aiLoading} refresh={refreshAI} />
      </div>

      <div className="node-strip card">
        <span className="node-strip-label">LoRa nodes</span>
        <button type="button" className={`node-chip ${overview ? "active" : ""}`} onClick={selectOverview}>
          Overview
        </button>
        {nodesConfig.map(({ mac, label }) => (
          <button key={mac} type="button" className={`node-chip ${selectedMac === mac ? "active" : ""}`} onClick={() => selectNode(mac)} title={mac}>
            {label}
          </button>
        ))}
        <button type="button" className="node-chip add" onClick={openAddModal} title="Add LoRa node (MAC)">
          <Plus size={14} /> Add node
        </button>
      </div>

      <section className="kpi-grid compact">
        <article className="card kpi kpi-carbon">
          <div className="kpi-title">
            <Wind size={14} /> Carbon footprint
          </div>
          <div className="kpi-value">{carbonKg} kg</div>
          <div className="kpi-sub">CO₂e avoided vs always-on</div>
        </article>
        <article className="card kpi kpi-fert">
          <div className="kpi-title">
            <Leaf size={14} /> Fertilizer saved
          </div>
          <div className="kpi-value">{fertPct}%</div>
          <div className="kpi-sub">vs baseline schedule</div>
        </article>
        <article className="card kpi kpi-water">
          <div className="kpi-title">
            <Droplets size={14} /> Smart irrigation
          </div>
          <div className="kpi-value">{waterSavedL} L</div>
          <div className="kpi-sub">illustrative water-saving estimate</div>
        </article>
        <article className="card kpi kpi-energy">
          <div className="kpi-title">
            <BatteryCharging size={14} /> Energy today
          </div>
          <div className="energy-lines">
            <span>Harvested {harvested.toFixed(2)} Wh</span>
            <span>Used {consumed.toFixed(2)} Wh</span>
            <span className={surplus >= 0 ? "plus" : "minus"}>Δ {surplus >= 0 ? "+" : ""}{surplus.toFixed(2)} Wh</span>
          </div>
        </article>
      </section>

      <section className="hardware-bar card">
        <div className="hw-item">
          <span className="hw-k">MOSFET sensor gating</span>
          <button type="button" className={mosfetGating ? "toggle on" : "toggle"} onClick={() => setMosfetGating((v) => !v)}>
            {mosfetGating ? "ON" : "OFF"}
          </button>
        </div>
        <div className="hw-item">
          <span className="hw-k">ESP sleep</span>
          <span className="hw-v">15 min · 3 s wake</span>
        </div>
        <div className="hw-item">
          <span className="hw-k">Live path</span>
          <span className="hw-v">Node → LoRa → USB receiver → bridge → WS</span>
        </div>
        <div className="hw-actions">
          <button type="button" className="btn-wake" onClick={manualWake}>
            <Zap size={13} /> Manual wake
          </button>
          <button type="button" className={autoSleep ? "toggle on" : "toggle"} onClick={toggleAutoSleep}>
            <Moon size={13} /> Auto sleep
          </button>
        </div>
      </section>

      <div className={`sleep-banner card sleep-eta-row sleep-eta-${sleepWakeEta.variant}`}>
        <div className="sleep-eta-main">
          <span className={inWakeWindow ? "sleep-ok" : "sleep-off"}>{sleepLabel}</span>
          {!inWakeWindow && mosfetGating && <span className="sleep-hint">No live read — rails gated.</span>}
        </div>
        <div className="sleep-eta-timer">
          <span className="sleep-eta-title">{sleepWakeEta.title}</span>
          <span className="sleep-eta-detail">{sleepWakeEta.detail}</span>
        </div>
        <div className="sleep-eta-scale">
          <span className="sleep-eta-scale-label">ESP cycle</span>
          <span className="sleep-eta-scale-val">15 min sleep · 3 s wake</span>
        </div>
      </div>

      <section className={`sensor-grid compact sensor-band ${SENSOR_DEFS.length > 6 ? "sensor-grid-dense" : ""}`}>
        {SENSOR_DEFS.map((s) => (
          <SensorCard key={s.key} sensor={s} latest={activeLatest} history={sparkHistory} gated={gated} />
        ))}
      </section>

      <section className="single-screen-grid">
        <section className="card control-card irrigation-suite">
          <header className="irrigation-suite-head">
            <div>
              <div className="panel-title irrigation-suite-title">
                <Droplets size={16} className="irrigation-icon" />
                Smart irrigation
              </div>
              <p className="irrigation-suite-desc">Auto mode, main pump, zone valves, and per-zone servo trim.</p>
            </div>
            <div className="irrigation-kpi-pill" title="Illustrative estimate, not a measured saving">
              <span className="irrigation-kpi-value">{waterSavedL} L</span>
              <span className="irrigation-kpi-label">demo estimate</span>
            </div>
          </header>

          <div className="irrigation-automation">
            <div className="switch-row irrigation-switch">
              <div>
                <span className="switch-label">Auto irrigation</span>
                <span className="switch-hint">Prototype automation control</span>
              </div>
              <button type="button" className={autoIrrigation ? "toggle toggle-irrig on" : "toggle toggle-irrig"} onClick={() => setAutoIrrigation((p) => !p)}>
                {autoIrrigation ? "ON" : "OFF"}
              </button>
            </div>
            <div className="switch-row irrigation-switch">
              <div>
                <span className="switch-label">Main pump</span>
                <span className="switch-hint">Master water supply</span>
              </div>
              <button type="button" className={pumpOn ? "toggle toggle-pump on" : "toggle toggle-pump"} onClick={togglePump}>
                {pumpOn ? "ON" : "OFF"}
              </button>
            </div>
          </div>

          <div className="irrigation-valves-block">
            <div className="subpanel-label">Zone valves</div>
            <div className="valve-grid">
              {valves.map((v, i) => (
                <button key={`v-${i}`} type="button" className={v ? "valve-btn on" : "valve-btn"} onClick={() => toggleValve(i)}>
                  Zone {String.fromCharCode(65 + i)}
                  <Power size={12} />
                </button>
              ))}
            </div>
          </div>

          <div className="irrigation-servo-block">
            <div className="subpanel-label">Servo trim — field angles (0–180°)</div>
            <p className="servo-hint">Drag the luminous track; each zone has its own color for quick scanning.</p>
            <div className="aqueduct-grid">
              {servoAngles.map((ang, i) => (
                <AqueductSlider
                  key={`srv-${i}`}
                  zoneLetter={String.fromCharCode(65 + i)}
                  zoneClass={`aqueduct-z${i}`}
                  value={ang}
                  onChange={(v) => setServo(i, v)}
                />
              ))}
            </div>
          </div>
        </section>

        <section className="card chart-card">
          <div className="panel-title">Trends — moisture · temp · RH {overview ? "(mesh)" : ""}</div>
          <div className="trends-legend" aria-hidden>
            <span className="trends-legend-i moisture">Moisture</span>
            <span className="trends-legend-i temp">Temp</span>
            <span className="trends-legend-i rh">RH</span>
          </div>
          <div className="chart-body">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={
                  activeHistory.length
                    ? activeHistory
                    : [
                        {
                          t: activeLatest.t,
                          moisture: activeLatest.moisture,
                          temp: activeLatest.temp,
                          rh: activeLatest.rh,
                        },
                      ]
                }
                margin={{ top: 6, right: 4, left: 4, bottom: 4 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(94, 234, 212, 0.08)" vertical={false} />
                <XAxis dataKey="t" tick={{ fill: "#94a3b8", fontSize: 9 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                <YAxis
                  yAxisId="hydro"
                  domain={[0, 100]}
                  tick={{ fill: "#94a3b8", fontSize: 9 }}
                  tickLine={false}
                  axisLine={false}
                  width={34}
                />
                <YAxis
                  yAxisId="thermal"
                  orientation="right"
                  domain={["auto", "auto"]}
                  tick={{ fill: "#94a3b8", fontSize: 9 }}
                  tickLine={false}
                  axisLine={false}
                  width={34}
                />
                <Tooltip
                  contentStyle={{ background: "#0f172a", border: "1px solid rgba(94, 234, 212, 0.22)", borderRadius: 10, fontSize: 11 }}
                  formatter={(value, name) => {
                    const n = typeof value === "number" ? value : parseFloat(value);
                    const label = name === "moisture" ? "Moisture %" : name === "rh" ? "RH %" : "Temp °C";
                    return [`${Number.isFinite(n) ? n.toFixed(1) : value}`, label];
                  }}
                />
                <Line
                  yAxisId="hydro"
                  type="monotone"
                  dataKey="moisture"
                  stroke="#5eead4"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  yAxisId="hydro"
                  type="monotone"
                  dataKey="rh"
                  stroke="#6ee7b7"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  yAxisId="thermal"
                  type="monotone"
                  dataKey="temp"
                  stroke="#fdba74"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </section>

        <ActivityLog entries={log} />
      </section>

      {addModalOpen && (
        <div className="modal-backdrop" role="presentation" onClick={() => setAddModalOpen(false)}>
          <div className="modal card" role="dialog" aria-labelledby="add-node-title" onClick={(e) => e.stopPropagation()}>
            <h2 id="add-node-title" className="modal-title">
              Register LoRa node
            </h2>
            <p className="modal-desc">Enter the node MAC address (from firmware / sticker). The laptop LoRa receiver + Python bridge will route live telemetry to this dashboard.</p>
            <label className="modal-label" htmlFor="mac-field">
              MAC address
            </label>
            <input
              id="mac-field"
              className="modal-input"
              placeholder="AA:BB:CC:DD:EE:02"
              value={macInput}
              onChange={(e) => {
                setMacInput(e.target.value);
                setMacError("");
              }}
              autoComplete="off"
            />
            {macError && <p className="modal-error">{macError}</p>}
            <div className="modal-actions">
              <button type="button" className="toggle" onClick={() => setAddModalOpen(false)}>
                Cancel
              </button>
              <button type="button" className="toggle on" onClick={confirmAddNode}>
                Register node
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
