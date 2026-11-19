import * as THREE from 'three';

const STORAGE_KEY = 'interior-design.walls.v1';

// Unit box with its base on the ground; used for drawing previews (scaled into shape).
export const BOX_GEO = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);

export const DEFAULT_WALL_COLOR = '#ffffff';

// One shared material per colour.
const materials = new Map();
function wallMaterial(color) {
  let m = materials.get(color);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: 0.9 });
    materials.set(color, m);
  }
  return m;
}

// Selection is an outline, so the wall's real colour stays visible.
const outlineMat = new THREE.LineBasicMaterial({ color: 0x2a6df4, depthTest: false, transparent: true, opacity: 0.9 });

export const wallLength = (w) => Math.hypot(w.b.x - w.a.x, w.b.z - w.a.z);

const JOIN_EPS = 1e-4;
const near = (p, q) => Math.abs(p.x - q.x) < JOIN_EPS && Math.abs(p.z - q.z) < JOIN_EPS;
const cross2 = (p, q) => p.x * q.z - p.z * q.x;

/**
 * How far each long edge of wall `w` reaches past endpoint `end`
 * (negative = beyond the endpoint, positive = short of it).
 *  - free end: flush with the endpoint
 *  - two walls meeting: mitred along the bisector, so they join without overlap
 *  - three or more: plain overlap (extend by half the thickness)
 */
function endCut(w, end, list) {
  const P = w[end];
  const Q = end === 'a' ? w.b : w.a;
  const len = Math.hypot(Q.x - P.x, Q.z - P.z);
  const e1 = { x: (Q.x - P.x) / len, z: (Q.z - P.z) / len }; // from P into this wall
  const h = w.thickness / 2;

  const others = [];
  for (const o of list) {
    if (o === w) continue;
    if (near(o.a, P)) others.push(o.b);
    else if (near(o.b, P)) others.push(o.a);
  }
  if (others.length === 0) return { s: () => 0 };
  if (others.length > 1) return { s: () => -h };

  const R = others[0];
  const olen = Math.hypot(R.x - P.x, R.z - P.z) || 1;
  const bis = { x: e1.x + (R.x - P.x) / olen, z: e1.z + (R.z - P.z) / olen };
  const bl = Math.hypot(bis.x, bis.z);
  if (bl < 1e-6) return { s: () => 0 }; // straight continuation
  bis.x /= bl; bis.z /= bl;
  const limit = w.thickness * 3; // avoid long spikes at very sharp angles
  // Corner P + n*off + e1*s must lie on the bisector line through P.
  return {
    s: (n, off) => THREE.MathUtils.clamp(-off * cross2(n, bis) / cross2(e1, bis), -limit, Math.min(limit, len / 2)),
  };
}

/** Build a wall prism in world coordinates with mitred joints to its neighbours. */
function buildWallGeometry(w, list) {
  const len = wallLength(w);
  const u = { x: (w.b.x - w.a.x) / len, z: (w.b.z - w.a.z) / len };
  const n = { x: -u.z, z: u.x };
  const h = w.thickness / 2;
  const cutA = endCut(w, 'a', list);
  const cutB = endCut(w, 'b', list);
  // corner = endpoint + n*off + e1*s, where e1 points into the wall (u at a, -u at b)
  const corner = (P, e1, cut, off) => {
    const s = cut.s(n, off);
    return new THREE.Vector2(P.x + n.x * off + e1.x * s, -(P.z + n.z * off + e1.z * s));
  };
  const negU = { x: -u.x, z: -u.z };
  const shape = new THREE.Shape([
    corner(w.a, u, cutA, h),
    corner(w.b, negU, cutB, h),
    corner(w.b, negU, cutB, -h),
    corner(w.a, u, cutA, -h),
  ]);
  // Shape lives in XY with y = -z; extrude along +Z, then stand it up so the extrusion is height (+Y).
  return new THREE.ExtrudeGeometry(shape, { depth: w.height, bevelEnabled: false }).rotateX(-Math.PI / 2);
}

// Position/rotate/scale a box mesh so it spans a -> b along the wall centerline
// (used for drawing previews). Length is extended by the thickness to cover corners.
export function layoutWall(mesh, w) {
  const dx = w.b.x - w.a.x;
  const dz = w.b.z - w.a.z;
  mesh.position.set((w.a.x + w.b.x) / 2, 0, (w.a.z + w.b.z) / 2);
  mesh.rotation.set(0, -Math.atan2(dz, dx), 0);
  mesh.scale.set(Math.hypot(dx, dz) + w.thickness, w.height, w.thickness);
}

function disposeWallMesh(mesh) {
  mesh.geometry?.dispose();
  for (const child of [...mesh.children]) {
    child.geometry.dispose();
    mesh.remove(child);
  }
}

