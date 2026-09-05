/* FogTwin hardware demonstrator.

   We do not have a 100 tonne dumper to wheel into the hall, so this stands in
   for one: every component of the retrofit kit modelled where it actually
   mounts, with the sensor coverage volumes it actually produces, the site
   infrastructure placed on the real Bailadila ridge, the rover we did build
   beside the truck we did not, and the harness that ties it together.

   Everything is driven by data/hardware.json — mounts, coverage, wiring, BOM
   and the rover mapping all read from one manifest, so the 3D scene and the
   cost table can never drift apart. */

import * as THREE from '../vendor/three.module.js';
import { Orbit } from './orbit.js';
import {
  enu, addLighting, loadSite, buildTerrain, buildRoads, makeLabel, buildSky,
} from './world.js';
import { detectionSectors, blindSectors } from './sensors.js';

const host = document.getElementById('scene');

let lights = null;          // { sun, fill, bounce } from addLighting
let idleSpin = true;        // slow turntable until the user takes the wheel
let hovered = null;         // component id under the cursor
let pulseT = 0;
const D2R = Math.PI / 180;

let HW = null;
let renderer, scene, camera, orbit;
let dumperGroup, roverGroup, siteGroup;
let raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();

let view = 'dumper';
let selected = null;
let exploded = false, explodeT = 0;
let tourStep = -1;

const parts = new Map();       // component id -> { mesh, base, group, leader }
const volumes = new Map();     // component id -> mesh
const covOn = new Set();
let site = null, siteLoaded = false;
let blindGroup = null, blindMode = 'off';   // off | all | fog

/* ================================================================== */
/* boot                                                                */
/* ================================================================== */

async function boot() {
  HW = await (await fetch('/api/hardware')).json();

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(host.clientWidth, host.clientHeight);
  renderer.setClearColor(0x0B0E10);
  // same filmic response as the control room, so the machine is lit the same
  // way here as it is out in the pit
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.96;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  host.appendChild(renderer.domElement);

  scene = new THREE.Scene();

  // A studio backdrop rather than flat black: the machine needs something to
  // sit against or its top edges have nothing to separate them from the void.
  scene.add(buildSky('#0A0F14', '#1B242C', '#05070A'));

  // Shadow extent is sized for a 10.6 m machine, not for the site view -- the
  // site toggles casting off in setView rather than trying to share one map.
  lights = addLighting(scene, { shadows: true, extent: 17,
                                centre: new THREE.Vector3(0, 0, 0) });
  // Studio balance, not the mine's. Outdoors the sky is an enormous soft
  // source and fill dominates; on a product stand you want one clear key so
  // edges separate and the machine actually casts something.
  lights.hemi.intensity = 0.30;
  lights.fill.intensity = 0.14;
  lights.bounce.intensity = 0.10;
  lights.sun.intensity = 2.35;
  scene.add(new THREE.AmbientLight(0xFFFFFF, 0.05));

  dumperGroup = buildDumperScene();
  roverGroup = buildRoverScene();
  siteGroup = new THREE.Group();
  roverGroup.visible = false;
  siteGroup.visible = false;
  scene.add(dumperGroup, roverGroup, siteGroup);

  camera = new THREE.PerspectiveCamera(45, host.clientWidth / host.clientHeight, 0.05, 30000);
  orbit = new Orbit(camera, renderer.domElement, new THREE.Vector3(0, 3, 0));
  orbit.minDist = 3; orbit.maxDist = 12000;

  buildCoverageToggles();
  buildSidePanel();
  wireUi();
  setView(viewFromHash());
  showDetail(null);

  renderer.domElement.addEventListener('click', onClick);
  renderer.domElement.addEventListener('pointermove', onHover);
  renderer.domElement.addEventListener('pointerleave', () => setHover(null));
  // the turntable is a courtesy while nobody is driving; the moment someone
  // does, it gets out of the way and stays out
  for (const ev of ['pointerdown', 'wheel', 'keydown']) {
    addEventListener(ev, () => { idleSpin = false; }, { passive: true });
  }
  addEventListener('resize', onResize);
  renderer.setAnimationLoop(frame);
}

function onResize() {
  camera.aspect = host.clientWidth / host.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(host.clientWidth, host.clientHeight);
}

/* ================================================================== */
/* the truck                                                           */
/* ================================================================== */

const steel = () => new THREE.MeshStandardMaterial({ color: 0xD4B843, roughness: 0.55, metalness: 0.4 });
const dark = () => new THREE.MeshStandardMaterial({ color: 0x23272A, roughness: 0.85 });
const glass = () => new THREE.MeshStandardMaterial({
  color: 0x0F2830, roughness: 0.15, metalness: 0.6, transparent: true, opacity: 0.75 });

/** Box in truck frame (x forward, y left, z up) sized L x W x H about a centre. */
function box(L, W, H, cx, cy, cz, mat) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(L, H, W), mat);
  m.position.copy(enu(cx, cy, cz));
  return m;
}

/**
 * A radial alpha ramp: opaque in the middle, gone by the rim. Used as the
 * ground pad's alphaMap so the pad has no visible edge to give itself away.
 */
let _fadeTex = null;
function radialFade() {
  if (_fadeTex) return _fadeTex;
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  const grd = ctx.createRadialGradient(S / 2, S / 2, S * 0.06, S / 2, S / 2, S / 2);
  grd.addColorStop(0, '#ffffff');
  grd.addColorStop(0.55, '#c8c8c8');
  grd.addColorStop(0.82, '#3a3a3a');
  grd.addColorStop(1, '#000000');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, S, S);
  _fadeTex = new THREE.CanvasTexture(cv);
  return _fadeTex;
}


