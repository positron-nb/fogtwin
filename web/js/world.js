/* FogTwin shared 3D world.

   The twin's static layer as real geometry: the actual Bailadila ridge from a
   30 m DEM, with the haul network CARVED into it. Both the control room and the
   cab HUD render this same world — one from above, one from inside a cab. That
   is the point of a twin: the operator and the controller look at one model,
   not at two pictures that happen to agree.

   The carve is the important part. Road elevations are DESIGNED — flat benches,
   ruling-grade ramps — and the terrain is then cut and filled to meet them,
   exactly as a real mine is built. Draping roads over raw terrain instead is
   what makes them float, sink, and merge into the hillside.

   Coordinates: the twin speaks ENU metres from the ridge crest (x east, y
   north, z up). three.js is y-up, so three(x, y, z) = enu(x, z, -y). */

import * as THREE from '../vendor/three.module.js';

const ROAD_LIFT = 0.35;          // running surface above the carved platform
const BERM_H = 1.7;              // safety berm along every road edge, metres
const BERM_W = 4.0;
const CARVE_BLEND_M = 46.0;      // cut/fill transition back to natural ground
const AREA_PAD_M = 620;          // scene extent beyond the road network
const TARGET_CELL_M = 8.0;
const MAX_GRID = 430;

export function enu(x, y, z) { return new THREE.Vector3(x, z, -y); }

function smoothstep(a, b, t) {
  const u = Math.max(0, Math.min(1, (t - a) / (b - a)));
  return u * u * (3 - 2 * u);
}

function hash2(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Smooth value noise. Raw hash noise per vertex looks like rock in a heightmap
 * and like television static once you compute normals from it — every triangle
 * gets its own random facet. Interpolating between lattice points keeps the
 * surface differentiable, so the shading reads as terrain.
 */
function valueNoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v - 0.5;
}

/* ================================================================== */
/* Site: DEM + road graph + the carved height field                    */
/* ================================================================== */

export async function loadSite() {
  const [graph, demMeta] = await Promise.all([
    fetch('/api/roadgraph').then(r => r.json()),
    fetch('/api/dem').then(r => r.json()),
  ]);
  const buf = await fetch('/api/dem.bin').then(r => r.arrayBuffer());
  const site = new Site(graph, demMeta, new Int16Array(buf));
  site.build();
  return site;
}

class Site {
  constructor(graph, demMeta, dem) {
    this.graph = graph;
    this.meta = demMeta;
    this.dem = dem;
    this.nodeById = Object.fromEntries(graph.nodes.map(n => [n.id, n]));

    const o = graph.origin;
    this.lat0 = o.lat; this.lon0 = o.lon;
    this.mLat = 111320.0;
    this.mLon = 111320.0 * Math.cos(o.lat * Math.PI / 180);
  }

  /** Raw ground elevation from the DEM, bilinear, at an ENU metre position. */
  demAt(x, y) {
    const m = this.meta;
    const lat = this.lat0 + y / this.mLat;
    const lon = this.lon0 + x / this.mLon;
    let col = (lon - m.west) / (m.east - m.west) * (m.width - 1);
    let row = (m.north - lat) / (m.north - m.south) * (m.height - 1);
    col = Math.min(Math.max(col, 0), m.width - 1.001);
    row = Math.min(Math.max(row, 0), m.height - 1.001);
    const c0 = col | 0, r0 = row | 0, fc = col - c0, fr = row - r0;
    const g = this.dem, W = m.width;
    return (g[r0 * W + c0] * (1 - fc) * (1 - fr) + g[r0 * W + c0 + 1] * fc * (1 - fr) +
            g[(r0 + 1) * W + c0] * (1 - fc) * fr + g[(r0 + 1) * W + c0 + 1] * fc * fr);
  }

  build() {
    const xs = this.graph.nodes.map(n => n.x), ys = this.graph.nodes.map(n => n.y);
    this.minX = Math.min(...xs) - AREA_PAD_M;
    this.maxX = Math.max(...xs) + AREA_PAD_M;
    this.minY = Math.min(...ys) - AREA_PAD_M;
    this.maxY = Math.max(...ys) + AREA_PAD_M;

    const spanX = this.maxX - this.minX, spanY = this.maxY - this.minY;
    this.cols = Math.min(MAX_GRID, Math.round(spanX / TARGET_CELL_M));
    this.rows = Math.min(MAX_GRID, Math.round(spanY / TARGET_CELL_M));
    this.dx = spanX / (this.cols - 1);
    this.dy = spanY / (this.rows - 1);

    this._rasteriseRoads();
    this._carve();
  }

