/* FogTwin control room — 3D twin view.

   The controller orbits the actual pit: terraced benches, haul roads on their
   surveyed elevations, dumpers moving on them, and the fog blanket sitting at
   the height the visibility field says it is. Clicking a dumper drops you into
   its cab HUD, which is the same world seen from inside. */

import * as THREE from '../vendor/three.module.js';
import { Orbit } from './orbit.js';
import {
  enu, addLighting, loadSite, buildTerrain, buildRoads, buildZoneGates,
  makeDumper, setDumperState, makeLabel, makeUncertaintyRing,
  buildFogBlanket, updateFogBlanket, fogFieldFrom,
} from './world.js';

const host = document.getElementById('scene');
let site = null, graph = null, snap = null;
let renderer, scene, camera, orbit, fogMesh, gates, roads;
let raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();

const fleet = new Map();       // vehicle_id -> { group, label, ring }
let follow = null;             // vehicle_id the camera is tracking
let labelsOn = true;

/* ------------------------------------------------------------------ */

async function boot() {
  site = await loadSite();
  graph = site.graph;

  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(host.clientWidth, host.clientHeight);
  renderer.setClearColor(0x0B0E10);
  host.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x0B0E10, 2600, 6200);   // aerial haze, not weather
  addLighting(scene);

  scene.add(buildTerrain(site));
  roads = buildRoads(site);
  scene.add(roads);
  gates = buildZoneGates(site);
  scene.add(gates);
  fogMesh = buildFogBlanket(site);
  scene.add(fogMesh);

  // Place names only where a controller would actually use one. The generated
  // network has 121 nodes; labelling every chainage point, or even every ramp
  // head, turns the overview into a wall of overlapping text.
  const NAMED = /shovel|Crusher tip|Crusher approach/i;
  for (const n of graph.nodes) {
    if (!NAMED.test(n.name)) continue;
    const sp = makeLabel(n.name, '#94A0A7', 11);
    sp.position.copy(enu(n.x, n.y, n.z + 30));
    sp.userData.place = true;
    scene.add(sp);
  }
  for (const st of (graph.met_stations || [])) {
    const mast = new THREE.Mesh(
      new THREE.CylinderGeometry(0.6, 0.6, 22, 6),
      new THREE.MeshStandardMaterial({ color: 0x6FA8C8, emissive: 0x2D6480,
                                       emissiveIntensity: 0.6 }));
    mast.position.copy(enu(st.x, st.y, (st.z || 0) + 11));
    scene.add(mast);
    const sp = makeLabel(st.station_id, '#6FA8C8', 10);
    sp.position.copy(enu(st.x, st.y, (st.z || 0) + 30));
    sp.userData.place = true;
    scene.add(sp);
  }

  camera = new THREE.PerspectiveCamera(48, host.clientWidth / host.clientHeight, 1, 20000);
  const cx = graph.nodes.reduce((a, n) => a + n.x, 0) / graph.nodes.length;
  const cy = graph.nodes.reduce((a, n) => a + n.y, 0) / graph.nodes.length;
  orbit = new Orbit(camera, renderer.domElement, enu(cx, cy, site.heightAt(cx, cy)));
  // frame the pit, not the whole DEM tile
  orbit.target.copy(enu(0, 0, site.heightAt(0, 0)));
  orbit.dist = 1450; orbit.maxDist = 9000; orbit.pitch = 0.44; orbit.yaw = -0.8;
  orbit.apply();

  renderer.domElement.addEventListener('click', onClick);
  addEventListener('resize', onResize);
  connect();
  renderer.setAnimationLoop(frame);
}

function onResize() {
  camera.aspect = host.clientWidth / host.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(host.clientWidth, host.clientHeight);
}

/* ------------------------------------------------------------------ */
/* fleet                                                               */
/* ------------------------------------------------------------------ */

