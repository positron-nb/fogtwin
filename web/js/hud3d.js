/* FogTwin cab HUD — 3D synthetic vision.

   The camera sits in the dumper's cab, inside the same twin the control room
   orbits. Press V to split the screen: the left pane is the windscreen, with
   real volumetric fog at the visibility the field reports; the right pane is
   synthetic vision, drawn from surveyed geometry, which does not care about
   weather at all. Same instant, same world, same pose.

   That split is the entire argument of the project, rendered. */

import * as THREE from '../vendor/three.module.js';
import {
  enu, loadSite, buildTerrain, buildRoads, buildZoneGates,
  makeDumper, setDumperState, makeLabel, setLabelText, fogDensity, fogExpDensity,
} from './world.js';
import { detectionSectors, blindSectors, isSensed, wrapDeg } from './sensors.js';

const host = document.getElementById('scene');

// Which cab we are sitting in. Mutable: the operator picker in the topbar
// switches the camera between dumpers without a page reload, so a controller
// can walk the fleet cab by cab during a shift review.
let vehicleId = new URLSearchParams(location.search).get('vehicle') || 'DT-101';
let socket = null;
let generation = 0;            // bumped on a cab switch to orphan old handlers
let cabIds = [];

/* the fit this cab is carrying, read from the hardware manifest so the plan
   radar shows the sensors we actually specified rather than a drawn guess */
let sectors = [], blindArcs = [], blindFog = [];
let pipOn = true, pipRange = 250;
const PIP_RANGES = [250, 120, 60];
let pipCtx = null, lastPip = 0;

const EYE_H = 3.4;              // operator eye height above the road, metres

let renderer, scene, camera, site, graph;
let overlay, corridorMesh, corridorEdges, holdGate, distGates;
let hemi, sun;
let adv = null, split = false;
const neighbourMeshes = new Map();

/* smoothed pose: the twin ticks at 5 Hz but the cab must not judder */
const pose = { x: 0, y: 0, z: 0, h: 0, ready: false };

/* ------------------------------------------------------------------ */

async function boot() {
  const [siteData, hw] = await Promise.all([
    loadSite(),
    fetch('/api/hardware').then(r => r.json()).catch(() => null),
  ]);
  site = siteData;
  graph = site.graph;

  if (hw) {
    sectors = detectionSectors(hw.components);
    blindArcs = blindSectors(sectors);
    blindFog = blindSectors(sectors, { fogProofOnly: true });
  }

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(host.clientWidth, host.clientHeight);
  renderer.autoClear = false;
  host.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.add(buildTerrain(site));
  scene.add(buildRoads(site));
  scene.add(buildZoneGates(site));

  hemi = new THREE.HemisphereLight(0xAEBCC4, 0x2A2320, 1.15);
  sun = new THREE.DirectionalLight(0xFFF2E0, 0.85);
  sun.position.set(400, 600, 260);
  scene.add(hemi, sun);

  camera = new THREE.PerspectiveCamera(62, host.clientWidth / host.clientHeight, 0.6, 12000);

  buildOverlay();
  addEventListener('resize', onResize);
  addEventListener('keydown', e => {
    if (e.key.toLowerCase() === 'v') { setSplit(!split); return; }
    // let the select handle its own arrows when it has focus
    if (e.target && e.target.id === 'cabsel') return;
    if (e.key === 'ArrowLeft') stepCab(-1);
    if (e.key === 'ArrowRight') stepCab(1);
    if (e.key.toLowerCase() === 'r') setPip(!pipOn);
  });
  document.getElementById('splitbtn').onclick = () => setSplit(!split);
  document.getElementById('cabsel').onchange = ev => switchCab(ev.target.value);
  pipCtx = document.getElementById('pip').getContext('2d');
  document.getElementById('pipbtn').onclick = () => setPip(!pipOn);
  document.getElementById('pip').onclick = () => {
    pipRange = PIP_RANGES[(PIP_RANGES.indexOf(pipRange) + 1) % PIP_RANGES.length];
    document.getElementById('piprange').textContent = `${pipRange} m`;
  };
  document.getElementById('prevcab').onclick = () => stepCab(-1);
  document.getElementById('nextcab').onclick = () => stepCab(1);

  connect();
  pollSpeed();
  renderer.setAnimationLoop(frame);
}

