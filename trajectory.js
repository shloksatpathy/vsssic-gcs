// 3D trajectory: live track and simulated trajectory in a local East/North/Up
// frame around the launch reference, same convention as the desktop app
// (application/ui/map_tab.py latlon_to_enu).
//
// three.js is Y-up, so ENU (e, n, u) is drawn at (e, u, -n).

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const R_EARTH = 6371000;
const MAX_POINTS = 20000;

const el = document.getElementById("c-3d");
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
el.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x161b22);

const camera = new THREE.PerspectiveCamera(50, 1, 1, 200000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.addEventListener("change", render);

// Pad marker and north arrow.
const pad = new THREE.Mesh(new THREE.ConeGeometry(1, 3, 12), new THREE.MeshBasicMaterial({ color: 0x3fb950 }));
scene.add(pad);
const north = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(), 1, 0xf85149);
scene.add(north);

let grid = null;
let extent = 0;   // half-size of the grid in metres

function lineOf(color) {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_POINTS * 3), 3));
  geom.setDrawRange(0, 0);
  const line = new THREE.Line(geom, new THREE.LineBasicMaterial({ color }));
  line.frustumCulled = false;
  scene.add(line);
  return line;
}

const live = lineOf(0x58a6ff);
const sim = lineOf(0xf0883e);
const vehicle = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: 0x58a6ff }));
vehicle.visible = false;
scene.add(vehicle);

let ref = null;
let liveCount = 0;

function setPoints(line, count) {
  line.geometry.setDrawRange(0, count);
  line.geometry.attributes.position.needsUpdate = true;
}

// Grid, marker sizes and camera follow the size of what is drawn.
function fitExtent(e, n, u, refit) {
  const need = Math.max(Math.abs(e), Math.abs(n), u / 2, 50);
  if (need <= extent && !refit) return;
  extent = Math.pow(10, Math.ceil(Math.log10(need * 1.2)));
  if (extent / 2 >= need * 1.2) extent /= 2;
  if (grid) scene.remove(grid);
  grid = new THREE.GridHelper(extent * 2, 20, 0x8b949e, 0x30363d);
  scene.add(grid);
  const s = extent / 50;
  pad.scale.setScalar(s);
  pad.position.y = 1.5 * s;
  vehicle.scale.setScalar(s * 0.8);
  north.setLength(extent * 0.25, extent * 0.04, extent * 0.03);
  resetView();
}

function bounds() {
  let maxE = 0, maxN = 0, maxU = 0;
  for (const line of [live, sim]) {
    const a = line.geometry.attributes.position.array;
    for (let i = 0; i < line.geometry.drawRange.count; i++) {
      maxE = Math.max(maxE, Math.abs(a[3 * i]));
      maxU = Math.max(maxU, a[3 * i + 1]);
      maxN = Math.max(maxN, Math.abs(a[3 * i + 2]));
    }
  }
  return [maxE, maxN, maxU];
}

export function resetView() {
  const [, , maxU] = bounds();
  const h = Math.max(maxU, extent * 0.3);
  controls.target.set(0, h / 2, 0);
  camera.position.set(extent * 1.3, h / 2 + extent * 0.9, extent * 1.3);
  controls.update();
  render();
}

export function setReference(lat, lon, alt) {
  ref = { lat, lon, alt };
  clearLive();
}

export function addLivePoint(lat, lon, alt) {
  if (!ref || lat === null || lon === null || alt === null) return;
  const lat0 = ref.lat * Math.PI / 180;
  const e = (lon - ref.lon) * Math.PI / 180 * R_EARTH * Math.cos(lat0);
  const n = (lat - ref.lat) * Math.PI / 180 * R_EARTH;
  const u = alt - ref.alt;

  const a = live.geometry.attributes.position.array;
  if (liveCount === MAX_POINTS) {
    a.copyWithin(0, 3);
    liveCount -= 1;
  }
  a.set([e, u, -n], 3 * liveCount);
  liveCount += 1;
  setPoints(live, liveCount);

  vehicle.position.set(e, u, -n);
  vehicle.visible = true;
  fitExtent(e, n, u, false);
  render();
}

export function setSimulation(result) {
  if (!result) {
    setPoints(sim, 0);
    document.getElementById("sim-info").textContent = "";
    render();
    return;
  }
  const count = Math.min(result.x.length, MAX_POINTS);
  const a = sim.geometry.attributes.position.array;
  for (let i = 0; i < count; i++) a.set([result.x[i], result.z[i], -result.y[i]], 3 * i);
  setPoints(sim, count);
  const [maxE, maxN, maxU] = bounds();
  fitExtent(maxE, maxN, maxU, true);
  document.getElementById("sim-info").textContent =
    `Sim apogee ${result.apogee_agl.toFixed(0)} m AGL · max speed ${result.max_speed.toFixed(0)} m/s`;
}

export function clearLive() {
  liveCount = 0;
  setPoints(live, 0);
  vehicle.visible = false;
  render();
}

function render() {
  renderer.render(scene, camera);
}

new ResizeObserver(() => {
  const w = el.clientWidth, h = el.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  render();
}).observe(el);

document.getElementById("reset-3d").addEventListener("click", resetView);
fitExtent(0, 0, 0, true);
