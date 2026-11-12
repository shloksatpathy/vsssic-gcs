// Web viewer: subscribes to gs/<sid>/* on an MQTT broker and shows the
// compact telemetry frame (see WEB_VIEWER_PLAN.md for the layout).

import * as trajectory from "./trajectory.js";

const FRAME_VERSION = 1;
const FRAME_SIZE = 23;
const INT32_MIN = -2147483648;
const INT16_MIN = -32768;
const U8_NONE = 255;

const WINDOW_S = 60;      // seconds of history on the graphs
const TABLE_ROWS = 10;
const STALE_S = 3;        // link shown as stale after this long without a packet

const $ = (id) => document.getElementById(id);

let client = null;
let connected = false;
let stateNames = {};
let times = [], alts = [], vss = [];
let count = 0, lost = 0, lastSeq = null, lastPacketAt = null;
let hostOnline = null, hostPaused = false;
let redrawQueued = false;

function decode(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.byteLength !== FRAME_SIZE || v.getUint8(0) !== FRAME_VERSION) return null;
  const alt = v.getInt32(7, true), vs = v.getInt16(11, true);
  const lat = v.getInt32(13, true), lon = v.getInt32(17, true);
  const state = v.getUint8(21), bat = v.getUint8(22);
  return {
    seq: v.getUint16(1, true),
    t: v.getUint32(3, true) / 1000,
    alt: alt === INT32_MIN ? null : alt / 10,
    vs: vs === INT16_MIN ? null : vs / 10,
    lat: lat === INT32_MIN ? null : lat / 1e7,
    lon: lon === INT32_MIN ? null : lon / 1e7,
    state: state === U8_NONE ? null : state,
    bat: bat === U8_NONE ? null : bat,
  };
}

function fmt(x, digits, unit = "") {
  return x === null ? "—" : x.toFixed(digits) + unit;
}

function stateName(code) {
  return code === null ? "—" : (stateNames[code] ?? String(code));
}

// ---------- charts ----------

function makeChart(el, color) {
  const opts = {
    width: el.clientWidth,
    height: 220,
    legend: { show: false },
    cursor: { drag: { x: false, y: false } },
    scales: { x: { time: false } },
    axes: [
      { stroke: "#8b949e", grid: { stroke: "#30363d" }, ticks: { stroke: "#30363d" } },
      { stroke: "#8b949e", grid: { stroke: "#30363d" }, ticks: { stroke: "#30363d" }, size: 50 },
    ],
    series: [{}, { stroke: color, width: 2, spanGaps: true }],
  };
  const chart = new uPlot(opts, [[], []], el);
  new ResizeObserver(() => chart.setSize({ width: el.clientWidth, height: 220 })).observe(el);
  return chart;
}

const altChart = makeChart($("c-alt"), "#58a6ff");
const vsChart = makeChart($("c-vs"), "#f0883e");

function queueRedraw() {
  if (redrawQueued) return;
  redrawQueued = true;
  requestAnimationFrame(() => {
    redrawQueued = false;
    altChart.setData([times, alts]);
    vsChart.setData([times, vss]);
  });
}

function clearData() {
  times = []; alts = []; vss = [];
  count = 0; lost = 0; lastSeq = null;
  $("rows").innerHTML = "";
  $("t-count").textContent = "0";
  $("t-loss").textContent = "—";
  queueRedraw();
}

// ---------- packets ----------

function onPacket(p) {
  // A mission clock that jumps back means the host restarted.
  if (times.length && p.t < times[times.length - 1]) clearData();

  if (lastSeq !== null) {
    const gap = (p.seq - lastSeq) & 0xffff;
    if (gap === 0) return;            // duplicate
    if (gap > 1 && gap < 0x8000) lost += gap - 1;
  }
  lastSeq = p.seq;
  count += 1;
  lastPacketAt = performance.now();

  times.push(p.t); alts.push(p.alt); vss.push(p.vs);
  while (times.length && times[0] < p.t - WINDOW_S) { times.shift(); alts.shift(); vss.shift(); }
  queueRedraw();
  trajectory.addLivePoint(p.lat, p.lon, p.alt);

  $("t-state").textContent = stateName(p.state);
  $("t-alt").textContent = fmt(p.alt, 1, " m");
  $("t-vs").textContent = fmt(p.vs, 1, " m/s");
  $("t-bat").textContent = fmt(p.bat, 0, " %");
  $("t-pos").textContent = p.lat === null ? "—" : `${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}`;
  $("t-count").textContent = String(count);
  $("t-loss").textContent = ((100 * lost) / (count + lost)).toFixed(1) + " %";

  const row = document.createElement("tr");
  for (const cell of [p.seq, p.t.toFixed(2), fmt(p.alt, 1), fmt(p.vs, 1),
                      fmt(p.lat, 6), fmt(p.lon, 6), stateName(p.state), fmt(p.bat, 0)]) {
    const td = document.createElement("td");
    td.textContent = cell;
    row.appendChild(td);
  }
  const rows = $("rows");
  rows.prepend(row);
  while (rows.children.length > TABLE_ROWS) rows.lastChild.remove();
}