function onResize() {
  renderer.setSize(host.clientWidth, host.clientHeight);
}

function setSplit(on) {
  split = on;
  document.getElementById('splitbtn').classList.toggle('hot', split);
  document.querySelector('.hint').style.display = split ? 'none' : '';
}

/* ------------------------------------------------------------------ */
/* the synthetic-vision overlay — drawn from the map, never from a camera */
/* ------------------------------------------------------------------ */

function buildOverlay() {
  overlay = new THREE.Group();
  scene.add(overlay);

  // road corridor ribbon, rebuilt every advisory from surveyed geometry
  corridorMesh = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({
      color: 0x2FE0A0, transparent: true, opacity: 0.16,
      side: THREE.DoubleSide, depthWrite: false,
    }));
  corridorMesh.renderOrder = 10;
  // The geometry is rebuilt every advisory. three caches a bounding sphere on
  // first render and updating the position attribute does not invalidate it,
  // so the corridor would be frustum-culled the moment the dumper drove away
  // from where it was first built. It is always right in front of the camera,
  // so culling it buys nothing anyway.
  corridorMesh.frustumCulled = false;
  overlay.add(corridorMesh);

  corridorEdges = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0x8FE3C0, transparent: true, opacity: 0.95 }));
  corridorEdges.renderOrder = 11;
  corridorEdges.frustumCulled = false;
  overlay.add(corridorEdges);

  // hold barrier for a denied token
  holdGate = new THREE.Mesh(
    new THREE.PlaneGeometry(26, 5),
    new THREE.MeshBasicMaterial({ color: 0xE0A93B, transparent: true,
                                  opacity: 0.55, side: THREE.DoubleSide,
                                  depthWrite: false }));
  holdGate.visible = false;
  holdGate.renderOrder = 12;
  overlay.add(holdGate);

  distGates = [];
  for (const d of [50, 100, 150]) {
    const label = makeLabel(`${d} m`, '#6FA8C8', 11);
    label.visible = false;
    overlay.add(label);
    distGates.push({ d, label });
  }
}

function rebuildCorridor() {
  if (!adv || !adv.corridor.length) {
    corridorMesh.visible = corridorEdges.visible = false;
    return;
  }
  corridorMesh.visible = corridorEdges.visible = true;

  const pts = adv.corridor;
  const verts = [], idx = [], lines = [];

  for (let i = 0; i < pts.length; i++) {
    const [x, y, z, hw] = pts[i];
    // lateral normal from the local direction of travel
    const [px, py] = i > 0 ? pts[i - 1] : [adv.ego_x, adv.ego_y];
    const [nx2, ny2] = i < pts.length - 1 ? pts[i + 1] : [x, y];
    const dx = nx2 - px, dy = ny2 - py;
    const L = Math.hypot(dx, dy) || 1;
    const nx = -dy / L, ny = dx / L;

    const lx = x + nx * hw, ly = y + ny * hw;
    const rx = x - nx * hw, ry = y - ny * hw;
    const h = z + 0.9;
    verts.push(lx, h, -ly, rx, h, -ry);

    if (i < pts.length - 1) {
      const o = i * 2;
      idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
    }
    // berm rails, as line segments between consecutive corridor points
    if (i > 0) {
      const p = pts[i - 1];
      const pdx = x - p[0], pdy = y - p[1];
      const pl = Math.hypot(pdx, pdy) || 1;
      const pnx = -pdy / pl, pny = pdx / pl;
      lines.push(p[0] + pnx * p[3], p[2] + 1.9, -(p[1] + pny * p[3]),
                 lx, h + 1.0, -ly);
      lines.push(p[0] - pnx * p[3], p[2] + 1.9, -(p[1] - pny * p[3]),
                 rx, h + 1.0, -ry);
    }
  }

  const g = corridorMesh.geometry;
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  g.attributes.position.needsUpdate = true;

  corridorEdges.geometry.setAttribute(
    'position', new THREE.Float32BufferAttribute(lines, 3));

  // range markers down the corridor
  let acc = 0, prev = [adv.ego_x, adv.ego_y];
  for (const gate of distGates) gate.placed = false;
  for (const [x, y, z] of pts) {
    acc += Math.hypot(x - prev[0], y - prev[1]);
    prev = [x, y];
    for (const gate of distGates) {
      if (!gate.placed && acc >= gate.d) {
        gate.label.position.copy(enu(x, y, z + 4));
        gate.label.visible = true;
        gate.placed = true;
      }
    }
  }
  for (const gate of distGates) if (!gate.placed) gate.label.visible = false;

  // hold point
  if (adv.token && adv.token.state === 'held' && adv.token.hold_x != null) {
    holdGate.visible = true;
    holdGate.position.copy(enu(adv.token.hold_x, adv.token.hold_y, adv.ego_z + 2.5));
    holdGate.lookAt(camera.position.x, holdGate.position.y, camera.position.z);
  } else {
    holdGate.visible = false;
  }
}