function syncFleet() {
  if (!snap) return;
  const seen = new Set();

  for (const v of snap.vehicles) {
    seen.add(v.vehicle_id);
    const alert = snap.alerts[v.vehicle_id] || 'info';
    const age = snap.ages[v.vehicle_id] || 0;
    const mode = snap.modes[v.vehicle_id] || 'A';

    let ent = fleet.get(v.vehicle_id);
    if (!ent) {
      const group = makeDumper(alert, v.loaded);
      const label = makeLabel(v.vehicle_id, '#E4E9EC', 12);
      const ring = makeUncertaintyRing();
      scene.add(group); scene.add(label); scene.add(ring);
      ent = { group, label, ring };
      fleet.set(v.vehicle_id, ent);
    }

    ent.group.position.copy(enu(v.x, v.y, v.z));
    ent.group.rotation.y = v.heading;          // ENU heading -> three yaw
    setDumperState(ent.group, alert, v.loaded);

    ent.label.position.copy(enu(v.x, v.y, v.z + 34));
    ent.label.visible = labelsOn;

    // the ring IS the twin's uncertainty, not decoration
    const unc = v.pos_conf + age * Math.max(1, v.speed) * 0.35;
    const r = Math.max(9, unc);
    ent.ring.scale.set(r, r, r);
    ent.ring.position.copy(enu(v.x, v.y, v.z + 0.8));
    ent.ring.visible = age > 1.0;
    ent.ring.material.color.setHex(mode === 'C' ? 0xE4574F : 0xE0A93B);
  }

  for (const [id, ent] of fleet) {
    if (seen.has(id)) continue;
    scene.remove(ent.group); scene.remove(ent.label); scene.remove(ent.ring);
    fleet.delete(id);
  }

  // conflict-zone gates glow when occupied
  for (const z of snap.zones) {
    const g = gates.userData.gates[z.zone_id];
    if (!g) continue;
    const m = g.userData.material;
    if (z.holder) { m.color.setHex(0xE4574F); m.emissiveIntensity = 1.1; m.opacity = 0.9; }
    else { m.color.setHex(0x4FBE8B); m.emissiveIntensity = 0.35; m.opacity = 0.5; }
  }

  // road surfaces darken where the fog is thick
  const vis = snap.visibility || {};
  for (const [eid, mesh] of Object.entries(roads.userData.surfaces)) {
    const v = vis[eid] ?? 1000;
    const tint = v < 50 ? 0x6B3A32 : v < 200 ? 0x5E5240 : 0x514944;
    mesh.material.color.setHex(mesh.userData.edge.conflict_zone ? tint - 0x060606 : tint);
  }

  updateFogBlanket(fogMesh, fogFieldFrom(snap.stations));

  if (follow) {
    const v = snap.vehicles.find(x => x.vehicle_id === follow);
    if (v) orbit.lookAt(enu(v.x, v.y, v.z));
  }
}

/* ------------------------------------------------------------------ */

function onClick(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  pointer.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
  pointer.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);

  for (const [id, ent] of fleet) {
    if (raycaster.intersectObject(ent.group, true).length) {
      selectVehicle(id);
      return;
    }
  }
}

function selectVehicle(id) {
  follow = (follow === id) ? null : id;
  document.getElementById('following').textContent = follow ? `following ${follow}` : '';
  if (follow) {
    const v = snap?.vehicles.find(x => x.vehicle_id === follow);
    if (v) orbit.lookAt(enu(v.x, v.y, v.z), 300);
  }
}

/* view controls, wired from the HTML */
Object.assign(window, {
  viewTop: () => { follow = null; orbit.topDown(); orbit.dist = 1600; orbit.apply();
                   document.getElementById('following').textContent = ''; },
  viewPit: () => {
    follow = null;
    const n = graph.nodes.find(x => x.id === 'B4_0') || graph.nodes[0];
    orbit.pitch = 0.34; orbit.yaw = -0.9;
    orbit.lookAt(enu(0, 0, site.heightAt(0, 0)), 1150);
    document.getElementById('following').textContent = '';
  },
  viewRamp: () => {
    const n = graph.nodes.find(x => x.id.startsWith('R4_')) || graph.nodes[0];
    follow = null; orbit.pitch = 0.22; orbit.yaw = -2.1;
    orbit.lookAt(enu(n.x, n.y, n.z), 460);
    document.getElementById('following').textContent = '';
  },
  toggleLabels: () => { labelsOn = !labelsOn; scene.traverse(o => {
    if (o.isSprite && o.userData.place) o.visible = labelsOn; }); },
  toggleFog: () => { fogMesh.visible = !fogMesh.visible; },
  followVehicle: selectVehicle,
});

/* ------------------------------------------------------------------ */