function onMessage(topic, payload) {
  const kind = topic.split("/").pop();
  if (kind === "pkt") {
    const p = decode(payload);
    if (p) onPacket(p);
  } else if (kind === "meta") {
    const meta = JSON.parse(new TextDecoder().decode(payload));
    $("station").textContent = meta.station;
    document.title = meta.station;
    stateNames = meta.states;
  } else if (kind === "status") {
    const status = JSON.parse(new TextDecoder().decode(payload));
    hostOnline = status.online;
    hostPaused = status.paused;
  } else if (kind === "ref") {
    // Empty: the host stopped sharing it; keep drawing around the last one.
    if (!payload.length) return;
    const ref = JSON.parse(new TextDecoder().decode(payload));
    trajectory.setReference(ref.lat, ref.lon, ref.alt);
  } else if (kind === "sim") {
    trajectory.setSimulation(payload.length ? JSON.parse(new TextDecoder().decode(payload)) : null);
  } else if (kind === "reset") {
    clearData();
    trajectory.clearLive();
  }
}

// ---------- link status ----------

function setLink(text, cls) {
  const el = $("link");
  el.textContent = text;
  el.className = "pill " + cls;
}

setInterval(() => {
  if (!connected) return;
  const age = lastPacketAt === null ? null : (performance.now() - lastPacketAt) / 1000;
  if (hostOnline === false) setLink("Host offline", "off");
  else if (hostPaused) setLink("Feed paused", "warn");
  else if (age === null) setLink("Waiting for data", "warn");
  else if (age > STALE_S) setLink(`No data for ${age.toFixed(0)} s`, "warn");
  else setLink(`Live · ${age.toFixed(1)} s`, "ok");
}, 250);

// ---------- connection ----------

function connect(broker, sid) {
  if (client) client.end(true);
  clearData();
  hostOnline = null; hostPaused = false; lastPacketAt = null;
  setLink("Connecting…", "warn");

  client = mqtt.connect(broker, { reconnectPeriod: 2000, connectTimeout: 10000 });
  client.on("connect", () => { connected = true; client.subscribe(`gs/${sid}/#`); });
  client.on("message", onMessage);
  client.on("offline", () => { connected = false; setLink("Disconnected", "off"); });
}

// Served by the host itself (no internet): one WebSocket to the host.
// Each message is [kind length][kind][payload], kind as in the MQTT topics.
function connectLocal(port) {
  setLink("Connecting…", "warn");
  const ws = new WebSocket(`ws://${location.hostname}:${port}/`);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => { connected = true; clearData(); };
  ws.onmessage = (e) => {
    const data = new Uint8Array(e.data);
    const kind = new TextDecoder().decode(data.subarray(1, 1 + data[0]));
    onMessage(kind, data.subarray(1 + data[0]));
  };
  ws.onclose = () => {
    connected = false;
    setLink("Disconnected", "off");
    setTimeout(() => connectLocal(port), 2000);
  };
}

const params = new URLSearchParams(location.search);
$("broker").value = params.get("broker") || localStorage.getItem("broker") || "wss://broker.emqx.io:8084/mqtt";
$("sid").value = params.get("s") || localStorage.getItem("sid") || "";

$("connect").addEventListener("submit", (e) => {
  e.preventDefault();
  const broker = $("broker").value.trim(), sid = $("sid").value.trim();
  localStorage.setItem("broker", broker);
  localStorage.setItem("sid", sid);
  connect(broker, sid);
});

// local.json exists only when the host app serves this page.
const local = await fetch("local.json").then((r) => (r.ok ? r.json() : null));
if (local) {
  $("connect").style.display = "none";
  connectLocal(local.ws_port);
} else if ($("sid").value) {
  connect($("broker").value, $("sid").value);
}