function syncNeighbours() {
  const seen = new Set();
  for (const n of (adv?.neighbours || [])) {
    seen.add(n.vehicle_id);
    let ent = neighbourMeshes.get(n.vehicle_id);
    if (!ent) {
      const group = makeDumper('info', n.loaded);
      const label = makeLabel(n.vehicle_id, '#E4E9EC', 12);
      const marker = new THREE.Mesh(
        new THREE.ConeGeometry(2.4, 6, 4),
        new THREE.MeshBasicMaterial({ color: 0xE4652F, transparent: true,
                                      opacity: 0.9, depthTest: false }));
      marker.rotation.x = Math.PI;
      marker.renderOrder = 13;
      scene.add(group); overlay.add(label); overlay.add(marker);
      ent = { group, label, marker };
      neighbourMeshes.set(n.vehicle_id, ent);
    }
    const urgent = n.ttc_s !== null && n.ttc_s < 8 && n.miss_m <= 18;
    ent.group.position.copy(enu(n.x, n.y, n.z));
    ent.group.rotation.y = n.heading;
    setDumperState(ent.group, urgent ? 'warning' : (n.around_corner ? 'caution' : 'info'),
                   n.loaded);

    // the marker floats above a vehicle the operator cannot possibly see
    ent.marker.position.copy(enu(n.x, n.y, n.z + 26));
    ent.marker.visible = n.around_corner || urgent;
    ent.marker.material.color.setHex(urgent ? 0xE4574F : 0xE4652F);

    ent.label.position.copy(enu(n.x, n.y, n.z + 19));
    setLabelText(ent.label,
      `${n.vehicle_id}  ${n.range_m.toFixed(0)}m${n.around_corner ? '  NO LOS' : ''}`,
      urgent ? '#E4574F' : (n.around_corner ? '#E4652F' : '#E4E9EC'), 12);
  }
  for (const [id, ent] of neighbourMeshes) {
    if (seen.has(id)) continue;
    scene.remove(ent.group); overlay.remove(ent.label); overlay.remove(ent.marker);
    neighbourMeshes.delete(id);
  }
}

/* ------------------------------------------------------------------ */
/* render                                                              */
/* ------------------------------------------------------------------ */

function updateCamera(dt) {
  if (!adv) return;
  if (!pose.ready) {
    pose.x = adv.ego_x; pose.y = adv.ego_y; pose.z = adv.ego_z; pose.h = adv.ego_heading;
    pose.ready = true;
  }
  const k = Math.min(1, dt * 6);
  pose.x += (adv.ego_x - pose.x) * k;
  pose.y += (adv.ego_y - pose.y) * k;
  pose.z += (adv.ego_z - pose.z) * k;
  let dh = adv.ego_heading - pose.h;
  dh = Math.atan2(Math.sin(dh), Math.cos(dh));
  pose.h += dh * k;

  camera.position.copy(enu(pose.x, pose.y, pose.z + EYE_H));
  const ahead = enu(pose.x + Math.cos(pose.h) * 60,
                    pose.y + Math.sin(pose.h) * 60,
                    pose.z + EYE_H - 1.5);
  camera.lookAt(ahead);
}

