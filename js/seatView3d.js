import * as THREE from 'three';
import { HALL, eyePosition } from './hall.js';

const HFOV_DEG = 80; // fixed horizontal field of view → screen size is comparable on any device

/**
 * Renders the auditorium and places the camera at the eyes of a person
 * sitting in the chosen seat, looking at the centre of the screen.
 */
export class SeatView3D {
  constructor(container, seats, hall = HALL) {
    this.container = container;
    this.hall = hall;
    this.seats = seats;
    this.yaw = 0; this.pitch = 0;          // user look-around offset (radians)
    this.targetYaw = 0; this.targetPitch = 0;
    this.camFrom = null; this.camTo = null; this.camT = 1;
    this.showPeople = true;
    this.title = '';

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x050507);
    this.scene.fog = new THREE.Fog(0x050507, 25, 60);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 120);

    this.#buildRoom();
    this.#buildScreen();
    this.#buildSeats();
    this.#bindInput();

    this.resizeObserver = new ResizeObserver(() => this.#resize());
    this.resizeObserver.observe(container);
    this.#resize();

    this.clock = new THREE.Clock();
    this.renderer.setAnimationLoop(() => this.#tick());
  }

  // ---------- public API ----------

  /** Move the camera to a seat. `taken` is a Set of occupied seat ids. */
  setSeat(seat, { animate = true } = {}) {
    const eye = eyePosition(seat, this.hall);
    const to = new THREE.Vector3(eye.x, eye.y, eye.z);
    this.currentSeat = seat;
    if (!animate || !this.camTo) {
      this.camFrom = to.clone(); this.camTo = to; this.camT = 1;
    } else {
      this.camFrom = this.camera.position.clone(); this.camTo = to; this.camT = 0;
    }
    this.#updatePeople();
  }

  setOccupied(taken) { this.taken = taken; this.#updatePeople(); }
  setTitle(title) { this.title = title; }
  setPeopleVisible(v) { this.showPeople = v; this.#updatePeople(); }
  resetLook() { this.targetYaw = 0; this.targetPitch = 0; }

  // ---------- scene construction ----------

  #buildRoom() {
    const h = this.hall;
    const depth = h.firstRowDist + h.rows.length * h.rowDepth + 3;
    const width = 22, height = h.screen.bottom + h.screen.height + 3 + h.rows.length * h.rise;
    this.roomDepth = depth;

    const wallMat = new THREE.MeshStandardMaterial({ color: 0x1b1420, roughness: 0.95 });
    const room = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth + 2), wallMat);
    room.material.side = THREE.BackSide;
    room.position.set(0, height / 2 - 0.01, depth / 2 - 1);
    this.scene.add(room);

    // acoustic wall panels for a sense of scale
    const panelMat = new THREE.MeshStandardMaterial({ color: 0x2a1d2e, roughness: 1 });
    for (let z = 3; z < depth - 1; z += 2.4) {
      for (const side of [-1, 1]) {
        const p = new THREE.Mesh(new THREE.BoxGeometry(0.12, 3.2, 2.1), panelMat);
        p.position.set(side * (width / 2 - 0.06), 3.2 + z * h.rise / h.rowDepth * 0.6, z);
        this.scene.add(p);
      }
    }

    // stadium steps
    const stepMat = new THREE.MeshStandardMaterial({ color: 0x241b25, roughness: 1 });
    const front = new THREE.Mesh(new THREE.BoxGeometry(width, 0.02, h.firstRowDist), stepMat);
    front.position.set(0, 0, h.firstRowDist / 2 - 0.5);
    this.scene.add(front);
    const stripMat = new THREE.MeshBasicMaterial({ color: 0xffb347 });
    h.rows.forEach((_, r) => {
      const y = r * h.rise;
      const z0 = h.firstRowDist + r * h.rowDepth - h.rowDepth / 2;
      const step = new THREE.Mesh(new THREE.BoxGeometry(width, y + 0.02, depth - z0), stepMat);
      step.position.set(0, (y + 0.02) / 2, z0 + (depth - z0) / 2);
      this.scene.add(step);
      // little LED strip on each step edge in the aisles
      for (const ax of this.#aisleXs()) {
        const led = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.02, 0.02), stripMat);
        led.position.set(ax, y + 0.03, z0);
        this.scene.add(led);
      }
    });

    // exit signs
    const exitMat = new THREE.MeshBasicMaterial({ color: 0x18d65a });
    for (const side of [-1, 1]) {
      const sign = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.25, 0.6), exitMat);
      sign.position.set(side * (width / 2 - 0.05), 2.6, 2);
      this.scene.add(sign);
    }

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.35));
    const hemi = new THREE.HemisphereLight(0x8899ff, 0x1a0f12, 0.35);
    this.scene.add(hemi);
    this.screenLight = new THREE.PointLight(0xaabbff, 60, 40, 1.6);
    this.screenLight.position.set(0, h.screen.centerY, 2.5);
    this.scene.add(this.screenLight);
  }

  #aisleXs() {
    // x positions of the two aisles, taken from the widest row
    const row = this.hall.rows.reduce((a, b) => (sum(b.blocks) > sum(a.blocks) ? b : a));
    const sw = this.hall.seatWidth, total = sum(row.blocks) * sw + (row.blocks.length - 1) * this.hall.aisle;
    const xs = []; let x = -total / 2;
    for (let b = 0; b < row.blocks.length - 1; b++) { x += row.blocks[b] * sw; xs.push(x + this.hall.aisle / 2); x += this.hall.aisle; }
    return xs;
  }

  #buildScreen() {
    const s = this.hall.screen;
    this.screenCanvas = document.createElement('canvas');
    this.screenCanvas.width = 1024;
    this.screenCanvas.height = Math.round(1024 / s.aspect);
    this.screenCtx = this.screenCanvas.getContext('2d');
    this.screenTex = new THREE.CanvasTexture(this.screenCanvas);
    this.screenTex.colorSpace = THREE.SRGBColorSpace;

    // slightly curved screen
    const geo = new THREE.CylinderGeometry(40, 40, s.height, 64, 1, true, Math.PI - s.width / 80, s.width / 40);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: this.screenTex, side: THREE.BackSide }));
    // cylinder axis is y; we want the arc's centre at z≈0 bulging away from the audience
    mesh.position.set(0, s.centerY, 40 - 0.0);
    mesh.scale.x = -1; // fix mirrored texture when viewed from inside
    this.scene.add(mesh);

    // black masking frame
    const frameMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
    const frame = new THREE.Mesh(new THREE.PlaneGeometry(s.width + 3, s.height + 2.4), frameMat);
    frame.position.set(0, s.centerY, -0.6);
    this.scene.add(frame);
  }

  #buildSeats() {
    const n = this.seats.length;
    const seatColor = new THREE.Color(0x8e1b2a), vipColor = new THREE.Color(0x4b2a8a), wheelColor = new THREE.Color(0x1f5f99);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.8 });
    const cushion = new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, 0.14, 0.5), mat, n);
    const back = new THREE.InstancedMesh(new THREE.BoxGeometry(0.52, 0.72, 0.12), mat, n);
    const arm = new THREE.InstancedMesh(new THREE.BoxGeometry(0.06, 0.2, 0.5), new THREE.MeshStandardMaterial({ color: 0x111111 }), n);

    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    const local = (seat, lx, ly, lz) => {
      q.setFromAxisAngle(up, seat.facing);
      const v = new THREE.Vector3(lx, ly, lz).applyQuaternion(q);
      return m.compose(new THREE.Vector3(seat.x + v.x, seat.floorY + v.y, seat.z + v.z), q, new THREE.Vector3(1, 1, 1));
    };
    this.seats.forEach((seat, i) => {
      cushion.setMatrixAt(i, local(seat, 0, 0.45, 0.02));
      back.setMatrixAt(i, local(seat, 0, 0.78, 0.28));
      arm.setMatrixAt(i, local(seat, -0.29, 0.62, 0.02));
      const c = seat.type === 'vip' ? vipColor : seat.type === 'wheel' ? wheelColor : seatColor;
      cushion.setColorAt(i, c); back.setColorAt(i, c);
    });
    this.scene.add(cushion, back, arm);

    // audience: one head + torso per seat, shown only for taken seats
    const skin = [0xe0b48f, 0xc6926a, 0x8d5a3b, 0xf1c9a5, 0x5c3a24];
    const shirts = [0x2d3a55, 0x553333, 0x2f4f3f, 0x444444, 0x6b5b2f, 0x1f1f2f];
    this.heads = new THREE.InstancedMesh(new THREE.SphereGeometry(0.11, 14, 10), new THREE.MeshStandardMaterial({ roughness: 0.9 }), n);
    this.torsos = new THREE.InstancedMesh(new THREE.BoxGeometry(0.42, 0.55, 0.26), new THREE.MeshStandardMaterial({ roughness: 1 }), n);
    this.seats.forEach((seat, i) => {
      this.heads.setColorAt(i, new THREE.Color(skin[i % skin.length]));
      this.torsos.setColorAt(i, new THREE.Color(shirts[(i * 7) % shirts.length]));
    });
    this.scene.add(this.heads, this.torsos);
    this.#updatePeople();
  }

  #updatePeople() {
    if (!this.heads) return;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    this.seats.forEach((seat, i) => {
      const occupied = this.showPeople && this.taken?.has(seat.id) && seat.id !== this.currentSeat?.id;
      if (!occupied) { this.heads.setMatrixAt(i, hidden); this.torsos.setMatrixAt(i, hidden); return; }
      q.setFromAxisAngle(up, seat.facing);
      const v = (lx, ly, lz) => new THREE.Vector3(lx, ly, lz).applyQuaternion(q).add(new THREE.Vector3(seat.x, seat.floorY, seat.z));
      const hScale = 0.95 + ((i * 37) % 11) / 100; // a bit of height variety
      this.torsos.setMatrixAt(i, m.compose(v(0, 0.8 * hScale, 0.12), q, new THREE.Vector3(1, hScale, 1)));
      this.heads.setMatrixAt(i, m.compose(v(0, 1.2 * hScale, 0.08), q, new THREE.Vector3(1, 1.15, 1)));
    });
    this.heads.instanceMatrix.needsUpdate = true;
    this.torsos.instanceMatrix.needsUpdate = true;
  }

  // ---------- input ----------

  #bindInput() {
    const el = this.renderer.domElement;
    let drag = null;
    el.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, yaw: this.targetYaw, pitch: this.targetPitch }; el.setPointerCapture(e.pointerId); });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const k = (HFOV_DEG * Math.PI / 180) / el.clientWidth;
      this.targetYaw = clamp(drag.yaw + (e.clientX - drag.x) * k, -1.3, 1.3);
      this.targetPitch = clamp(drag.pitch + (e.clientY - drag.y) * k, -0.6, 0.6);
    });
    const end = () => { drag = null; };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  #resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    const hf = (HFOV_DEG * Math.PI) / 180;
    this.camera.fov = (2 * Math.atan(Math.tan(hf / 2) / this.camera.aspect) * 180) / Math.PI;
    this.camera.updateProjectionMatrix();
  }

  // ---------- frame loop ----------

  #tick() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    const t = this.clock.elapsedTime;
    this.#drawScreen(t);

    if (this.camTo) {
      this.camT = Math.min(1, this.camT + dt / 0.6);
      const e = 1 - Math.pow(1 - this.camT, 3);
      this.camera.position.lerpVectors(this.camFrom, this.camTo, e);
    }
    this.yaw += (this.targetYaw - this.yaw) * Math.min(1, dt * 10);
    this.pitch += (this.targetPitch - this.pitch) * Math.min(1, dt * 10);

    // base direction: from eye to screen centre, then apply look-around offsets
    const p = this.camera.position;
    const baseYaw = Math.atan2(-p.x, -p.z);
    const basePitch = Math.atan2(this.hall.screen.centerY - p.y, Math.hypot(p.x, p.z));
    const yaw = baseYaw + this.yaw, pitch = basePitch + this.pitch;
    const dir = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    this.camera.lookAt(p.clone().add(dir));

    this.renderer.render(this.scene, this.camera);
  }

  /** Animated placeholder "trailer" so the screen feels alive. */
  #drawScreen(t) {
    const c = this.screenCtx, W = this.screenCanvas.width, H = this.screenCanvas.height;
    const hue = (t * 8) % 360;
    const g = c.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, `hsl(${hue}, 60%, 22%)`);
    g.addColorStop(0.6, `hsl(${(hue + 40) % 360}, 70%, 55%)`);
    g.addColorStop(1, `hsl(${(hue + 60) % 360}, 80%, 70%)`);
    c.fillStyle = g; c.fillRect(0, 0, W, H);

    // sun
    c.fillStyle = 'rgba(255,240,200,.9)';
    c.beginPath(); c.arc(W * 0.7, H * 0.55 - Math.sin(t * 0.3) * 30, 50, 0, Math.PI * 2); c.fill();

    // parallax mountains
    const layers = [['#2b1f3a', 0.62, 6, 0.35], ['#1b1328', 0.72, 14, 0.5], ['#0c0914', 0.84, 28, 0.7]];
    for (const [col, base, speed, amp] of layers) {
      c.fillStyle = col; c.beginPath(); c.moveTo(0, H);
      for (let x = 0; x <= W; x += 16) {
        const u = (x + t * speed * 4) / 140;
        c.lineTo(x, H * base - (Math.sin(u) * 0.5 + Math.sin(u * 2.3) * 0.3 + Math.sin(u * 0.7) * 0.2) * H * 0.18 * amp * 2);
      }
      c.lineTo(W, H); c.fill();
    }

    // title + safe-area guides help judge readability of subtitles from the seat
    c.fillStyle = 'rgba(255,255,255,.95)';
    c.font = 'bold 56px system-ui, sans-serif';
    c.textAlign = 'center';
    c.fillText(this.title || 'Row 7 Cinemas', W / 2, H * 0.3);
    c.font = '26px system-ui, sans-serif';
    c.fillStyle = 'rgba(255,255,255,.9)';
    c.fillText('— Έτσι διαβάζονται οι υπότιτλοι από τη θέση σας —', W / 2, H * 0.92);

    this.screenTex.needsUpdate = true;
    if (this.screenLight) this.screenLight.color.setHSL(((hue + 40) % 360) / 360, 0.35, 0.7);
  }
}

function sum(a) { return a.reduce((x, y) => x + y, 0); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