function buildDumperScene() {
  const g = new THREE.Group();
  const t = HW.truck;

  // Ground pad. The old one was an opaque disc with a hard rim, which read as
  // a coin the truck was standing on. This fades to nothing at the edge, so the
  // machine sits in a pool of light instead of on a cut-out.
  const pad = new THREE.Mesh(
    new THREE.CircleGeometry(17, 64),
    new THREE.MeshStandardMaterial({
      color: 0x584E45, roughness: 1, metalness: 0,
      transparent: true, alphaMap: radialFade(), depthWrite: false,
    }));
  pad.rotation.x = -Math.PI / 2;
  pad.position.y = -0.01;
  pad.receiveShadow = true;
  g.add(pad);

  const truck = new THREE.Group();
  truck.name = 'truck';

  const frameMat = new THREE.MeshStandardMaterial({ color: 0x8C7B32, roughness: 0.7, metalness: 0.4 });
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xC9AE3E, roughness: 0.6, metalness: 0.35 });

  // main frame
  truck.add(box(9.2, 4.4, 1.1, -0.2, 0, 2.45, frameMat));
  // front deck and bumper
  truck.add(box(1.0, 5.2, 1.0, 4.7, 0, 3.35, frameMat));
  // dump body, tapered by stacking two boxes
  truck.add(box(7.4, 5.9, 2.4, -1.0, 0, 4.75, bodyMat));
  truck.add(box(6.4, 5.2, 0.9, -1.2, 0, 6.15, bodyMat));
  // canopy over the cab
  truck.add(box(3.0, 5.9, 0.35, 3.1, 0, 5.75, bodyMat));
  // cab box and glazing
  truck.add(box(1.9, 1.8, 2.1, 3.6, 1.5, 4.6, dark()));
  truck.add(box(0.06, 1.6, 1.2, 4.56, 1.5, 4.95, glass()));
  // exhaust stack
  const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.16, 1.5, 10), dark());
  stack.position.copy(enu(2.9, -1.2, 5.9));
  truck.add(stack);
  // access ladder
  for (let i = 0; i < 5; i++) {
    truck.add(box(0.5, 0.06, 0.05, 4.55, 1.9, 1.1 + i * 0.62, dark()));
  }

  // wheels: two front, four rear in duals
  const wheelGeo = new THREE.CylinderGeometry(t.wheel_r_m, t.wheel_r_m, 0.95, 20);
  const rim = new THREE.CylinderGeometry(0.75, 0.75, 1.0, 14);
  for (const [wx, wy] of [[3.2, 2.55], [3.2, -2.55],
                          [-2.5, 2.35], [-2.5, 3.35],
                          [-2.5, -2.35], [-2.5, -3.35]]) {
    const w = new THREE.Mesh(wheelGeo, dark());
    w.rotation.x = Math.PI / 2;
    w.position.copy(enu(wx, wy, t.wheel_r_m));
    truck.add(w);
    const r = new THREE.Mesh(rim, new THREE.MeshStandardMaterial({ color: 0x8C7B32, roughness: 0.6 }));
    r.rotation.x = Math.PI / 2;
    r.position.copy(enu(wx, wy, t.wheel_r_m));
    truck.add(r);
  }
  // the machine casts, the pad receives; nothing here should receive its own
  // shadow map onto itself at this scale
  truck.traverse(o => { if (o.isMesh) o.castShadow = true; });
  g.add(truck);

  // scale bar, because "10.6 m long" means nothing until you see it
  const bar = new THREE.Group();
  const barMat = new THREE.LineBasicMaterial({ color: 0x6E7A82 });
  const bp = [enu(-5.3, -4.6, 0.05), enu(5.3, -4.6, 0.05)];
  bar.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(bp), barMat));
  for (const x of [-5.3, 5.3]) {
    bar.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(
      [enu(x, -4.6, 0.05), enu(x, -4.6, 0.7)]), barMat));
  }
  const barLbl = makeLabel(`${t.length_m} m`, '#6E7A82', 11);
  barLbl.position.copy(enu(0, -4.6, 1.1));
  bar.add(barLbl);
  g.add(bar);

  // the kit itself
  for (const c of HW.components) {
    if (c.hidden) continue;
    const [L, W, H] = c.size;
    const mat = new THREE.MeshStandardMaterial({
      color: c.colour, emissive: c.colour, emissiveIntensity: 0.35,
      roughness: 0.4, metalness: 0.3 });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(
      Math.max(L, 0.06), Math.max(H, 0.06), Math.max(W, 0.06)), mat);
    const base = enu(c.pos[0], c.pos[1], c.pos[2]);
    mesh.position.copy(base);
    mesh.rotation.y = (c.yaw || 0) * D2R;
    mesh.userData.componentId = c.id;
    g.add(mesh);

    // A marker halo, so a 90 mm radar is still findable from 20 m out. It
    // deliberately ignores depth: half this kit mounts inside the frame or
    // behind the body, and a locator diagram that hides the thing you are
    // trying to locate is useless.
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(0.3, 14, 10),
      new THREE.MeshBasicMaterial({ color: c.colour, transparent: true,
                                    opacity: 0.25, depthWrite: false,
                                    depthTest: false }));
    halo.renderOrder = 8;
    halo.position.copy(base);
    halo.userData.componentId = c.id;
    g.add(halo);

    const label = makeLabel(c.label, c.colour, 11);
    label.position.copy(base.clone().add(new THREE.Vector3(0, 0.65, 0)));
    label.visible = false;
    g.add(label);

    // leader line, drawn only in the exploded view
    const leader = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([base.clone(), base.clone()]),
      new THREE.LineBasicMaterial({ color: c.colour, transparent: true, opacity: 0.5 }));
    leader.visible = false;
    g.add(leader);

    parts.set(c.id, { mesh, halo, label, leader, base, comp: c });

    if (c.coverage) {
      const vol = buildCoverage(c);
      vol.visible = false;
      g.add(vol);
      volumes.set(c.id, vol);
    }
  }

  blindGroup = buildBlindSpots();
  g.add(blindGroup);
  return g;
}

/**
 * The arcs no detection sensor reaches, drawn flat on the ground.
 *
 * Worth showing rather than hiding. With one forward and two rear-quarter
 * radars, the front quarters fall to the optical pair alone, and in dense fog
 * that means they are not covered at all: the gap widens from 54 to 75 degrees
 * a side. A judge who spots this unaided concludes the fit was guessed. A
 * judge who is shown it concludes it was designed, and the fix is two more
 * corner radars at 9k each — cheap enough that the honest answer to "why not
 * just fit them" is scheduling and wiring, not budget.
 */
function buildBlindSpots() {
  const grp = new THREE.Group();
  const sectors = detectionSectors(HW.components);

  for (const [mode, colour, radius] of [['all', 0xE0A93B, 55], ['fog', 0xE4574F, 55]]) {
    const layer = new THREE.Group();
    layer.name = mode;
    layer.visible = false;
    for (const b of blindSectors(sectors, { fogProofOnly: mode === 'fog' })) {
      const from = b.from * D2R, span = (b.to - b.from) * D2R;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(6, radius, 48, 1, from, span),
        new THREE.MeshBasicMaterial({ color: colour, transparent: true,
                                      opacity: 0.16, side: THREE.DoubleSide,
                                      depthWrite: false }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.12;
      layer.add(ring);

      const mid = (b.from + b.to) / 2 * D2R;
      const lbl = makeLabel(`${Math.round(b.span)}\u00B0 blind`,
                            mode === 'fog' ? '#E4574F' : '#E0A93B', 10);
      lbl.position.set(Math.cos(mid) * 32, 2.5, -Math.sin(mid) * 32);
      layer.add(lbl);
    }
    grp.add(layer);
  }
  return grp;
}

function setBlind(mode) {
  blindMode = mode;
  if (blindGroup) {
    for (const layer of blindGroup.children) layer.visible = (layer.name === mode);
  }
  document.querySelectorAll('[data-blind]').forEach(b =>
    b.classList.toggle('on', b.dataset.blind === mode));
  const note = document.getElementById('blindnote');
  if (note) {
    note.textContent = mode === 'off' ? ''
      : mode === 'all'
        ? 'Amber: no detection sensor of any kind reaches these arcs.'
        : 'Red: in dense fog the optical pair is gone, so only radar counts. '
          + 'Two more corner radars at 9k each close both wedges.';
  }
}

/* ---------- sensor coverage volumes -------------------------------- */

function buildCoverage(c) {
  const cv = c.coverage;
  const grp = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({
    color: cv.colour, transparent: true, opacity: 0.12,
    side: THREE.DoubleSide, depthWrite: false });
  const wire = new THREE.MeshBasicMaterial({
    color: cv.colour, transparent: true, opacity: 0.3, wireframe: true, depthWrite: false });

  let geo = null;
  if (cv.kind === 'cone') {
    geo = fanGeometry(cv.range_m, cv.az_deg * D2R, cv.el_deg * D2R);
  } else if (cv.kind === 'frustum') {
    geo = frustumGeometry(cv.range_m, cv.az_deg * D2R, cv.el_deg * D2R);
  } else if (cv.kind === 'sphere') {
    geo = new THREE.SphereGeometry(cv.range_m, 24, 16);
  } else if (cv.kind === 'dome') {
    // GNSS sky mask: the hemisphere the antenna needs kept clear
    geo = new THREE.SphereGeometry(cv.range_m, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2);
  }
  if (!geo) return grp;

  const inner = new THREE.Group();
  inner.add(new THREE.Mesh(geo, mat));
  inner.add(new THREE.Mesh(geo, wire));
  if (c.pitch) inner.rotation.z = c.pitch * D2R;
  grp.add(inner);
  grp.rotation.y = (c.yaw || 0) * D2R;
  grp.position.copy(enu(c.pos[0], c.pos[1], c.pos[2]));
  grp.renderOrder = 3;
  return grp;
}

/**
 * Radar fan: an apex at the antenna spreading to a wide arc in azimuth and a
 * narrow one in elevation.
 *
 * The obvious shortcut is an open-ended cylinder wedge, but a cylinder has
 * constant height, so the beam arrives at the antenna already 40 m tall and
 * reads as a wall standing beside the truck. The spread has to start at zero.
 */
function fanGeometry(range, az, el, segs = 28) {
  const h = range * Math.tan(el / 2);
  const v = [0, 0, 0];                       // apex at the antenna
  for (let i = 0; i <= segs; i++) {
    const th = -az / 2 + az * (i / segs);
    const x = range * Math.cos(th), z = -range * Math.sin(th);
    v.push(x, h, z, x, -h, z);               // top then bottom of the far arc
  }
  const top = i => 1 + i * 2, bot = i => 2 + i * 2;
  const idx = [];
  for (let i = 0; i < segs; i++) {
    idx.push(0, top(i), top(i + 1));                       // upper surface
    idx.push(0, bot(i + 1), bot(i));                       // lower surface
    idx.push(top(i), bot(i), bot(i + 1),                   // far face
             top(i), bot(i + 1), top(i + 1));
  }
  idx.push(0, bot(0), top(0));                             // side caps
  idx.push(0, top(segs), bot(segs));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Rectangular pyramid from the sensor out to its far plane. */
function frustumGeometry(range, az, el) {
  const hw = range * Math.tan(az / 2);
  const hh = range * Math.tan(el / 2);
  const v = [
    0, 0, 0,
    range, hh, hw, range, hh, -hw, range, -hh, -hw, range, -hh, hw,
  ];
  const idx = [0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1, 1, 3, 2, 1, 4, 3];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/* ================================================================== */
/* the rover we did build                                              */
/* ================================================================== */

function buildRoverScene() {
  const g = new THREE.Group();
  const r = HW.rover;
  const S = 1;                                  // true scale, in metres

  const pad = new THREE.Mesh(
    new THREE.CircleGeometry(1.2, 48),
    new THREE.MeshStandardMaterial({ color: 0x4A423C, roughness: 1 }));
  pad.rotation.x = -Math.PI / 2; pad.position.y = -0.001;
  g.add(pad);

  const body = new THREE.MeshStandardMaterial({ color: 0x3A4248, roughness: 0.6, metalness: 0.3 });
  const chassis = new THREE.Mesh(
    new THREE.BoxGeometry(r.length_m, 0.05, r.width_m), body);
  chassis.position.set(0, 0.075, 0);
  g.add(chassis);

  const deck = new THREE.Mesh(
    new THREE.BoxGeometry(r.length_m * 0.7, 0.035, r.width_m * 0.8), body);
  deck.position.set(-0.02, 0.135, 0);
  g.add(deck);

  const wheelGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.03, 16);
  const wmat = new THREE.MeshStandardMaterial({ color: 0x1E2225, roughness: 0.9 });
  for (const [wx, wz] of [[0.11, 0.115], [0.11, -0.115], [-0.11, 0.115], [-0.11, -0.115]]) {
    const w = new THREE.Mesh(wheelGeo, wmat);
    w.rotation.x = Math.PI / 2;
    w.position.set(wx, 0.05, wz);
    g.add(w);
  }

  // Rover-side parts, positioned by hand: this is a 34 cm machine, the mounts
  // do not map from the truck manifest. Only what is actually on the bench is
  // drawn -- an empty deck is more honest than a modelled part nobody bought.
  const roverParts = [
    ['radar-cl', 'HC-SR04 ultrasonic', [0.17, 0.125, 0]],
    ['imu', 'MPU-6050', [0.02, 0.155, 0.06]],
    ['edge', 'ESP32 DevKit V1', [-0.05, 0.165, 0]],
    ['psu', 'USB power bank', [0.04, 0.11, -0.07]],
    ['harness', 'Breadboard', [-0.05, 0.135, -0.06]],
  ];
  for (const [id, label, p] of roverParts) {
    const c = HW.components.find(x => x.id === id);
    if (!c) continue;
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(0.035, 0.018, 0.03),
      new THREE.MeshStandardMaterial({ color: c.colour, emissive: c.colour,
                                       emissiveIntensity: 0.5, roughness: 0.4 }));
    m.position.set(p[0], p[1], p[2]);
    m.userData.componentId = id;
    g.add(m);

    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(0.035, 10, 8),
      new THREE.MeshBasicMaterial({ color: c.colour, transparent: true,
                                    opacity: 0.18, depthWrite: false }));
    halo.position.copy(m.position);
    halo.userData.componentId = id;
    g.add(halo);

    const lbl = makeLabel(label, c.colour, 10);
    lbl.position.set(p[0], p[1] + 0.055, p[2]);
    g.add(lbl);
  }

  // the truck, ghosted at true scale behind it. The size gap is the point:
  // judges should see immediately that we are not pretending to own a dumper.
  const ghost = new THREE.Group();
  const gm = new THREE.MeshBasicMaterial({ color: 0x6E7A82, wireframe: true,
                                           transparent: true, opacity: 0.22 });
  const t = HW.truck;
  const gb = new THREE.Mesh(new THREE.BoxGeometry(t.length_m, t.height_m, t.width_m), gm);
  gb.position.set(-7.2, t.height_m / 2, 0);
  ghost.add(gb);
  const gl = makeLabel('100 t dumper, true scale', '#6E7A82', 11);
  gl.position.set(-7.5, t.height_m + 0.7, 0);
  ghost.add(gl);
  g.add(ghost);

  const rl = makeLabel(`${r.name} — ${(r.length_m * 100).toFixed(0)} cm`, '#8FE3C0', 11);
  rl.position.set(0, 0.30, 0);
  g.add(rl);

  return g;
}