function renderPane(x, w, h, mode) {
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setViewport(x, 0, w, h);
  renderer.setScissor(x, 0, w, h);
  renderer.setScissorTest(true);

  if (mode === 'windscreen') {
    // real weather: exponential fog at the visibility the field reports
    const vis = adv ? adv.visibility_m : 1000;
    scene.fog = new THREE.FogExp2(0xCED6DA, fogExpDensity(vis));
    // sky must converge on the fog colour, or the terrain keeps a silhouette
    // against it and the white-out reads as fake
    scene.background = new THREE.Color(0x1A2126)
      .lerp(new THREE.Color(0xCED6DA), Math.min(1, fogDensity(vis) * 1.7));
    hemi.intensity = 1.5; sun.intensity = 0.25;
    overlay.visible = false;
  } else {
    // synthetic vision: no weather, dim terrain, bright surveyed geometry
    scene.fog = new THREE.Fog(0x0A0E11, 400, 1600);
    scene.background = new THREE.Color(0x0A0E11);
    hemi.intensity = 0.34; sun.intensity = 0.2;
    overlay.visible = true;
  }
  renderer.render(scene, camera);
}

let last = performance.now();
function frame() {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  updateCamera(dt);
  const W = renderer.domElement.width / renderer.getPixelRatio();
  const H = renderer.domElement.height / renderer.getPixelRatio();

  renderer.clear();
  if (split) {
    renderPane(0, W / 2, H, 'windscreen');
    renderPane(W / 2, W / 2, H, 'synthetic');
  } else {
    renderPane(0, W, H, 'synthetic');
  }
  renderer.setScissorTest(false);
  drawPaneLabels();

  // the twin ticks at 5 Hz, so redrawing the plan radar at display rate buys
  // nothing but heat
  if (now - lastPip > 90) { lastPip = now; drawPip(); }
}

/* pane captions live in the DOM so they stay crisp at any resolution */
function drawPaneLabels() {
  const wl = document.getElementById('pane-left');
  const wr = document.getElementById('pane-right');
  wl.style.display = split ? '' : 'none';
  wr.style.display = split ? '' : 'none';
  if (split && adv) {
    wl.textContent = `WINDSCREEN — VISIBILITY ${adv.visibility_m.toFixed(0)} M`;
    wr.textContent = 'SYNTHETIC VISION — FROM SURVEYED GEOMETRY';
  }
}


/* ================================================================== */
/* plan-view radar picture-in-picture                                  */
/* ================================================================== */

function setPip(on) {
  pipOn = on;
  document.getElementById('pipwrap').classList.toggle('off', !on);
  document.getElementById('pipbtn').classList.toggle('hot', on);
}

/**
 * Bird eye view of the near field, ego at the centre, nose up.
 *
 * The point it makes is not "here are some dots". It is the difference between
 * the two blip styles: a filled blip is a vehicle a sensor on this truck can
 * actually see, a hollow one is a vehicle only the twin knows about. In dense
 * fog most of them are hollow, and that gap is the whole capability.
 */
