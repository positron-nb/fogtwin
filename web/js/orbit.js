/* A small orbit controller.

   three's own OrbitControls lives in a separate addons file; rather than vendor
   a second dependency for ~80 lines of behaviour, this does exactly what an
   operations overview needs and nothing else: drag to orbit, wheel to dolly,
   right-drag or shift-drag to pan, with a pitch clamp so the controller cannot
   accidentally end up underneath the pit floor. */

import * as THREE from '../vendor/three.module.js';

export class Orbit {
  constructor(camera, dom, target = new THREE.Vector3()) {
    this.cam = camera;
    this.dom = dom;
    this.target = target.clone();

    this.dist = 1400;
    this.yaw = -0.7;
    this.pitch = 0.62;          // radians above the horizon
    this.minPitch = 0.06;
    this.maxPitch = 1.45;
    this.minDist = 60;
    this.maxDist = 4200;

    this._drag = null;
    this._bind();
    this.apply();
  }

  _bind() {
    const d = this.dom;
    d.style.touchAction = 'none';
    d.addEventListener('contextmenu', e => e.preventDefault());

    d.addEventListener('pointerdown', e => {
      d.setPointerCapture(e.pointerId);
      this._drag = {
        x: e.clientX, y: e.clientY,
        pan: e.button === 2 || e.shiftKey,
      };
    });

    d.addEventListener('pointermove', e => {
      if (!this._drag) return;
      const dx = e.clientX - this._drag.x, dy = e.clientY - this._drag.y;
      this._drag.x = e.clientX; this._drag.y = e.clientY;

      if (this._drag.pan) {
        // pan across the ground plane, scaled by how far out we are
        const k = this.dist * 0.0013;
        const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
        const fwd = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
        this.target.addScaledVector(right, -dx * k);
        this.target.addScaledVector(fwd, -dy * k);
      } else {
        this.yaw -= dx * 0.005;
        this.pitch = Math.max(this.minPitch,
                     Math.min(this.maxPitch, this.pitch + dy * 0.004));
      }
      this.apply();
    });

    const end = e => { this._drag = null; };
    d.addEventListener('pointerup', end);
    d.addEventListener('pointercancel', end);

    d.addEventListener('wheel', e => {
      e.preventDefault();
      this.dist = Math.max(this.minDist,
                  Math.min(this.maxDist, this.dist * (1 + Math.sign(e.deltaY) * 0.12)));
      this.apply();
    }, { passive: false });
  }

  lookAt(v, dist) {
    this.target.copy(v);
    if (dist) this.dist = dist;
    this.apply();
  }

  topDown() {
    this.pitch = this.maxPitch;
    this.yaw = -Math.PI / 2;
    this.apply();
  }

  apply() {
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    this.cam.position.set(
      this.target.x + this.dist * cp * Math.sin(this.yaw),
      this.target.y + this.dist * sp,
      this.target.z + this.dist * cp * Math.cos(this.yaw),
    );
    this.cam.lookAt(this.target);
  }
}