/* ================================================================== */
/* site infrastructure, on the real ridge                              */
/* ================================================================== */

async function ensureSite() {
  if (siteLoaded) return;
  siteLoaded = true;

  site = await loadSite();
  siteGroup.add(buildTerrain(site));
  siteGroup.add(buildRoads(site));

  const g = site.graph;
  const byName = re => g.nodes.filter(n => re.test(n.name));
  const spread = (arr, n) => {
    if (n <= 0 || arr.length <= n) return arr;
    const step = arr.length / n;
    return Array.from({ length: n }, (_, i) => arr[Math.floor(i * step)]);
  };

  for (const inf of HW.infrastructure) {
    let spots = [];
    if (inf.place === 'none') continue;          // costed, but not a mast
    if (inf.place === 'ramp-heads') spots = spread(byName(/ramp head/i), inf.count);
    else if (inf.place === 'met-stations') spots = g.met_stations;
    else if (inf.place === 'crest') spots = [g.nodes.reduce((a, b) => (a.z > b.z ? a : b))];
    else if (inf.place === 'zones') {
      // deliberately NOT ramp heads: those already carry a roadside unit, and
      // stacking two masts on one node reads as a placement bug
      spots = spread(byName(/shovel|Crusher tip|Crusher approach/i), inf.count);
    }

    for (const s of spots) {
      const node = new THREE.Group();
      const mast = new THREE.Mesh(
        new THREE.CylinderGeometry(0.8, 1.1, inf.height_m, 8),
        new THREE.MeshStandardMaterial({ color: 0x8A949A, roughness: 0.8 }));
      mast.position.copy(enu(s.x, s.y, (s.z || 0) + inf.height_m / 2));
      node.add(mast);

      const head = new THREE.Mesh(
        new THREE.BoxGeometry(4.5, 3.4, 3.4),
        new THREE.MeshStandardMaterial({ color: inf.colour, emissive: inf.colour,
                                         emissiveIntensity: 0.55, roughness: 0.4 }));
      head.position.copy(enu(s.x, s.y, (s.z || 0) + inf.height_m + 1));
      head.userData.infraId = inf.id;
      node.add(head);

      if (inf.coverage_m > 0) {
        const dome = new THREE.Mesh(
          new THREE.SphereGeometry(inf.coverage_m, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2),
          new THREE.MeshBasicMaterial({ color: inf.colour, transparent: true,
                                        opacity: 0.07, side: THREE.DoubleSide,
                                        depthWrite: false }));
        dome.position.copy(enu(s.x, s.y, (s.z || 0) + inf.height_m));
        dome.userData.cov = inf.id;
        dome.visible = false;
        node.add(dome);
      }

      const lbl = makeLabel(inf.label, inf.colour, 10);
      lbl.position.copy(enu(s.x, s.y, (s.z || 0) + inf.height_m + 18));
      node.add(lbl);

      node.userData.infraId = inf.id;
      siteGroup.add(node);
    }
  }
}

/* ================================================================== */
/* interaction                                                         */
/* ================================================================== */

function onClick(ev) {
  if (view === 'wiring' || view === 'circuit') return;
  const r = renderer.domElement.getBoundingClientRect();
  pointer.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
  pointer.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);

  const root = view === 'rover' ? roverGroup : view === 'site' ? siteGroup : dumperGroup;
  for (const hit of raycaster.intersectObjects(root.children, true)) {
    const id = hit.object.userData.componentId;
    if (id) { select(id); return; }
    const inf = hit.object.userData.infraId;
    if (inf) { selectInfra(inf); return; }
  }
  select(null);
}

function setHover(id) {
  if (hovered === id) return;
  hovered = id;
  renderer.domElement.style.cursor = id ? 'pointer' : '';
  for (const [cid, p] of parts) {
    if (cid === selected) continue;              // selection owns its own look
    const on = cid === id;
    p.halo.material.opacity = on ? 0.55 : 0.25;
    p.mesh.material.emissiveIntensity = on ? 0.7 : 0.35;
  }
}