let t0 = performance.now();
function frame() {
  fogMesh.material.uniforms.uTime.value = (performance.now() - t0) / 1000;
  renderer.render(scene, camera);
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/control`);
  const conn = document.getElementById('conn');
  ws.onopen = () => { conn.textContent = 'twin live'; conn.className = 'conn'; };
  ws.onclose = () => {
    conn.textContent = 'link lost'; conn.className = 'conn down';
    setTimeout(connect, 1500);
  };
  ws.onmessage = ev => {
    snap = JSON.parse(ev.data);
    syncFleet();
    renderPanels(snap);
  };
}

/* ------------------------------------------------------------------ */
/* side panels                                                         */
/* ------------------------------------------------------------------ */

function renderPanels(snap) {
  const st = snap.stats || {};
  const set = (id, v, cls) => {
    const el = document.getElementById(id);
    el.textContent = v;
    el.className = 'v' + (cls ? ' ' + cls : '');
  };
  set('s-fleet', st.fleet ?? 0);
  set('s-moving', st.moving ?? 0);
  set('s-speed', st.avg_speed_kmh ?? 0);
  set('s-held', st.held ?? 0, st.held > 0 ? 'warn' : '');
  const vis = snap.site_visibility_m;
  set('s-vis', vis >= 1000 ? '1000+' : vis, vis < 50 ? 'crit' : vis < 200 ? 'warn' : '');
  set('s-nm', st.near_misses ?? 0, st.near_misses > 0 ? 'crit' : '');

  document.getElementById('vis-readout').textContent =
    `site visibility ${vis >= 1000 ? '1000+' : vis} m`;

  document.getElementById('zones').innerHTML = snap.zones.map(z => `
    <tr>
      <td>${z.zone_id}</td>
      <td>${z.holder ? `<span class="pill lv-caution">${z.holder}</span>`
                     : '<span style="color:var(--ink-3)">free</span>'}</td>
      <td class="r">${z.queue.length ? z.queue.length + ' waiting' : ''}</td>
      <td class="r">${z.holder ? z.lease_left_s.toFixed(0) + 's' : ''}</td>
    </tr>`).join('');

  document.getElementById('fleet').innerHTML = snap.vehicles
    .slice().sort((a, b) => a.vehicle_id.localeCompare(b.vehicle_id))
    .map(v => {
      const alert = snap.alerts[v.vehicle_id] || 'info';
      const mode = snap.modes[v.vehicle_id] || 'A';
      return `<tr class="${follow === v.vehicle_id ? 'sel' : ''}">
        <td><button class="linkish" onclick="followVehicle('${v.vehicle_id}')"
            >${v.vehicle_id}</button></td>
        <td>${v.loaded ? 'loaded' : 'empty'}</td>
        <td class="r">${(v.speed * 3.6).toFixed(0)} km/h</td>
        <td class="r">${mode !== 'A' ? `<span class="pill lv-caution">${mode}</span> ` : ''}
            <span class="pill lv-${alert}">${alert}</span></td>
        <td class="r"><a href="/hud?vehicle=${v.vehicle_id}" target="_blank"
            title="open cab HUD">cab</a></td>
      </tr>`;
    }).join('');

  document.getElementById('events').innerHTML = snap.events.slice().reverse().map(e => {
    const ts = new Date(e.t * 1000).toLocaleTimeString('en-GB');
    return `<div><span class="t">${ts}</span><span class="pill lv-${e.level}"
            style="border:0;padding:0;margin-right:6px">${e.kind}</span>${e.text}</div>`;
  }).join('');
}

/* what-if simulator ------------------------------------------------ */
window.whatif = function (visM) {
  const vis = Number(visM);
  document.getElementById('wi-vis').textContent = vis >= 500 ? '500+ m' : vis + ' m';
  const stopSpeed = sight => {
    const a = 1 / (2 * 1.2), b = 1.5, c = -sight;
    return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
  };
  const clamp = v => Math.max(1.4, Math.min(12, v));
  const withTwin = clamp(stopSpeed(120));
  const withoutTwin = clamp(stopSpeed(vis));
  const clearBase = clamp(stopSpeed(500));
  document.getElementById('wi-speed').textContent =
    `${(withoutTwin * 3.6).toFixed(0)} → ${(withTwin * 3.6).toFixed(0)} km/h`;
  document.getElementById('wi-cycle').textContent =
    `${(clearBase / withoutTwin).toFixed(2)}× → ${(clearBase / withTwin).toFixed(2)}×`;
  document.getElementById('wi-tput').textContent =
    `${(withoutTwin / clearBase * 100).toFixed(0)}% → ${(withTwin / clearBase * 100).toFixed(0)}%`;
};

window.setFog = (m, station) =>
  fetch(`/demo/fog?visibility_m=${m}&station=${station}`, { method: 'POST' });

window.whatif(500);
boot();