  _idx(c, r) { return r * this.cols + c; }

  /**
   * For every cell: distance to the nearest road, that road's designed surface
   * elevation, and its half width. Done per edge over a local bounding box, so
   * the cost scales with road length rather than with grid area.
   */
  _rasteriseRoads() {
    const n = this.cols * this.rows;
    this.roadDist = new Float32Array(n).fill(1e9);
    this.roadZ = new Float32Array(n);
    this.roadHw = new Float32Array(n).fill(12);

    const reach = CARVE_BLEND_M + 40;

    for (const e of this.graph.edges) {
      const a = this.nodeById[e.a], b = this.nodeById[e.b];
      const hw = e.half_width ?? 12;
      const ex = b.x - a.x, ey = b.y - a.y;
      const len2 = ex * ex + ey * ey;

      const c0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - reach - this.minX) / this.dx));
      const c1 = Math.min(this.cols - 1, Math.ceil((Math.max(a.x, b.x) + reach - this.minX) / this.dx));
      const r0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - reach - this.minY) / this.dy));
      const r1 = Math.min(this.rows - 1, Math.ceil((Math.max(a.y, b.y) + reach - this.minY) / this.dy));

      for (let r = r0; r <= r1; r++) {
        const py = this.minY + r * this.dy;
        for (let c = c0; c <= c1; c++) {
          const px = this.minX + c * this.dx;
          let t = len2 ? ((px - a.x) * ex + (py - a.y) * ey) / len2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const d = Math.hypot(px - (a.x + t * ex), py - (a.y + t * ey));
          const i = this._idx(c, r);
          if (d < this.roadDist[i]) {
            this.roadDist[i] = d;
            this.roadZ[i] = a.z + t * (b.z - a.z);
            this.roadHw[i] = hw;
          }
        }
      }
    }
  }

  /**
   * Cut and fill. Inside the running surface the ground IS the road elevation;
   * just outside it a safety berm is thrown up; beyond that the surface blends
   * back to natural ground, which produces a cut face on the uphill side and an
   * embankment on the downhill side. That is the bench profile.
   */
  _carve() {
    const n = this.cols * this.rows;
    this.height = new Float32Array(n);

    for (let r = 0; r < this.rows; r++) {
      const py = this.minY + r * this.dy;
      for (let c = 0; c < this.cols; c++) {
        const px = this.minX + c * this.dx;
        const i = this._idx(c, r);
        // The DEM is 30 m data smoothed for driveability, so bare ground comes
        // out glassy. Two octaves of cheap noise put the rock back without
        // touching anything the twin measures.
        const ground = this.demAt(px, py)
          + valueNoise(px / 42, py / 42) * 4.2
          + valueNoise(px / 13, py / 13) * 1.4;
        const d = this.roadDist[i], hw = this.roadHw[i], rz = this.roadZ[i];

        if (d > hw + BERM_W + CARVE_BLEND_M) {
          this.height[i] = ground;
        } else if (d <= hw) {
          this.height[i] = rz;                                // running surface
        } else if (d <= hw + BERM_W) {
          // the windrow of blasted rock that stops a dumper going over the edge
          this.height[i] = rz + BERM_H * Math.sin((d - hw) / BERM_W * Math.PI);
        } else {
          const t = smoothstep(hw + BERM_W, hw + BERM_W + CARVE_BLEND_M, d);
          this.height[i] = rz + (ground - rz) * t;
        }
      }
    }
  }

  /** Carved ground height, bilinear. The surface everything else sits on. */
  heightAt(x, y) {
    const c = Math.min(Math.max((x - this.minX) / this.dx, 0), this.cols - 1.001);
    const r = Math.min(Math.max((y - this.minY) / this.dy, 0), this.rows - 1.001);
    const c0 = c | 0, r0 = r | 0, tc = c - c0, tr = r - r0;
    const h = this.height, C = this.cols;
    return (h[r0 * C + c0] * (1 - tc) * (1 - tr) + h[r0 * C + c0 + 1] * tc * (1 - tr) +
            h[(r0 + 1) * C + c0] * (1 - tc) * tr + h[(r0 + 1) * C + c0 + 1] * tc * tr);
  }
}