function onHover(ev) {
  if (view === 'wiring' || view === 'circuit' || view !== 'dumper') return;
  const r = renderer.domElement.getBoundingClientRect();
  pointer.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
  pointer.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(dumperGroup.children, true)
    .find(h => h.object.userData.componentId);
  setHover(hit ? hit.object.userData.componentId : null);
}


function select(id) {
  selected = id;
  for (const [cid, p] of parts) {
    const on = cid === id;
    p.mesh.material.emissiveIntensity = on ? 1.0 : 0.35;
    p.mesh.scale.setScalar(on ? 2.2 : 1);
    p.halo.scale.setScalar(on ? 1.7 : 1);
    p.halo.material.opacity = on ? 0.8 : 0.25;
    p.label.visible = on || exploded;
  }
  document.querySelectorAll('.crow').forEach(el =>
    el.classList.toggle('sel', el.dataset.id === id));
  showDetail(id ? HW.components.find(c => c.id === id) : null);

  // showing a sensor implies showing what it can see
  if (id && volumes.has(id) && !covOn.has(id)) toggleCoverage(id, true, true);
}

function selectInfra(id) {
  const inf = HW.infrastructure.find(i => i.id === id);
  if (!inf) return;
  selected = null;
  const el = document.getElementById('detail');
  el.innerHTML = `
    <h3>${inf.label}</h3>
    <div class="part">Site infrastructure &middot; ${inf.place.replace(/-/g, ' ')}</div>
    <div class="lbl">What it does</div><p>${inf.role}</p>
    <div class="specs">
      <div><div class="k">Mast height</div><div class="v">${inf.height_m} m</div></div>
      <div><div class="k">Coverage</div><div class="v">${inf.coverage_m ? inf.coverage_m + ' m' : '—'}</div></div>
      <div><div class="k">Power</div><div class="v">Mains + solar backup</div></div>
    </div>`;
}

function toggleCoverage(id, on, fit = false) {
  const v = volumes.get(id);
  if (!v) return;
  v.visible = on;
  if (on) covOn.add(id); else covOn.delete(id);
  const cb = document.querySelector(`input[data-cov="${id}"]`);
  if (cb) cb.checked = on;

  // A 250 m radar fan is invisible from 21 m away because you are standing
  // inside it. Pull back far enough to see the shape, capped so the truck does
  // not vanish to a speck for the long-range links.
  if (on && fit) {
    const c = HW.components.find(x => x.id === id);
    const r = c && c.coverage ? c.coverage.range_m : 0;
    const want = Math.max(28, Math.min(420, r * 1.35));
    if (want > orbit.dist) orbit.lookAt(new THREE.Vector3(0, 3.2, 0), want);
  }
}

/* ================================================================== */
/* views                                                               */
/* ================================================================== */

const LEGEND = {
  dumper: '<div><b>Click any component</b> in the scene or the list</div>' +
          '<div>E explodes the kit &middot; drag to orbit &middot; wheel to zoom</div>',
  site: '<div><b>Click a mast</b> to inspect it &middot; drag to orbit</div>' +
        '<div>Masts sit on the real haul network, not on a sketch</div>',
  rover: '<div><b>34 cm of rover</b>, publishing a dumper&rsquo;s message schema</div>' +
         '<div>Use the scale button to see it beside a real machine</div>',
  wiring: '',
  circuit: '',
};

const VIEW_CAM = {
  dumper: { target: new THREE.Vector3(0, 3.2, 0), dist: 21, yaw: 2.15, pitch: 0.26 },
  rover: { target: new THREE.Vector3(0, 0.15, 0), dist: 1.4, yaw: 0.9, pitch: 0.34 },
  site: { target: new THREE.Vector3(0, 1200, 0), dist: 1600, yaw: -0.8, pitch: 0.42 },
};

async function setView(v) {
  view = v;
  // keep the URL honest even when the tour drives the change; replaceState so
  // stepping through a tour does not bury the back button in history entries
  if (viewFromHash() !== v) history.replaceState(null, '', '#' + v);
  document.querySelectorAll('.viewbar [data-view]').forEach(b =>
    b.classList.toggle('on', b.dataset.view === v));
  document.getElementById('wiring').classList.toggle('on', v === 'wiring');
  document.getElementById('circuit').classList.toggle('on', v === 'circuit');
  document.getElementById('toggles').style.display = (v === 'dumper') ? '' : 'none';
  const lg = document.getElementById('legend');
  lg.classList.toggle('hidden', v === 'wiring' || v === 'circuit');
  lg.innerHTML = LEGEND[v] || '';
  document.getElementById('explode').style.display = (v === 'dumper') ? '' : 'none';

  // one shadow map cannot serve both a 10 m machine and a 2 km ridge
  if (lights) lights.sun.castShadow = (v === 'dumper' || v === 'rover');

  dumperGroup.visible = v === 'dumper';
  roverGroup.visible = v === 'rover';
  siteGroup.visible = v === 'site';

  if (v === 'site') {
    lg.innerHTML = '<div><b>Loading the Bailadila ridge…</b></div>';
    await ensureSite();
    VIEW_CAM.site.target = enu(0, 0, site.heightAt(0, 0));
    lg.innerHTML = LEGEND.site;
  }
  if (v === 'wiring') renderWiring();
  if (v === 'circuit') renderCircuit();

  const c = VIEW_CAM[v];
  if (c) {
    orbit.yaw = c.yaw; orbit.pitch = c.pitch;
    orbit.lookAt(c.target, c.dist);
  }
  // order matters: buildSidePanel writes the detail pane for the rover and
  // wiring views, so resetting it afterwards would wipe what it just wrote
  if (v === 'dumper' || v === 'site') showDetail(null);
  buildSidePanel();
}

/* ================================================================== */
/* side panel                                                          */
/* ================================================================== */

const GROUP_LABEL = {
  perception: 'Perception — the fog-facing sensors',
  localisation: 'Localisation — knowing where you are',
  compute: 'Compute',
  comms: 'Communications',
  cab: 'In-cab interface',
  power: 'Power and installation',
};