function drawPip() {
  if (!pipOn || !pipCtx) return;
  const ctx = pipCtx;
  const S = ctx.canvas.width;
  const cx = S / 2, cy = S / 2;
  const pad = 26;
  const k = (S / 2 - pad) / pipRange;          // metres -> pixels

  ctx.clearRect(0, 0, S, S);
  ctx.fillStyle = '#0A0D0F';
  ctx.beginPath(); ctx.arc(cx, cy, S / 2 - pad + 12, 0, 7); ctx.fill();

  // truck-frame azimuth (0 ahead, positive to the left) -> canvas point
  const pt = (azDeg, r) => {
    const a = azDeg * Math.PI / 180;
    return [cx - Math.sin(a) * r * k, cy - Math.cos(a) * r * k];
  };
  const wedge = (fromDeg, toDeg, r, fill, stroke, dash) => {
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    for (let a = fromDeg; a <= toDeg; a += 2) {
      const q = pt(a, r); ctx.lineTo(q[0], q[1]);
    }
    const e = pt(toDeg, r); ctx.lineTo(e[0], e[1]);
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) {
      ctx.strokeStyle = stroke; ctx.lineWidth = 2;
      ctx.setLineDash(dash || []); ctx.stroke(); ctx.setLineDash([]);
    }
  };

  // 1. blind arcs first, so coverage paints over them
  const vis = adv ? adv.visibility_m : 1000;
  const fogged = vis < 60;
  for (const b of (fogged ? blindFog : blindArcs)) {
    wedge(b.from, b.to, pipRange, 'rgba(228,87,79,.13)', 'rgba(228,87,79,.32)', [5, 5]);
  }

  // 2. detection sectors at their real ranges
  for (const sec of sectors) {
    if (fogged && !sec.fogProof) continue;      // optical is gone, do not imply it
    const r = Math.min(sec.range, pipRange);
    wedge(sec.yaw - sec.halfAz, sec.yaw + sec.halfAz, r,
          hexA(sec.colour, fogged ? 0.16 : 0.11), hexA(sec.colour, 0.34));
  }

  // 3. range rings
  ctx.strokeStyle = 'rgba(110,122,130,.34)';
  ctx.lineWidth = 1;
  ctx.font = Math.round(S * 0.036) + 'px "IBM Plex Mono", monospace';
  ctx.fillStyle = 'rgba(110,122,130,.75)';
  for (const r of [pipRange / 4, pipRange / 2, pipRange * 0.75, pipRange]) {
    ctx.beginPath(); ctx.arc(cx, cy, r * k, 0, 7); ctx.stroke();
    ctx.fillText(String(Math.round(r)), cx + 3, cy - r * k - 3);
  }
  ctx.beginPath();
  ctx.moveTo(cx, cy - (S / 2 - pad)); ctx.lineTo(cx, cy + (S / 2 - pad));
  ctx.moveTo(cx - (S / 2 - pad), cy); ctx.lineTo(cx + (S / 2 - pad), cy);
  ctx.stroke();

  // 4. neighbours
  for (const n of (adv ? adv.neighbours : [])) {
    const bDeg = wrapDeg(n.bearing_rad * 180 / Math.PI);
    const clamped = Math.min(n.range_m, pipRange);
    const q = pt(bDeg, clamped);
    const x = q[0], y = q[1];
    const urgent = n.ttc_s !== null && n.ttc_s < 8 && n.miss_m <= 18;
    const caution = n.ttc_s !== null && n.ttc_s < 15 && n.miss_m <= 18;
    const colour = urgent ? '#E4574F' : caution ? '#E0A93B'
                 : n.around_corner ? '#E4652F' : '#4FBE8B';
    const sensed = isSensed(sectors, bDeg, n.range_m, fogged);

    // heading tick, so a judge can read which way it is pointing
    if (adv) {
      const rel = wrapDeg((n.heading - adv.ego_heading) * 180 / Math.PI);
      const len = 6 + Math.min(18, n.speed * 1.6);
      const a = rel * Math.PI / 180;
      ctx.strokeStyle = colour; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, y);
      ctx.lineTo(x - Math.sin(a) * len, y - Math.cos(a) * len); ctx.stroke();
    }

    ctx.beginPath(); ctx.arc(x, y, 7, 0, 7);
    if (sensed) { ctx.fillStyle = colour; ctx.fill(); }
    else {
      ctx.strokeStyle = colour; ctx.lineWidth = 2;
      ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]);
    }

    // closing ring: fills as the seconds run down
    if (urgent) {
      const frac = Math.max(0, 1 - n.ttc_s / 8);
      ctx.strokeStyle = '#E4574F'; ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, 13, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = colour;
    ctx.font = Math.round(S * 0.036) + 'px "IBM Plex Mono", monospace';
    ctx.fillText(n.vehicle_id.replace('DT-', ''), x + 11, y + 4);
  }

  // 5. ego, nose up
  ctx.fillStyle = '#E4E9EC';
  ctx.beginPath();
  ctx.moveTo(cx, cy - 13); ctx.lineTo(cx - 8, cy + 9);
  ctx.lineTo(cx, cy + 4); ctx.lineTo(cx + 8, cy + 9);
  ctx.closePath(); ctx.fill();

  ctx.fillStyle = 'rgba(110,122,130,.85)';
  ctx.font = Math.round(S * 0.038) + 'px "IBM Plex Mono", monospace';
  ctx.fillText('FWD', cx - 15, pad - 8);
  if (fogged) {
    ctx.fillStyle = '#E4574F';
    ctx.fillText('RADAR ONLY', cx - 46, S - 8);
  }
}