/* ================================================================== */
/* terrain mesh                                                        */
/* ================================================================== */

export function buildTerrain(site) {
  const geo = new THREE.PlaneGeometry(
    site.maxX - site.minX, site.maxY - site.minY, site.cols - 1, site.rows - 1);
  const pos = geo.attributes.position;
  const colours = new Float32Array(pos.count * 3);

  // Bailadila ore is a hard blue-grey haematite that weathers red-brown; bench
  // tops carry pale crushed laterite tracked out by haulage.
  const faceRock = new THREE.Color('#463A34');
  const benchTop = new THREE.Color('#7A6857');
  const oreBand = new THREE.Color('#5C3226');
  const running = new THREE.Color('#4C4642');
  const c = new THREE.Color();

  // PlaneGeometry rows run from +y down, so mesh row 0 is our maxY
  for (let r = 0; r < site.rows; r++) {
    for (let ci = 0; ci < site.cols; ci++) {
      const i = r * site.cols + ci;
      const src = (site.rows - 1 - r) * site.cols + ci;
      const h = site.height[src];
      pos.setZ(i, h);

      const east = site.height[src + (ci < site.cols - 1 ? 1 : 0)];
      const north = site.height[src - (r > 0 ? site.cols : 0)];
      const slope = Math.min(1, (Math.abs(east - h) + Math.abs(north - h)) / 7);

      const px = site.minX + ci * site.dx;
      const py = site.minY + (site.rows - 1 - r) * site.dy;

      if (site.roadDist[src] <= site.roadHw[src]) {
        c.copy(running);
      } else {
        c.copy(benchTop).lerp(faceRock, slope);
        c.lerp(oreBand, 0.3 * (0.5 + 0.5 * Math.sin(px * 0.008 + py * 0.011)));
      }
      c.offsetHSL(0, 0, valueNoise(px / 9, py / 9) * 0.07);
      colours[i * 3] = c.r; colours[i * 3 + 1] = c.g; colours[i * 3 + 2] = c.b;
    }
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  geo.computeVertexNormals();

  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.97, metalness: 0.02,
  }));
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set((site.minX + site.maxX) / 2, 0, -(site.minY + site.maxY) / 2);
  return mesh;
}

/* ================================================================== */
/* haul roads                                                          */
/* ================================================================== */

export function buildRoads(site) {
  const group = new THREE.Group();
  const surfaces = {};

  for (const e of site.graph.edges) {
    const a = site.nodeById[e.a], b = site.nodeById[e.b];
    const hw = e.half_width ?? 12;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1) continue;
    const steps = Math.max(2, Math.round(len / 12));
    const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;

    const verts = [], idx = [], leftPts = [], rightPts = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const cx = a.x + (b.x - a.x) * t, cy = a.y + (b.y - a.y) * t;
      const cz = a.z + (b.z - a.z) * t + ROAD_LIFT;
      const lx = cx + nx * hw, ly = cy + ny * hw;
      const rx = cx - nx * hw, ry = cy - ny * hw;
      verts.push(lx, cz, -ly, rx, cz, -ry);
      leftPts.push(new THREE.Vector3(lx, cz + BERM_H * 0.85, -ly));
      rightPts.push(new THREE.Vector3(rx, cz + BERM_H * 0.85, -ry));
      if (i < steps) {
        const o = i * 2;
        idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();

    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: e.conflict_zone ? 0x574B44 : 0x5E564F,
      roughness: 0.98, metalness: 0,
      // the carved platform sits at the same elevation, so bias the road
      // surface forward or the two z-fight across the whole network
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }));
    mesh.userData.edge = e;
    surfaces[e.id] = mesh;
    group.add(mesh);

    for (const pts of [leftPts, rightPts]) {
      group.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({
          color: e.conflict_zone ? 0xE4652F : 0x9FD8BE,
          transparent: true, opacity: 0.42,
        })));
    }
  }
  group.userData.surfaces = surfaces;
  return group;
}