function buildSidePanel() {
  const el = document.getElementById('side');

  if (view === 'circuit') {
    const cc = HW.circuit;
    el.innerHTML = `
      <div class="grouphead">Supply</div>
      <div class="specs2">
        <div><div class="k">Source</div><div class="v">24 V DC</div></div>
        <div><div class="k">Kit rail</div><div class="v">12 V</div></div>
        <div><div class="k">Kit load</div><div class="v">${cc.supply.budget_w} W</div></div>
        <div><div class="k">Rail current</div><div class="v">${cc.supply.rail_a} A</div></div>
      </div>
      <div class="cnote">${cc.supply.headroom}</div>
      <div class="cnote">${cc.supply.ground}</div>

      <div class="grouphead">Protection</div>
      <ul class="plist">${cc.supply.protection.map(p => `<li>${p}</li>`).join('')}</ul>

      <div class="grouphead">Buses</div>
      <table class="bom">
        <thead><tr><th>Bus</th><th>Rate and topology</th></tr></thead>
        <tbody>${cc.buses.map(b => `<tr>
          <td><span class="sw" style="background:${b.colour};display:inline-block;
              width:8px;height:8px;border-radius:2px;margin-right:6px"></span>${b.label}</td>
          <td>${b.rate}<br><span style="color:var(--ink-3)">${b.cable}</span></td>
        </tr>`).join('')}</tbody>
      </table>

      <div class="grouphead">Fuses</div>
      <table class="bom">
        <thead><tr><th>ID</th><th>Rating</th><th>Protects</th></tr></thead>
        <tbody>${cc.fuses.map(f => `<tr><td>${f.id}</td>
          <td>${f.rating_a} A</td><td>${f.protects}</td></tr>`).join('')}</tbody>
      </table>`;
    showDetail(null);
    document.getElementById('detail').innerHTML = `
      <h3>${cc.j1939.label}</h3>
      <div class="part">Reads ${cc.j1939.reads.toLowerCase()}</div>
      <div class="lbl">Isolation</div><p>${cc.j1939.isolation}</p>
      <div class="lbl">Why it matters</div>
      <p class="fogline">${cc.j1939.why}</p>`;
    return;
  }

  if (view === 'wiring') {
    const power = HW.components.reduce((a, c) => a + c.power_w, 0);
    const parts = HW.components.reduce((a, c) => a + c.qty, 0);
    el.innerHTML = `
      <div class="grouphead">Parts list — one vehicle</div>
      <table class="bom">
        <thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Interface</th></tr></thead>
        <tbody>
        ${HW.components.map(c => `<tr>
          <td>${c.label}</td><td class="r">${c.qty}</td>
          <td class="r">${c.bus}</td></tr>`).join('')}
        <tr class="total"><td><b>Parts per dumper</b></td>
          <td class="r"><b>${parts}</b></td><td class="r"></td></tr>
        </tbody>
      </table>
      <div class="grouphead">Load and fitting</div>
      <table class="bom"><tbody>
        <tr><td>Peak electrical draw</td><td class="r">${power} W</td></tr>
        <tr><td>Supply</td><td class="r">isolated 24 V</td></tr>
        <tr><td>Fit time</td><td class="r">under one shift</td></tr>
        <tr><td>Driveline changes</td><td class="r">none</td></tr>
        <tr class="total"><td><b>OEM cooperation needed</b></td>
          <td class="r"><b>none</b></td></tr>
      </tbody></table>`;
    document.getElementById('detail').innerHTML =
      `<div class="lbl">Reading the diagram</div>
       <p>Amber is power off the isolated supply, blue is data into the compute
       hub, green is what leaves the vehicle. Every sensor terminates at one
       node, and that node makes every safety decision without asking the
       network for permission.</p>`;
    return;
  }

  if (view === 'rover') {
    el.innerHTML = `
      <div class="grouphead">Production part &rarr; what is on the bench</div>
      <div class="clist">
        ${[...HW.components]
            .sort((a, b) => (b.rover_built === true) - (a.rover_built === true))
            .map(c => {
              const built = c.rover_built === true;
              return `
          <button class="crow" data-id="${c.id}" ${built ? '' : 'data-unbuilt="1"'}
                  style="${built ? '' : 'opacity:.52'}">
            <span class="sw" style="background:${built ? c.colour : '#3A444C'}"></span>
            <span>
              <span style="color:var(--${built ? 'ink' : 'ink-3'})">${c.label}</span><br>
              <span style="color:var(--${built ? 'ok' : 'ink-3'})">${
                built ? '\u2713 ' : ''}${c.rover}</span>
            </span>
          </button>`;
            }).join('')}
      </div>`;
    document.getElementById('detail').innerHTML =
      `<button id="scalebtn" style="width:100%;margin-bottom:12px">Compare scale with a real dumper</button>
       <div class="lbl">Why this is honest</div>
       <p>The rover is not a scale model of a dumper and we do not pretend it
       is. <b>Seven of the fifteen production components have a real analogue on
       this board; eight are not fitted</b>, and the list says which. What is
       identical is everything above the driver layer — it publishes the same
       <code>VehicleState</code> message, so the twin cannot tell it apart from
       the simulated fleet.</p>
       <div class="lbl" style="margin-top:12px">The ultrasonic is not a radar</div>
       <p>The HC-SR04 is a pressure wave in air. It reaches four metres, sees a
       narrow slice straight ahead, cannot say what it found or how fast it is
       closing, and is stopped by the first solid thing in the way — so it
       can never see the machine around the bend. <b>Those limits are why it is
       here.</b> Put it beside the twin, which hands this node every neighbour
       inside 250 m from the map and their own pose beacons, and the gap is the
       argument for the whole project.</p>`;
    bindRows();
    const sb = document.getElementById('scalebtn');
    if (sb) sb.onclick = () => {
      // frame the rover and the ghosted 100 t machine together: the gap is
      // the honest part of this slide, so it should be seen, not described
      orbit.yaw = 1.5; orbit.pitch = 0.22;
      orbit.lookAt(new THREE.Vector3(-3.6, 1.6, 0), 17);
    };
    return;
  }

  if (view === 'site') {
    el.innerHTML = `
      <div class="grouphead">Site infrastructure</div>
      <div class="clist">
        ${HW.infrastructure.map(i => `
          <button class="crow" data-infra="${i.id}">
            <span class="sw" style="background:${i.colour}"></span>
            <span style="color:var(--ink)">${i.label}</span>
            <span class="qty">${i.bom_qty ?? i.count}</span>
          </button>`).join('')}
      </div>
      <div class="grouphead">Coverage</div>
      <div style="padding:0 14px 12px">
        <label style="display:flex;gap:8px;align-items:center;font-family:var(--mono);font-size:11px;color:var(--ink-2);cursor:pointer">
          <input type="checkbox" id="infracov" style="accent-color:var(--accent)">
          show radio and ranging coverage
        </label>
      </div>`;
    el.querySelectorAll('[data-infra]').forEach(b =>
      b.onclick = () => selectInfra(b.dataset.infra));
    const cb = el.querySelector('#infracov');
    if (cb) cb.onchange = e => {
      siteGroup.traverse(o => { if (o.userData.cov) o.visible = e.target.checked; });
    };
    return;
  }

  // dumper
  const groups = [...new Set(HW.components.map(c => c.group))];
  el.innerHTML = groups.map(gr => `
    <div class="grouphead">${GROUP_LABEL[gr] || gr}</div>
    <div class="clist">
      ${HW.components.filter(c => c.group === gr).map(c => `
        <button class="crow" data-id="${c.id}">
          <span class="sw" style="background:${c.colour}"></span>
          <span>${c.label}</span>
          <span class="qty">${c.qty > 1 ? '&times;' + c.qty : ''}</span>
        </button>`).join('')}
    </div>`).join('');
  bindRows();
}

function bindRows() {
  document.querySelectorAll('.crow[data-id]').forEach(b =>
    b.onclick = () => select(b.dataset.id));
}

function showDetail(c) {
  const el = document.getElementById('detail');
  if (!c) {
    el.innerHTML = `
      <div class="lbl">Retrofit kit</div>
      <p>Every part on this machine bolts on. There is no change to the
      driveline, no OEM cooperation needed, and no vehicle-control authority in
      phase one — which is what makes it deployable under existing DGMS
      permissions rather than after a multi-year safety case.</p>
      <div class="lbl">Pick a component</div>
      <p>Click anything in the scene, or a row in the list above, to see where
      it mounts, what it does, and how it behaves in fog.</p>`;
    return;
  }
  const cov = c.coverage;
  el.innerHTML = `
    <h3>${c.label}</h3>
    <div class="part">${c.part}</div>
    <div class="lbl">What it does</div><p>${c.role}</p>
    <div class="lbl">In dense fog</div><p class="fogline">${c.fog}</p>
    <div class="specs">
      <div><div class="k">Mount</div><div class="v">${c.pos[0].toFixed(1)}, ${c.pos[1].toFixed(1)}, ${c.pos[2].toFixed(1)} m</div></div>
      <div><div class="k">Interface</div><div class="v">${c.bus}</div></div>
      <div><div class="k">Draw</div><div class="v">${c.power_w} W</div></div>
      <div><div class="k">Fitted</div><div class="v">${c.qty} per vehicle</div></div>
      ${cov ? `<div><div class="k">Range</div><div class="v">${cov.range_m} m</div></div>
      <div><div class="k">Field of view</div><div class="v">${cov.az_deg ? cov.az_deg + '&deg; az' : cov.kind}</div></div>` : ''}
    </div>
    <div class="lbl">On the rover we built</div><p>${c.rover}</p>`;
}

/* ================================================================== */
/* coverage toggles                                                    */
/* ================================================================== */

function buildCoverageToggles() {
  const el = document.getElementById('covlist');
  el.innerHTML = HW.components.filter(c => c.coverage).map(c => `
    <label>
      <input type="checkbox" data-cov="${c.id}">
      <span class="sw" style="background:${c.colour}"></span>
      <span>${c.label.replace(/ radar| camera| antenna/, '')}</span>
    </label>`).join('') +
    `<label style="margin-top:6px;border-top:1px solid var(--rule);padding-top:6px">
      <input type="checkbox" id="callcov"><span class="sw" style="background:#E4E9EC"></span>
      <span>all at once</span></label>
     <div class="th" style="margin-top:10px;padding-top:8px;border-top:1px solid var(--rule)">Blind spots</div>
     <div style="display:flex;gap:4px;flex-wrap:wrap">
       <button data-blind="off" class="on">off</button>
       <button data-blind="all">any sensor</button>
       <button data-blind="fog">in fog</button>
     </div>
     <div id="blindnote" style="margin-top:7px;color:var(--ink-3);line-height:1.5"></div>`;

  el.querySelectorAll('input[data-cov]').forEach(cb =>
    cb.onchange = e => toggleCoverage(cb.dataset.cov, e.target.checked, true));
  el.querySelector('#callcov').onchange = e => {
    for (const id of volumes.keys()) toggleCoverage(id, e.target.checked);
  };
  el.querySelectorAll('[data-blind]').forEach(b =>
    b.onclick = () => setBlind(b.dataset.blind));
}