function hexA(hex, a) {
  const v = parseInt(hex.slice(1), 16);
  return 'rgba(' + ((v >> 16) & 255) + ',' + ((v >> 8) & 255) + ',' + (v & 255) + ',' + a + ')';
}

/* ------------------------------------------------------------------ */
/* instruments                                                         */
/* ------------------------------------------------------------------ */

function renderPanels() {
  if (!adv) return;
  const b = document.getElementById('banner');
  b.className = adv.alert;
  b.querySelector('.lvl').textContent = adv.alert;
  document.getElementById('reason').textContent = adv.alert_reason;

  document.getElementById('adv').innerHTML =
    `${(adv.speed_advisory_ms * 3.6).toFixed(0)} <small>km/h</small>`;

  const visEl = document.querySelector('#vis .v');
  visEl.innerHTML = `${adv.visibility_m >= 1000 ? '1000+' : adv.visibility_m.toFixed(0)} <small>m</small>`;
  visEl.className = 'v' + (adv.visibility_m < 50 ? ' bad' : '');

  const tk = document.querySelector('#token .v');
  if (!adv.token || adv.token.state === 'none') {
    tk.textContent = '—'; tk.className = 'v';
  } else if (adv.token.state === 'granted') {
    tk.innerHTML = `GO <small>${adv.token.zone_id}</small>`; tk.className = 'v granted';
  } else {
    tk.innerHTML = `HOLD <small>${adv.token.zone_id} · #${adv.token.queue_pos}</small>`;
    tk.className = 'v held';
  }

  document.getElementById('seg').textContent = adv.segment_id || '—';
  const md = document.querySelector('#mode .v');
  md.textContent = adv.mode;
  md.className = 'v' + (adv.mode !== 'A' ? ' deg' : '');

  document.getElementById('neigh').innerHTML = ttcCards();
}

/**
 * Live time-to-collision cards.
 *
 * The bar is the alert: it fills as the seconds run out, so an operator reads
 * urgency from motion rather than from parsing a number. Anything predicted to
 * pass wider than the haul road is greyed and carries no bar, because a safety
 * display that cries wolf at every truck on the next bench is a safety display
 * that gets ignored.
 */
function ttcCards() {
  if (!adv || !adv.neighbours.length) {
    return '<div class="row" style="color:var(--ink-3)">no vehicles within 250 m</div>';
  }
  const conflict = n => n.ttc_s !== null && n.miss_m <= 18 && n.closing_ms > 0.2;
  const rank = n => (conflict(n) ? n.ttc_s : 1e6);
  const level = n => {
    if (!conflict(n)) return '';
    if (n.ttc_s < 3) return 'lv-intervene';
    if (n.ttc_s < 8) return 'lv-warning';
    if (n.ttc_s < 15) return 'lv-caution';
    return '';
  };

  return adv.neighbours.slice().sort((a, b) => rank(a) - rank(b)).map(n => {
    const con = conflict(n);
    const fill = con ? Math.max(0, Math.min(1, 1 - n.ttc_s / 15)) * 100 : 0;
    const meta = con
      ? '<span class="ttc">ttc ' + n.ttc_s.toFixed(1) + ' s</span> &middot; closing '
        + n.closing_ms.toFixed(1) + ' m/s'
      : (n.closing_ms > 0
          ? 'passing wide, miss ' + n.miss_m.toFixed(0) + ' m'
          : 'opening');
    const stale = n.age_s > 1.5 ? ' &middot; stale ' + n.age_s.toFixed(1) + 's' : '';
    return '<div class="row ' + level(n) + (con ? '' : ' passing')
      + (n.around_corner ? ' corner' : '') + '">'
      + (n.around_corner ? '<div class="tag">around corner</div>' : '')
      + '<div class="hdr"><span class="id">' + n.vehicle_id + '</span>'
      + '<span class="rng">' + n.range_m.toFixed(0) + ' m</span></div>'
      + (con ? '<div class="bar"><i style="width:' + fill.toFixed(0) + '%"></i></div>' : '')
      + '<div class="meta">' + meta + stale + '</div></div>';
  }).join('');
}