export function buildZoneGates(site) {
  const group = new THREE.Group();
  const gates = {};

  for (const zone of (site.graph.conflict_zones || [])) {
    const edge = site.graph.edges.find(e => e.conflict_zone === zone.id);
    if (!edge) continue;
    const a = site.nodeById[edge.a], b = site.nodeById[edge.b];
    const hw = edge.half_width ?? 10;
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({
      color: 0x4FBE8B, emissive: 0x4FBE8B, emissiveIntensity: 0.4,
      transparent: true, opacity: 0.6,
    });
    const nx = -(b.y - a.y), ny = (b.x - a.x);
    const L = Math.hypot(nx, ny) || 1;
    for (const s of [-1, 1]) {
      const pillar = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, 16, 8), mat);
      pillar.position.copy(enu(a.x + (nx / L) * hw * s, a.y + (ny / L) * hw * s, a.z + 8));
      g.add(pillar);
    }
    g.userData.material = mat;
    gates[zone.id] = g;
    group.add(g);
  }
  group.userData.gates = gates;
  return group;
}

/* ================================================================== */
/* vehicles                                                            */
/* ================================================================== */

const ALERT_COLOUR = {
  info: 0x9AA6AD, advisory: 0x6FA8C8, caution: 0xE0A93B,
  warning: 0xE4574F, intervene: 0xFF3B30,
};

/**
 * A rigid-frame rear-dump truck at 2.2x true scale.
 *
 * The exaggeration is deliberate and worth saying out loud: a real CAT 785 is
 * ~10 m long on a 3 km site, which is two pixels from the overview camera.
 * Legibility beats literalism in an operations display.
 */
export function makeDumper(alert = 'info', loaded = false) {
  const g = new THREE.Group();
  const S = 2.2;
  const body = new THREE.MeshStandardMaterial({ color: 0xD4B843, roughness: 0.55, metalness: 0.35 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x24282B, roughness: 0.85 });

  const chassis = new THREE.Mesh(new THREE.BoxGeometry(10 * S, 2.0 * S, 5.0 * S), body);
  chassis.position.y = 2.5 * S;
  g.add(chassis);

  const tray = new THREE.Mesh(new THREE.BoxGeometry(7.2 * S, 3.2 * S, 5.8 * S), body);
  tray.position.set(-1.2 * S, 5.2 * S, 0);
  tray.rotation.z = -0.05;
  g.add(tray);

  const cab = new THREE.Mesh(new THREE.BoxGeometry(2.2 * S, 2.4 * S, 2.8 * S), dark);
  cab.position.set(3.9 * S, 5.0 * S, 0.9 * S);
  g.add(cab);

  const wheelGeo = new THREE.CylinderGeometry(1.8 * S, 1.8 * S, 1.4 * S, 12);
  for (const [wx, wz] of [[3.5, 2.3], [3.5, -2.3], [-2.5, 2.5], [-2.5, -2.5]]) {
    const w = new THREE.Mesh(wheelGeo, dark);
    w.rotation.x = Math.PI / 2;
    w.position.set(wx * S, 1.8 * S, wz * S);
    g.add(w);
  }

  const ore = new THREE.Mesh(
    new THREE.BoxGeometry(6.2 * S, 1.4 * S, 4.8 * S),
    new THREE.MeshStandardMaterial({ color: 0x6B2F1E, roughness: 1 }));
  ore.position.set(-1.2 * S, 7.1 * S, 0);
  ore.visible = loaded;
  g.add(ore);

  const beaconMat = new THREE.MeshBasicMaterial({ color: ALERT_COLOUR[alert] || 0x9AA6AD });
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(1.6 * S, 10, 8), beaconMat);
  beacon.position.set(3.3 * S, 7.4 * S, 0.9 * S);
  g.add(beacon);

  const halo = new THREE.Mesh(
    new THREE.RingGeometry(8 * S, 9.8 * S, 28),
    new THREE.MeshBasicMaterial({ color: ALERT_COLOUR[alert] || 0x9AA6AD,
                                  transparent: true, opacity: 0.3,
                                  side: THREE.DoubleSide, depthWrite: false }));
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = 0.7;
  g.add(halo);

  g.userData = { beaconMat, halo, ore };
  return g;
}