/* ================================================================== */
/* wiring diagram                                                      */
/* ================================================================== */

function renderWiring() {
  const el = document.getElementById('wiring');
  const W = 980, H = 660;
  const colOf = { perception: 90, localisation: 90, power: 90, compute: 430, comms: 770, cab: 770 };

  // lay each column out vertically, in manifest order
  const placed = {};
  const cols = { 90: [], 430: [], 770: [] };
  for (const c of HW.components) {
    if (c.hidden) continue;
    cols[colOf[c.group] ?? 430].push(c);
  }
  for (const [x, list] of Object.entries(cols)) {
    const gap = (H - 90) / (list.length + 1);
    list.forEach((c, i) => { placed[c.id] = { x: +x, y: 60 + gap * (i + 1) }; });
  }

  const BW = 170, BH = 34;
  const path = (a, b, kind) => {
    const mx = (a.x + b.x) / 2;
    return `<path d="M ${a.x + BW / 2} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x - BW / 2} ${b.y}"
      fill="none" stroke="${kind === 'power' ? '#E0A93B' : '#6FA8C8'}"
      stroke-width="${kind === 'power' ? 2.2 : 1.4}"
      stroke-dasharray="${kind === 'power' ? '6 4' : 'none'}" opacity=".65"/>`;
  };

  const wires = HW.links.map(l => {
    const a = placed[l.from], b = placed[l.to];
    if (!a || !b) return '';
    return (a.x <= b.x) ? path(a, b, l.kind) : path(b, a, l.kind);
  }).join('');

  const boxes = HW.components.filter(c => !c.hidden).map(c => {
    const p = placed[c.id];
    return `<g>
      <rect x="${p.x - BW / 2}" y="${p.y - BH / 2}" width="${BW}" height="${BH}"
            fill="#171B1F" stroke="${c.colour}" stroke-width="1.4" rx="2"/>
      <rect x="${p.x - BW / 2}" y="${p.y - BH / 2}" width="4" height="${BH}" fill="${c.colour}"/>
      <text x="${p.x - BW / 2 + 13}" y="${p.y - 2}" fill="#E4E9EC"
            font-family="IBM Plex Mono, monospace" font-size="11">${c.label.slice(0, 24)}</text>
      <text x="${p.x - BW / 2 + 13}" y="${p.y + 11}" fill="#6E7A82"
            font-family="IBM Plex Mono, monospace" font-size="9">${c.bus}</text>
    </g>`;
  }).join('');

  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
      <text x="90" y="34" fill="#6E7A82" font-family="IBM Plex Mono, monospace"
            font-size="10" letter-spacing="2.4" text-anchor="middle">SENSORS &amp; SUPPLY</text>
      <text x="430" y="34" fill="#6E7A82" font-family="IBM Plex Mono, monospace"
            font-size="10" letter-spacing="2.4" text-anchor="middle">COMPUTE</text>
      <text x="770" y="34" fill="#6E7A82" font-family="IBM Plex Mono, monospace"
            font-size="10" letter-spacing="2.4" text-anchor="middle">OUTPUTS</text>
      ${wires}${boxes}
      <g transform="translate(90 ${H - 22})">
        <line x1="0" y1="0" x2="26" y2="0" stroke="#E0A93B" stroke-width="2.2" stroke-dasharray="6 4"/>
        <text x="34" y="4" fill="#A9B4BB" font-family="IBM Plex Mono, monospace" font-size="10">power</text>
        <line x1="96" y1="0" x2="122" y2="0" stroke="#6FA8C8" stroke-width="1.4"/>
        <text x="130" y="4" fill="#A9B4BB" font-family="IBM Plex Mono, monospace" font-size="10">data</text>
      </g>
    </svg>`;
}

/* ================================================================== */
/* circuit schematic                                                   */
/* ================================================================== */
/* A wiring-level drawing rather than a block diagram: signal above,
   power below, machine side separated from kit side by a drawn isolation
   barrier. The barrier and the listen-only J1939 tap are the point of the
   whole picture — they are what makes "no vehicle-control authority" an
   electrical fact instead of a promise. */

const CQ = {
  ink: '#E4E9EC', dim: '#A9B4BB', faint: '#6E7A82',
  panel: '#171B1F', rule: '#2A3238',
  pwr: '#E0A93B', mach: '#C6493A', gnd: '#7A858C', bg: '#0F1316',
};
const MONO = 'IBM Plex Mono, ui-monospace, monospace';

function cTxt(x, y, t, o = {}) {
  return `<text x="${x}" y="${y}" fill="${o.fill || CQ.dim}" font-family="${MONO}"
    font-size="${o.size || 10}" text-anchor="${o.anchor || 'start'}"
    letter-spacing="${o.ls || 0}"${o.bold ? ' font-weight="600"' : ''}>${t}</text>`;
}

/* orthogonal run with a single mid elbow — schematics do not use curves */
function cWire(x1, y1, x2, y2, col, w = 1.4, dash, elbow) {
  const mx = elbow ?? (x1 + x2) / 2;
  const d = (y1 === y2) ? `M ${x1} ${y1} H ${x2}`
    : `M ${x1} ${y1} H ${mx} V ${y2} H ${x2}`;
  return `<path d="${d}" fill="none" stroke="${col}" stroke-width="${w}"
    stroke-linejoin="round"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
}

function cDot(x, y, col) {
  return `<circle cx="${x}" cy="${y}" r="3" fill="${col}"/>`;
}

function cBlock(x, y, w, h, label, sub, accent) {
  return `<g>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2"
          fill="${CQ.panel}" stroke="${accent}" stroke-width="1.3"/>
    <rect x="${x}" y="${y}" width="3.5" height="${h}" fill="${accent}"/>
    ${cTxt(x + 12, y + h / 2 - 2, label, { fill: CQ.ink, size: 10.5 })}
    ${sub ? cTxt(x + 12, y + h / 2 + 11, sub, { fill: CQ.faint, size: 8.5 }) : ''}
  </g>`;
}

/* an inline blade fuse: body with the element drawn through it */
function cFuse(x, y, id, rating, col) {
  return `<g>
    <rect x="${x - 15}" y="${y - 8}" width="30" height="16" rx="1.5"
          fill="${CQ.bg}" stroke="${col}" stroke-width="1.2"/>
    <path d="M ${x - 15} ${y} H ${x - 8} l 4 -4 l 8 8 l 4 -4 H ${x + 15}"
          fill="none" stroke="${col}" stroke-width="1.2"/>
    ${cTxt(x, y - 13, id, { fill: col, size: 8.5, anchor: 'middle' })}
    ${cTxt(x, y + 21, rating, { fill: CQ.faint, size: 8.5, anchor: 'middle' })}
  </g>`;
}

/* 120 ohm bus terminator */
function cRes(x, y, label, col) {
  return `<g>
    <path d="M ${x} ${y - 16} v 6 l -6 3 l 12 6 l -12 6 l 12 6 l -6 3 v 6"
          fill="none" stroke="${col}" stroke-width="1.3"/>
    ${cTxt(x + 11, y + 3, label, { fill: col, size: 8.5 })}
  </g>`;
}

function cGnd(x, y) {
  return `<g stroke="${CQ.gnd}" stroke-width="1.4" fill="none">
    <path d="M ${x} ${y} v 8"/><path d="M ${x - 9} ${y + 8} h 18"/>
    <path d="M ${x - 5.5} ${y + 12} h 11"/><path d="M ${x - 2} ${y + 16} h 4"/>
  </g>`;
}

