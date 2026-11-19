import * as THREE from 'three';

const STORAGE_KEY = 'interior-design.person.v1';
const MODEL_HEIGHT = 1.75; // the figure below is modelled at this height
const EYE_RATIO = 0.93; // eye height / body height
const RADIUS = 0.22; // keep this far from wall surfaces when walking
const LOOK_SPEED = 0.004;

/**
 * A human figure for scale, with a floor wedge showing what it sees, and an
 * "eye view" that puts the camera at its eyes. In eye view you drag to look
 * around and walk with WASD / arrow keys.
 */
export function createPerson({ scene, camera, controls, canvas, walls }) {
  const DEFAULTS = { placed: false, x: 0, z: 0, yaw: 0, height: 1.75, speed: 1.4 }; // speed in m/s
  const state = { ...DEFAULTS };
  try { Object.assign(state, JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')); } catch { /* ignore */ }

  let pitch = 0;
  let eye = false;
  let saved = null; // orbit camera to restore when leaving eye view
  let look = null; // active drag-to-look
  const keys = new Set();
  const listeners = new Set();

  // --- figure (faces local +x, like the walls' length axis) ---
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const clothes = new THREE.MeshStandardMaterial({ color: 0x5b7fa6, roughness: 0.8 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xd9b08c, roughness: 0.8 });
  const part = (geo, mat, x, y, z) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    body.add(m);
    return m;
  };
  const leg = new THREE.CapsuleGeometry(0.075, 0.68, 4, 12);
  part(leg, clothes, 0, 0.42, -0.1);
  part(leg, clothes, 0, 0.42, 0.1);
  part(new THREE.CapsuleGeometry(0.17, 0.5, 4, 16), clothes, 0, 1.17, 0).scale.set(0.75, 1, 1.15);
  const arm = new THREE.CapsuleGeometry(0.055, 0.58, 4, 10);
  part(arm, skin, 0, 1.12, -0.27);
  part(arm, skin, 0, 1.12, 0.27);
  part(new THREE.SphereGeometry(0.11, 20, 14), skin, 0, 1.62, 0);
  part(new THREE.ConeGeometry(0.03, 0.06, 8).rotateZ(-Math.PI / 2), skin, 0.12, 1.62, 0); // nose: shows facing

  // Floor wedge = horizontal field of view.
  const wedgeMat = new THREE.MeshBasicMaterial({ color: 0xf28c28, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide });
  const wedge = new THREE.Mesh(new THREE.BufferGeometry(), wedgeMat);
  wedge.position.y = 0.004;
  wedge.renderOrder = 2;
  root.add(wedge);
  let wedgeFov = 0;

  scene.add(root);

  function horizontalFov() {
    return 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * camera.aspect);
  }

  function syncFigure() {
    root.visible = state.placed && !eye;
    root.position.set(state.x, 0, state.z);
    root.rotation.y = -state.yaw;
    body.scale.setScalar(state.height / MODEL_HEIGHT);
  }

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
  }

  function emit() { listeners.forEach((fn) => fn()); }

  // --- walking with simple wall collision ---
  function distToSegment(px, pz, a, b) {
    const dx = b.x - a.x, dz = b.z - a.z;
    const len2 = dx * dx + dz * dz || 1e-9;
    const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (pz - a.z) * dz) / len2));
    return Math.hypot(px - (a.x + t * dx), pz - (a.z + t * dz));
  }
  function blocked(x, z) {
    return walls.list.some((w) => distToSegment(x, z, w.a, w.b) < w.thickness / 2 + RADIUS);
  }
  function tryMove(dx, dz) {
    // Move each axis separately so you slide along walls instead of sticking.
    const wasBlocked = blocked(state.x, state.z); // don't trap someone placed inside a wall
    if (wasBlocked || !blocked(state.x + dx, state.z)) state.x += dx;
    if (wasBlocked || !blocked(state.x, state.z + dz)) state.z += dz;
  }

  function placeCameraAtEyes() {
    const h = state.height * EYE_RATIO;
    camera.position.set(state.x, h, state.z);
    camera.lookAt(
      state.x + Math.cos(state.yaw) * Math.cos(pitch),
      h + Math.sin(pitch),
      state.z + Math.sin(state.yaw) * Math.cos(pitch)
    );
  }

  // --- eye view ---
  function enterEye() {
    if (eye) return;
    if (!state.placed) {
      // Drop the person at the orbit target, facing the way the camera looks.
      const dir = new THREE.Vector3();
      camera.getWorldDirection(dir);
      Object.assign(state, { placed: true, x: controls.target.x, z: controls.target.z, yaw: Math.atan2(dir.z, dir.x) });
    }
    saved = { position: camera.position.clone(), target: controls.target.clone() };
    eye = true;
    pitch = 0;
    controls.enabled = false;
    syncFigure();
    placeCameraAtEyes();
    emit();
  }

  function exitEye() {
    if (!eye) return;
    eye = false;
    keys.clear();
    look = null;
    // Return to orbit, centred on where the person now stands.
    const offset = saved.position.clone().sub(saved.target);
    controls.target.set(state.x, 0, state.z);
    camera.position.copy(controls.target).add(offset);
    controls.enabled = true;
    controls.update();
    syncFigure();
    save();
    emit();
  }

  // --- input (eye view only) ---
  canvas.parentElement.addEventListener('pointerdown', (e) => {
    if (!eye || e.target !== canvas) return;
    // Right-drag always looks; left-drag looks only in select mode (other tools draw).
    if (e.button === 2 || (e.button === 0 && api.leftDragLooks())) look = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener('pointermove', (e) => {
    if (!look) return;
    // First-person mouse look: drag right to look right, drag up to look up.
    state.yaw += (e.clientX - look.x) * LOOK_SPEED;
    pitch = THREE.MathUtils.clamp(pitch - (e.clientY - look.y) * LOOK_SPEED, -1.4, 1.4);
    look = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener('pointerup', () => { look = null; });

  const MOVE_KEYS = ['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'];
  window.addEventListener('keydown', (e) => {
    if (!eye || e.target.matches('input, select, textarea') || e.ctrlKey || e.metaKey) return;
    const k = e.key.toLowerCase();
    if (MOVE_KEYS.includes(k)) { keys.add(k); e.preventDefault(); }
  });
  window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
  window.addEventListener('blur', () => { keys.clear(); running = false; });
  let running = false; // hold Shift to walk faster
  window.addEventListener('keydown', (e) => { if (e.key === 'Shift') running = true; });
  window.addEventListener('keyup', (e) => { if (e.key === 'Shift') running = false; });

  syncFigure();

  const api = {
    /** Hide the floor view-wedge (e.g. for screenshots); returns a restore function. */
    hideHelpers() {
      const was = wedge.visible;
      wedge.visible = false;
      return () => { wedge.visible = was; };
    },
    /** Snapshot for saving to a file. */
    getState() { return { ...state }; },
    defaults: DEFAULTS,
    /** The orbit camera to return to (the current one when not in eye view). */
    orbitView() { return eye && saved ? saved : { position: camera.position, target: controls.target }; },
    /** Reset to defaults, then restore valid fields from a file (missing = no person). */
    setState(s) {
      exitEye();
      Object.assign(state, DEFAULTS);
      if (s && typeof s === 'object') {
        for (const k of Object.keys(state)) {
          if (typeof s[k] === typeof state[k] && (typeof s[k] !== 'number' || Number.isFinite(s[k]))) state[k] = s[k];
        }
      }
      syncFigure();
      save();
      emit();
    },
    get eye() { return eye; },
    get placed() { return state.placed; },
    get height() { return state.height; },
    get speed() { return state.speed; },
    setSpeed(v) {
      state.speed = v;
      save();
    },
    /** Set by main: whether left-drag should look around (vs. being used by a drawing tool). */
    leftDragLooks: () => true,
    isMoveKey: (k) => eye && MOVE_KEYS.includes(k),
    onChange(fn) { listeners.add(fn); },
    place(x, z) {
      Object.assign(state, { placed: true, x, z });
      syncFigure();
      emit();
    },
    face(yaw) {
      state.yaw = yaw;
      syncFigure();
    },
    position() { return { x: state.x, z: state.z }; },
    setHeight(h) {
      state.height = h;
      syncFigure();
      if (eye) placeCameraAtEyes();
      save();
    },
    remove() {
      exitEye();
      state.placed = false;
      syncFigure();
      save();
      emit();
    },
    save,
    toggleEye() { eye ? exitEye() : enterEye(); },
    exitEye,
    update(dt) {
      const hfov = horizontalFov();
      if (Math.abs(hfov - wedgeFov) > 1e-3) {
        wedgeFov = hfov;
        wedge.geometry.dispose();
        wedge.geometry = new THREE.CircleGeometry(2.5, 32, -hfov / 2, hfov).rotateX(-Math.PI / 2);
      }
      if (!eye) return;
      let f = 0, s = 0;
      if (keys.has('w') || keys.has('arrowup')) f += 1;
      if (keys.has('s') || keys.has('arrowdown')) f -= 1;
      if (keys.has('d') || keys.has('arrowright')) s += 1;
      if (keys.has('a') || keys.has('arrowleft')) s -= 1;
      if (f || s) {
        const speed = state.speed * (running ? 2 : 1) * dt / Math.hypot(f, s);
        const c = Math.cos(state.yaw), sn = Math.sin(state.yaw);
        tryMove((c * f - sn * s) * speed, (sn * f + c * s) * speed);
      }
      placeCameraAtEyes();
    },
  };

  return api;
}