async function pollSpeed() {
  try {
    const snap = await (await fetch('/api/snapshot')).json();
    updateCabList(snap);
    const me = snap.vehicles.find(v => v.vehicle_id === vehicleId);
    if (me) document.getElementById('spd').innerHTML =
      `${(me.speed * 3.6).toFixed(0)} <small>km/h</small>`;
  } catch (e) { /* twin unreachable: the HUD keeps flying the cached corridor */ }
  setTimeout(pollSpeed, 500);
}

function connect() {
  const gen = generation;                 // captured, not incremented: a
  // reconnect keeps the same generation, a cab switch bumps it and orphans us
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${proto}://${location.host}/ws/hud/${vehicleId}`);
  const conn = document.getElementById('conn');

  socket.onopen = () => {
    if (gen !== generation) return;
    conn.textContent = 'twin live'; conn.className = 'conn';
  };
  socket.onclose = () => {
    if (gen !== generation) return;       // superseded by a cab switch
    conn.textContent = 'link lost — cached twin';
    conn.className = 'conn down';
    setTimeout(() => { if (gen === generation) connect(); }, 1500);
  };
  socket.onmessage = ev => {
    if (gen !== generation) return;
    adv = JSON.parse(ev.data);
    rebuildCorridor();
    syncNeighbours();
    renderPanels();
  };
}

/**
 * Move the camera into another dumper's cab.
 *
 * Everything tied to the old vehicle has to go: the corridor is its road, the
 * neighbour models are its traffic, and the smoothed pose must teleport rather
 * than fly a kilometre across the pit over the next second.
 */
function switchCab(id) {
  if (!id || id === vehicleId) return;
  vehicleId = id;
  generation++;
  if (socket) { try { socket.close(); } catch (e) { /* already closing */ } }

  adv = null;
  pose.ready = false;
  corridorMesh.visible = corridorEdges.visible = false;
  holdGate.visible = false;
  for (const gate of distGates) gate.label.visible = false;
  for (const [, ent] of neighbourMeshes) {
    scene.remove(ent.group);
    overlay.remove(ent.label);
    overlay.remove(ent.marker);
  }
  neighbourMeshes.clear();

  const sel = document.getElementById('cabsel');
  if (sel.value !== id) sel.value = id;
  document.getElementById('banner').className = 'info';
  document.getElementById('reason').textContent = `switching to ${id}`;
  document.title = `FogTwin — Cab ${id}`;
  history.replaceState(null, '', `?vehicle=${encodeURIComponent(id)}`);

  connect();
}

function stepCab(delta) {
  if (cabIds.length < 2) return;
  const i = cabIds.indexOf(vehicleId);
  switchCab(cabIds[(i + delta + cabIds.length) % cabIds.length]);
}

const ALERT_DOT = {
  info: '#9AA6AD', advisory: '#6FA8C8', caution: '#E0A93B',
  warning: '#E4574F', intervene: '#FF3B30',
};

function updateCabList(snap) {
  const ids = snap.vehicles.map(v => v.vehicle_id).sort();
  const sel = document.getElementById('cabsel');
  if (ids.join() !== cabIds.join()) {
    cabIds = ids;
    sel.innerHTML = ids.map(id =>
      `<option value="${id}">${id}</option>`).join('');
    sel.value = ids.includes(vehicleId) ? vehicleId : sel.value;
  }
  // the twin forgets a vehicle it has not heard from in a minute; rather than
  // stare at a dead cab, hop to one that is still reporting
  if (ids.length && !ids.includes(vehicleId)) {
    switchCab(ids[0]);
    return;
  }
  const me = snap.vehicles.find(v => v.vehicle_id === vehicleId);
  const meta = document.getElementById('cabmeta');
  if (me) {
    const lvl = snap.alerts[vehicleId] || 'info';
    meta.innerHTML =
      `<span class="alertdot" style="background:${ALERT_DOT[lvl]}"></span>` +
      `${me.loaded ? 'loaded' : 'empty'} · ${me.payload_t.toFixed(0)} t · ` +
      `${cabIds.indexOf(vehicleId) + 1}/${cabIds.length}`;
  } else {
    meta.textContent = '—';
  }
}

boot();