function renderCircuit() {
  const el = document.getElementById('circuit');
  const cc = HW.circuit;
  const C = id => HW.components.find(c => c.id === id) || { label: id, colour: CQ.dim };
  const bus = id => cc.buses.find(b => b.id === id);
  const W = 1280, H = 1000;

  /* ---------------------------------------------------------- geometry */
  const SX = 68, SW = 208;                 // sensor column
  const EX = 556, EW = 264, EY = 168, EH = 302;   // edge compute
  const OX = 960, OW = 208;                // output column
  const LRAIL = 34, RRAIL = 1246;          // 12 V looms down each side
  const CANX = 366;                        // CAN-FD trunk

  const sens = [
    ['radar-lr', 96, 'eth', 'ETH0', 430],
    ['radar-cl', 158, 'canfd', 'CAN0'],
    ['radar-cr', 220, 'canfd', 'CAN0'],
    ['thermal', 282, 'usb', 'USB3-0', 450],
    ['cam', 344, 'gmsl', 'GMSL2', 470],
    ['gnss', 406, 'uart', 'UART0', 490],
    ['imu', 468, 'canfd', 'CAN0'],
    ['uwb', 530, 'spi', 'SPI0', 510],
  ];
  const outs = [
    ['modem', 206, 'usb', 'USB3-1'],
    ['lora', 274, 'spi', 'SPI0 CS2'],
    ['hud', 342, 'video', 'HDMI'],
    ['haptic', 410, 'analog', 'PWM'],
  ];
  const inPort = { ETH0: 200, 'CAN0': 240, 'USB3-0': 280, GMSL2: 320, UART0: 360, SPI0: 400 };
  const outPort = { 'USB3-1': 206, 'SPI0 CS2': 274, HDMI: 342, PWM: 410 };

  let g = '';

  /* ------------------------------------------------------ zone captions */
  g += cTxt(SX, 62, 'SENSORS', { fill: CQ.faint, size: 9.5, ls: 2.6, bold: true });
  g += cTxt(EX, 62, 'COMPUTE', { fill: CQ.faint, size: 9.5, ls: 2.6, bold: true });
  g += cTxt(OX, 62, 'OUTPUTS', { fill: CQ.faint, size: 9.5, ls: 2.6, bold: true });

  /* ------------------------------------------------------- 12 V looms */
  // fed from the top of the distribution block, routed round the outside so
  // no power conductor ever crosses the isolation barrier
  // the hop at x=575 is the one place a conductor crosses another without
  // joining it; drawn explicitly so nobody reads it as a junction
  g += `<path d="M 620 636 V 592 H 590 Q 575 576 560 592 H ${LRAIL} V 88"
          fill="none" stroke="${CQ.pwr}" stroke-width="2.2" stroke-linejoin="round"/>`;
  g += cWire(880, 700, RRAIL, 700, CQ.pwr, 2.2);
  g += cWire(RRAIL, 700, RRAIL, 198, CQ.pwr, 2.2);
  g += cTxt(LRAIL + 6, 84, '12 V', { fill: CQ.pwr, size: 8.5 });
  g += cTxt(RRAIL - 6, 194, '12 V', { fill: CQ.pwr, size: 8.5, anchor: 'end' });

  /* -------------------------------------------------------- sensor side */
  for (const [id, y, busId, port, elbow] of sens) {
    const c = C(id), b = bus(busId);
    g += cWire(LRAIL, y, SX, y, CQ.pwr, 1.6);        // power stub
    g += cDot(LRAIL, y, CQ.pwr);
    g += cBlock(SX, y - 21, SW, 42, c.label.slice(0, 26), `${c.power_w} W`, c.colour);

    if (busId === 'canfd') {                          // stub onto the trunk
      g += cWire(SX + SW, y, CANX, y, b.colour, 1.5);
      g += cDot(CANX, y, b.colour);
    } else {
      g += cWire(SX + SW, y, EX, inPort[port], b.colour, 1.5, null, elbow);
      g += cTxt(SX + SW + 12, y - 6, b.label, { fill: b.colour, size: 8.5 });
    }
  }

  /* ------------------------------------------------------- CAN-FD trunk */
  const cb = bus('canfd');
  g += `<path d="M ${CANX} 140 V 500" stroke="${cb.colour}" stroke-width="2.4" fill="none"/>`;
  g += cRes(CANX, 140, '120 &#937;', cb.colour);
  g += cRes(CANX, 500, '120 &#937;', cb.colour);
  g += cWire(CANX, 240, EX, inPort.CAN0, cb.colour, 2.0);
  g += cTxt(CANX + 12, 128, 'CAN-FD trunk &middot; 500 k / 2 M', { fill: cb.colour, size: 8.5 });

  /* -------------------------------------------------------------- edge */
  g += `<rect x="${EX}" y="${EY}" width="${EW}" height="${EH}" rx="3"
          fill="${CQ.panel}" stroke="${C('edge').colour}" stroke-width="1.8"/>`;
  g += cTxt(EX + EW / 2, EY + 34, 'EDGE COMPUTE NODE', { fill: CQ.ink, size: 12, anchor: 'middle', bold: true });
  g += cTxt(EX + EW / 2, EY + 50, 'Jetson Orin Nano &middot; ROS 2', { fill: CQ.faint, size: 9, anchor: 'middle' });
  g += cTxt(EX + EW / 2, EY + 64, '25 W', { fill: CQ.faint, size: 9, anchor: 'middle' });
  for (const [p, y] of Object.entries(inPort)) {
    g += `<rect x="${EX - 5}" y="${y - 8}" width="10" height="16" fill="${CQ.rule}"/>`;
    g += cTxt(EX + 14, y + 3.5, p, { fill: CQ.dim, size: 8.5 });
  }
  for (const [p, y] of Object.entries(outPort)) {
    g += `<rect x="${EX + EW - 5}" y="${y - 8}" width="10" height="16" fill="${CQ.rule}"/>`;
    g += cTxt(EX + EW - 14, y + 3.5, p, { fill: CQ.dim, size: 8.5, anchor: 'end' });
  }
  // supply into the edge, up from the distribution block
  g += `<rect x="${EX + EW / 2 - 5}" y="${EY + EH - 5}" width="10" height="10" fill="${CQ.rule}"/>`;
  g += cWire(EX + EW / 2, EY + EH, EX + EW / 2, 636, CQ.pwr, 2.2);
  g += cTxt(EX + EW / 2 + 10, EY + EH + 26, '12 V / 0 V', { fill: CQ.pwr, size: 8.5 });

  /* ------------------------------------------------------- output side */
  for (const [id, y, busId, port] of outs) {
    const c = C(id), b = bus(busId);
    g += cWire(EX + EW, outPort[port], OX, y, b.colour, 1.5);
    g += cTxt(OX - 12, y - 6, b.label, { fill: b.colour, size: 8.5, anchor: 'end' });
    g += cBlock(OX, y - 21, OW, 42, c.label.slice(0, 26), `${c.power_w} W`, c.colour);
    g += cWire(OX + OW, y, RRAIL, y, CQ.pwr, 1.6);
    g += cDot(RRAIL, y, CQ.pwr);
  }

  /* ---------------------------------------------------- machine side */
  // drawn as an enclosure rather than a dividing line: everything inside is the
  // machine's own electrics, and exactly two conductors leave it, both isolated
  const MBX = 50, MBY = 632, MBW = 250, MBH = 262;
  g += `<rect x="${MBX}" y="${MBY}" width="${MBW}" height="${MBH}" rx="4"
          fill="none" stroke="${CQ.mach}" stroke-width="1.5" stroke-dasharray="9 6"/>`;
  g += cTxt(MBX + 12, MBY + 22, 'MACHINE SIDE', { fill: CQ.mach, size: 10, ls: 1.8, bold: true });
  g += cTxt(MBX + 12, MBY + 36, 'nothing here is driven by the kit',
    { fill: CQ.faint, size: 8.5 });
  // the note belongs on the boundary itself, not in the title row
  g += cTxt(MBX + MBW / 2, MBY + MBH + 18, 'GALVANIC ISOLATION &middot; 1.5 kV',
    { fill: CQ.mach, size: 9, anchor: 'middle', ls: 1.4 });
  g += cTxt(MBX + MBW / 2, MBY + MBH + 31, 'two conductors leave, both isolated',
    { fill: CQ.faint, size: 8.5, anchor: 'middle' });

  g += cBlock(MBX + 16, MBY + 54, 172, 46, 'MACHINE 24 V', 'battery / alternator', CQ.mach);
  g += cBlock(MBX + 16, MBY + 168, 172, 46, 'J1939 DIAGNOSTIC', 'wheel speed, gear', CQ.mach);

  // crossing 1 — supply, through the fuse and the isolated converter
  g += cWire(MBX + 188, 709, 236, 709, CQ.mach, 2.2);
  g += cFuse(251, 709, 'F1', '10 A', CQ.mach);
  g += cWire(266, 709, 330, 709, CQ.mach, 2.2);
  // crossing 2 — the tap, receive only
  g += cWire(MBX + 188, 823, 330, 823, CQ.mach, 1.6);
  g += cTxt(MBX + 196, 816, 'RX only &middot; TX pin open', { fill: CQ.mach, size: 8.5 });

  /* ------------------------------------------------------- kit side */
  g += cTxt(330, 620, 'KIT SIDE', { fill: CQ.pwr, size: 10, ls: 1.8, bold: true });

  g += cBlock(330, 682, 220, 58, 'ISOLATED DC-DC', '24 V &rarr; 12 V &middot; 120 W', CQ.pwr);
  g += cWire(550, 711, 620, 711, CQ.pwr, 2.4);

  g += cBlock(330, 790, 190, 52, 'CAN ISOLATOR', 'listen-only &middot; TX open', cb.colour);
  // back up to the trunk, threading the gap between the converter and the
  // distribution block so it crosses nothing
  g += `<path d="M 520 816 H 575 V 560 H ${CANX} V 500"
          fill="none" stroke="${cb.colour}" stroke-width="1.6" stroke-linejoin="round"/>`;
  g += cTxt(583, 578, 'to the kit CAN trunk', { fill: cb.colour, size: 8.5 });

  /* ------------------------------------------- 12 V fused distribution */
  const DX = 620, DY = 636, DW = 280;
  const rows = cc.fuses.filter(f => f.rail === '12 V');
  const DH = 34 + rows.length * 19 + 12;
  g += `<rect x="${DX}" y="${DY}" width="${DW}" height="${DH}" rx="2"
          fill="${CQ.panel}" stroke="${CQ.pwr}" stroke-width="1.3"/>`;
  g += `<rect x="${DX}" y="${DY}" width="3.5" height="${DH}" fill="${CQ.pwr}"/>`;
  g += cTxt(DX + 12, DY + 20, '12 V FUSED DISTRIBUTION', { fill: CQ.ink, size: 10.5 });
  rows.forEach((f, i) => {
    const y = DY + 40 + i * 19;
    g += cTxt(DX + 14, y, f.id, { fill: CQ.pwr, size: 9 });
    g += cTxt(DX + 46, y, `${f.rating_a} A`, { fill: CQ.dim, size: 9 });
    g += cTxt(DX + 88, y, f.protects.slice(0, 30), { fill: CQ.faint, size: 9 });
  });

  /* ------------------------------------------------------- ground bus */
  const GY = 920;
  g += `<path d="M 330 ${GY} H 1160" stroke="${CQ.gnd}" stroke-width="2.2" fill="none"/>`;
  g += cWire(540, 740, 540, GY, CQ.gnd, 1.6);      // converter 0 V
  g += cDot(540, GY, CQ.gnd);
  g += cWire(860, DY + DH, 860, GY, CQ.gnd, 1.6);  // distribution 0 V
  g += cDot(860, GY, CQ.gnd);
  g += cGnd(390, GY);
  g += cTxt(640, GY + 14,
    'single-point star ground &middot; kit 0 V bonded to chassis at one stud behind the cab',
    { fill: CQ.gnd, size: 9 });

  /* ---------------------------------------------------------- legend */
  const leg = [
    ['24 V machine', CQ.mach, 2.2], ['12 V kit rail', CQ.pwr, 2.2],
    ['CAN-FD', cb.colour, 2.0], ['Ethernet', bus('eth').colour, 1.5],
    ['GMSL2 / HDMI', bus('gmsl').colour, 1.5], ['USB 3', bus('usb').colour, 1.5],
    ['SPI', bus('spi').colour, 1.5], ['0 V', CQ.gnd, 2.2],
  ];
  leg.forEach(([t, c, w], i) => {
    const x = SX + i * 132, y = 968;
    g += `<path d="M ${x} ${y} h 22" stroke="${c}" stroke-width="${w}"/>`;
    g += cTxt(x + 28, y + 3.5, t, { fill: CQ.dim, size: 9 });
  });

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H + 20}" width="${W}" height="${H + 20}">${g}</svg>`;
}