export class Walls {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);
    this.list = [];
    this.meshes = new Map();
    this.selectedId = null;
    this.undoStack = [];
    this.redoStack = [];
    this.listeners = new Set();
    this.load();
    this.sync(false);
  }

  onChange(fn) { this.listeners.add(fn); }

  get selected() { return this.list.find((w) => w.id === this.selectedId) ?? null; }

  endpoints() { return this.list.flatMap((w) => [w.a, w.b]); }

  // --- history ---
  // Each step stores the walls plus, via `extraState`, other scene objects
  // (the person). Extra state is only restored for steps that changed it
  // (`{ extra: true }`), so e.g. walking in eye view isn't undone by undoing
  // an unrelated wall edit.
  extraState = { get: () => null, set: () => {} };

  snapshot(extra) {
    return { walls: JSON.stringify(this.list), extraValue: this.extraState.get(), extra };
  }
  checkpoint({ extra = false } = {}) {
    this.undoStack.push(this.snapshot(extra));
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack.length = 0;
  }
  dropCheckpoint() { this.undoStack.pop(); }
  restore(step) {
    this.list = JSON.parse(step.walls);
    if (step.extra) this.extraState.set(step.extraValue);
    this.sync();
  }
  undo() {
    if (!this.undoStack.length) return false;
    const step = this.undoStack.pop();
    this.redoStack.push(this.snapshot(step.extra));
    this.restore(step);
    return true;
  }
  redo() {
    if (!this.redoStack.length) return false;
    const step = this.redoStack.pop();
    this.undoStack.push(this.snapshot(step.extra));
    this.restore(step);
    return true;
  }

  // --- edits ---
  nextId() { return this.list.reduce((m, w) => Math.max(m, w.id), 0) + 1; }

  addMany(segments, { thickness, height, color = DEFAULT_WALL_COLOR }) {
    this.checkpoint();
    for (const [a, b] of segments) {
      this.list.push({ id: this.nextId(), a: { x: a.x, z: a.z }, b: { x: b.x, z: b.z }, thickness, height, color });
    }
    this.sync();
  }
  add(a, b, opts) { this.addMany([[a, b]], opts); }

  update(id, patch) {
    const w = this.list.find((w) => w.id === id);
    if (!w) return;
    this.checkpoint();
    Object.assign(w, patch);
    this.sync();
  }

  remove(id) {
    this.checkpoint();
    this.list = this.list.filter((w) => w.id !== id);
    this.sync();
  }

  /** Remove every wall; with `extra`, the step also records other scene objects (see clearScene in main). */
  clear({ extra = false } = {}) {
    this.checkpoint({ extra });
    this.list = [];
    this.sync();
  }

  /** Start over with walls loaded from a file: fresh undo history. Invalid entries are dropped. */
  replaceAll(raw) {
    const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);
    const pt = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.z) && { x: p.x, z: p.z };
    const list = [];
    for (const w of Array.isArray(raw) ? raw : []) {
      const a = pt(w?.a), b = pt(w?.b);
      if (!a || !b) continue;
      list.push({
        id: list.length + 1,
        a, b,
        thickness: Math.max(0.01, num(w.thickness, 0.15)),
        height: Math.max(0.01, num(w.height, 2.7)),
        color: typeof w.color === 'string' && /^#[0-9a-f]{6}$/i.test(w.color) ? w.color : DEFAULT_WALL_COLOR,
      });
    }
    this.undoStack = [];
    this.redoStack = [];
    this.list = list;
    this.selectedId = null;
    this.sync();
    return list.length;
  }

  pruneDegenerate() { this.list = this.list.filter((w) => wallLength(w) > 0.01); }

  select(id) {
    this.selectedId = id;
    this.sync(false);
  }

  // Rebuild meshes from the data list, persist, and notify listeners.
  sync(save = true) {
    if (this.selectedId != null && !this.selected) this.selectedId = null;
    const seen = new Set();
    for (const w of this.list) {
      let mesh = this.meshes.get(w.id);
      if (!mesh) {
        mesh = new THREE.Mesh();
        mesh.castShadow = mesh.receiveShadow = true;
        mesh.userData.id = w.id;
        this.group.add(mesh);
        this.meshes.set(w.id, mesh);
      }
      // Joints depend on neighbours, so every wall's geometry is rebuilt (cheap at room scale).
      disposeWallMesh(mesh);
      mesh.visible = wallLength(w) > 1e-6; // can be momentarily zero while dragging
      mesh.geometry = mesh.visible ? buildWallGeometry(w, this.list) : new THREE.BufferGeometry();
      mesh.material = wallMaterial(w.color ?? DEFAULT_WALL_COLOR);
      if (w.id === this.selectedId && mesh.visible) {
        const outline = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), outlineMat);
        outline.renderOrder = 5;
        outline.raycast = () => {}; // never pickable
        mesh.add(outline);
      }
      seen.add(w.id);
    }
    for (const [id, mesh] of this.meshes) {
      if (!seen.has(id)) {
        disposeWallMesh(mesh);
        this.group.remove(mesh);
        this.meshes.delete(id);
      }
    }
    if (save) this.save();
    this.listeners.forEach((fn) => fn());
  }

  save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.list)); } catch { /* ignore */ }
  }
  load() {
    try {
      const data = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
      if (Array.isArray(data)) this.list = data;
    } catch { this.list = []; }
  }
}