export function setDumperState(mesh, alert, loaded) {
  const c = ALERT_COLOUR[alert] || 0x9AA6AD;
  mesh.userData.beaconMat.color.setHex(c);
  mesh.userData.halo.material.color.setHex(c);
  mesh.userData.halo.material.opacity = (alert === 'info') ? 0.16 : 0.45;
  mesh.userData.ore.visible = loaded;
}

export function makeUncertaintyRing() {
  const m = new THREE.Mesh(
    new THREE.RingGeometry(0.9, 1.0, 40),
    new THREE.MeshBasicMaterial({ color: 0xE0A93B, transparent: true,
                                  opacity: 0.7, side: THREE.DoubleSide,
                                  depthWrite: false }));
  m.rotation.x = -Math.PI / 2;
  return m;
}

/* ================================================================== */
/* labels                                                              */
/* ================================================================== */

export function makeLabel(text, colour = '#E4E9EC', size = 13) {
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    transparent: true, depthTest: false, depthWrite: false,
    // Screen-space sizing. World-scaled labels are unreadable from the overview
    // camera and cover the windscreen from inside the cab; an operations
    // display wants text the same size wherever the camera is.
    sizeAttenuation: false,
  }));
  sprite.renderOrder = 20;
  setLabelText(sprite, text, colour, size);
  return sprite;
}

export function setLabelText(sprite, text, colour = '#E4E9EC', size = 13) {
  if (sprite.userData.text === text && sprite.userData.colour === colour) return;
  sprite.userData.text = text;
  sprite.userData.colour = colour;

  const cvs = document.createElement('canvas');
  const ctx = cvs.getContext('2d');
  const font = `600 ${size * 3}px "IBM Plex Mono", monospace`;
  ctx.font = font;
  cvs.width = Math.ceil(ctx.measureText(text).width) + 22;
  cvs.height = size * 4.4;
  ctx.font = font;
  ctx.fillStyle = 'rgba(10,13,15,.78)';
  ctx.fillRect(0, 0, cvs.width, cvs.height);
  ctx.fillStyle = colour;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 11, cvs.height / 2);

  const tex = new THREE.CanvasTexture(cvs);
  tex.minFilter = THREE.LinearFilter;
  if (sprite.material.map) sprite.material.map.dispose();
  sprite.material.map = tex;
  sprite.material.needsUpdate = true;

  const h = size / 620;
  sprite.scale.set(h * (cvs.width / cvs.height), h, 1);
}

/* ================================================================== */
/* fog                                                                 */
/* ================================================================== */

/**
 * Client-side visibility field, mirroring twin/visibility.py exactly: inverse
 * distance weighting on EXTINCTION, with a vertical penalty because fog
 * stratifies by height on these ridges.
 */
export function fogFieldFrom(stations) {
  const VERT = 4.0;
  return function visibilityAt(x, y, z) {
    if (!stations || !stations.length) return 1000;
    let num = 0, den = 0;
    for (const s of stations) {
      const dh = Math.hypot(x - s.x, y - s.y);
      const dv = Math.abs(z - s.z) * VERT;
      const d = Math.sqrt(dh * dh + dv * dv);
      if (d < 1) return s.visibility_m;
      let w = 1 / (d * d);
      if (s.source && s.source !== 'station') w *= 0.4;
      num += w * (3 / Math.max(s.visibility_m, 1)); den += w;
    }
    if (!den) return 1000;
    const k = num / den;                 // extinction, not metres — see the
    return k > 0 ? Math.min(1000, 3 / k) : 1000;   // note in visibility.py
  };
}

/**
 * Visibility in metres -> blanket opacity. 400 m is invisible, 5 m is a wall.
 *
 * The clamp on `base` is load-bearing. 10^2.6 is 398, so any visibility between
 * 398 and the 400 m cutoff makes the base very slightly negative, and
 * Math.pow(negative, 1.3) is NaN. NaN then survives the shader's
 * `if (vFog < 0.01) discard` — every comparison against NaN is false — and the
 * fragment renders black. That put a ring of black patches on the hillside
 * exactly where fog faded out to clear.
 */
export function fogDensity(visibility_m) {
  if (visibility_m >= 400 || !(visibility_m > 0)) return 0;
  const base = Math.max(0, 1 - Math.log10(Math.max(visibility_m, 2)) / 2.6);
  return Math.min(1, Math.pow(base, 1.3));
}