/* ================================================================== */
/* guided tour                                                         */
/* ================================================================== */

async function gotoStep(i) {
  const steps = HW.tour;
  tourStep = Math.max(0, Math.min(steps.length - 1, i));
  const s = steps[tourStep];
  document.getElementById('tour').classList.add('on');
  document.getElementById('tournum').textContent =
    `${String(tourStep + 1).padStart(2, '0')} / ${String(steps.length).padStart(2, '0')}`;
  document.getElementById('tourtitle').textContent = s.title;
  document.getElementById('tourbody').textContent = s.body;

  if (s.view !== view) await setView(s.view);

  // each step starts clean, or the fans accumulate into orange soup by step 5
  for (const id of volumes.keys()) toggleCoverage(id, false);
  select(s.focus || null);

  if (s.focus && parts.has(s.focus)) {
    const p = parts.get(s.focus);
    const cov = p.comp.coverage;
    // frame the component AND what it can see, with the machine still in shot
    const d = cov ? Math.max(22, Math.min(260, cov.range_m * 0.62)) : 16;
    const target = p.base.clone().lerp(new THREE.Vector3(0, 3.2, 0), 0.55);
    orbit.lookAt(target, d);
  } else if (VIEW_CAM[s.view]) {
    const c = VIEW_CAM[s.view];
    orbit.yaw = c.yaw; orbit.pitch = c.pitch;
    orbit.lookAt(c.target, c.dist);
  }
}

function exitTour() {
  tourStep = -1;
  document.getElementById('tour').classList.remove('on');
}

/* ================================================================== */

const VIEWS = ['dumper', 'site', 'rover', 'wiring', 'circuit'];

function viewFromHash() {
  const v = location.hash.replace('#', '');
  return VIEWS.includes(v) ? v : 'dumper';
}

function wireUi() {
  document.querySelectorAll('.viewbar [data-view]').forEach(b =>
    b.onclick = () => {
      exitTour();
      // let the hash drive the change, so back/forward retrace these steps
      if (viewFromHash() === b.dataset.view) setView(b.dataset.view);
      else location.hash = b.dataset.view;
    });

  addEventListener('hashchange', () => {
    const v = viewFromHash();
    if (v !== view) { exitTour(); setView(v); }
  });

  document.getElementById('explode').onclick = () => {
    exploded = !exploded;
    document.getElementById('explode').classList.toggle('on', exploded);
    for (const [, p] of parts) { p.leader.visible = exploded; p.label.visible = exploded; }
  };

  document.getElementById('tourbtn').onclick = () =>
    (tourStep < 0 ? gotoStep(0) : exitTour());
  document.getElementById('tourprev').onclick = () => gotoStep(tourStep - 1);
  document.getElementById('tournext').onclick = () => gotoStep(tourStep + 1);
  document.getElementById('tourexit').onclick = exitTour;

  addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    if (tourStep >= 0 && e.key === 'ArrowRight') gotoStep(tourStep + 1);
    if (tourStep >= 0 && e.key === 'ArrowLeft') gotoStep(tourStep - 1);
    if (e.key === 'Escape') exitTour();
    if (e.key.toLowerCase() === 'e' && view === 'dumper')
      document.getElementById('explode').click();
  });
}

/* ================================================================== */

function frame() {
  // exploded view: ease components outward from the machine centre, and keep
  // a leader line back to the true mount so the position stays readable
  const target = exploded ? 1 : 0;
  if (Math.abs(explodeT - target) > 0.001) {
    explodeT += (target - explodeT) * 0.12;
    const centre = new THREE.Vector3(0, 3.2, 0);
    for (const [, p] of parts) {
      const out = p.base.clone().sub(centre).multiplyScalar(0.85)
        .add(new THREE.Vector3(0, 1.6, 0));
      const pos = p.base.clone().addScaledVector(out, explodeT);
      p.mesh.position.copy(pos);
      p.halo.position.copy(pos);
      p.label.position.copy(pos.clone().add(new THREE.Vector3(0, 0.65, 0)));
      p.leader.geometry.setFromPoints([p.base, pos]);
      p.leader.geometry.computeBoundingSphere();
    }
  }
  // Idle turntable. Slow enough to read as considered rather than as a
  // spinning showroom prop, and it never resumes once interrupted.
  if (idleSpin && orbit && (view === 'dumper' || view === 'rover')) {
    orbit.yaw += 0.0016;
    orbit.apply();
  }

  // The selected marker breathes so you can see which part the panel on the
  // right is describing, without having to follow a leader line.
  pulseT += 0.05;
  const beat = 1 + Math.sin(pulseT) * 0.13;
  for (const [cid, p] of parts) {
    if (cid === selected) p.halo.scale.setScalar(1.7 * beat);
  }

  renderer.render(scene, camera);
}

boot();