/**
 * Visibility in metres -> three.js FogExp2 density, from Koschmieder's law.
 *
 * Meteorological visibility is the range at which contrast falls to the 5%
 * threshold, so the extinction coefficient k = 3/V. FogExp2 attenuates as
 * 1 - exp(-(density*d)^2); matching the two at d = V gives density = sqrt(3)/V.
 *
 * It means the windscreen pane whites out at exactly the range the visibility
 * field says it should, rather than at a range someone tuned by eye.
 */
export function fogExpDensity(visibility_m) {
  return Math.min(0.6, Math.sqrt(3) / Math.max(3, visibility_m));
}

/**
 * Cloud sitting on the benches. Alpha comes from the visibility field — the
 * same field driving the speed policy, not a decorative overlay. When one bench
 * fogs in and the crusher stays clear, this is the picture that makes the case.
 */
export function buildFogBlanket(site) {
  const cols = 128, rows = 116;
  const geo = new THREE.PlaneGeometry(
    site.maxX - site.minX, site.maxY - site.minY, cols, rows);
  const pos = geo.attributes.position;
  const dens = new Float32Array(pos.count);
  const world = [];

  // Cell size of the blanket, used to clear local relief. A sheet placed at a
  // fixed height above the ground sample at each vertex sinks INTO the hillside
  // between vertices wherever the terrain climbs faster than the sheet does —
  // and the un-fogged ground showing through those gaps reads as dark blotches
  // scattered over the slopes. Taking the highest ground within the cell keeps
  // the sheet above the rock it is supposed to be sitting on.
  const cw = (site.maxX - site.minX) / cols;
  const ch = (site.maxY - site.minY) / rows;

  for (let i = 0; i < pos.count; i++) {
    const px = site.minX + (pos.getX(i) + (site.maxX - site.minX) / 2);
    const py = site.minY + (pos.getY(i) + (site.maxY - site.minY) / 2);
    let h = site.heightAt(px, py);
    let top = h;
    for (const [ox, oy] of [[-cw, -ch], [cw, -ch], [-cw, ch], [cw, ch],
                            [0, -ch], [0, ch], [-cw, 0], [cw, 0]]) {
      top = Math.max(top, site.heightAt(px + ox * 0.5, py + oy * 0.5));
    }
    pos.setZ(i, top + 16);
    world.push([px, py, h]);
  }
  geo.setAttribute('aFog', new THREE.BufferAttribute(dens, 1));

  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { uTime: { value: 0 } },
    vertexShader: `
      attribute float aFog;
      varying float vFog;
      varying vec2 vWorld;
      void main() {
        vFog = aFog;
        vWorld = position.xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform float uTime;
      varying float vFog;
      varying vec2 vWorld;
      void main() {
        if (!(vFog > 0.01)) discard;   // also rejects NaN
        float drift = sin(vWorld.x * 0.006 + uTime * 0.12)
                    * cos(vWorld.y * 0.008 - uTime * 0.09);
        float a = clamp(vFog * (0.74 + 0.26 * drift), 0.0, 0.95);
        gl_FragColor = vec4(vec3(0.87, 0.90, 0.92), a);
      }`,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set((site.minX + site.maxX) / 2, 0, -(site.minY + site.maxY) / 2);
  mesh.renderOrder = 5;
  mesh.userData = { world, dens, geo, mat };
  return mesh;
}

export function updateFogBlanket(mesh, visibilityAt) {
  const { world, dens, geo } = mesh.userData;
  for (let i = 0; i < world.length; i++) {
    const [px, py, h] = world[i];
    dens[i] = fogDensity(visibilityAt(px, py, h));
  }
  geo.attributes.aFog.needsUpdate = true;
}

/* ================================================================== */

export function addLighting(scene) {
  // overcast monsoon light: low contrast, heavy sky term
  scene.add(new THREE.HemisphereLight(0xB4C2CA, 0x2E2622, 1.05));
  const sun = new THREE.DirectionalLight(0xFFF4E6, 0.95);
  sun.position.set(600, 900, 420);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x6FA8C8, 0.28);
  fill.position.set(-700, 400, -600);
  scene.add(fill);
  return { sun, fill };
}
