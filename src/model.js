import * as THREE from 'three';

/*
 * The scene model: shapes and lines.
 *
 * Shape  = a flat profile in the XZ plane, lifted to `base` and extruded up by `height`.
 *          height 0 = a flat face (just drawn, not pushed/pulled yet).
 *   { id, kind: 'poly', points: [{x,z}…] (counter-clockwise, area > 0), base, height, color }
 *   { id, kind: 'circle', center: {x,z}, radius, base, height, color }
 * Line   = an open chain of edges (Line tool without closing the loop).
 *   { id, kind: 'line', points: [{x,y,z}…] }
 *
 * Faces of a shape (for picking and push/pull):
 *   { type: 'top' } · { type: 'bottom' } · { type: 'side', i } (edge i → i+1 of the profile)
 */

const STORAGE_KEY = 'interior-design.model.v1';
const LEGACY_WALLS_KEY = 'interior-design.walls.v1';
export const DEFAULT_COLOR = '#ffffff';
export const CIRCLE_SEGMENTS = 48;
const MIN_SIZE = 0.01;
// Flat faces sit slightly above their plane, so the ground grid / a top face below never shows through
// (faces are also pushed back a little in depth so edge lines draw cleanly on top of them).
const FLAT_LIFT = 0.01;

// --- profile helpers ---------------------------------------------------------

/** Signed area in XZ (positive = the orientation we store). */
export function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.z - q.x * p.z;
  }
  return a / 2;
}

/** Copy of `pts` in the stored orientation (area > 0), without repeated points. */
export function normalizeProfile(pts) {
  const out = [];
  for (const p of pts) {
    const prev = out.at(-1);
    if (!prev || Math.hypot(p.x - prev.x, p.z - prev.z) > 1e-6) out.push({ x: p.x, z: p.z });
  }
  if (out.length > 1 && Math.hypot(out[0].x - out.at(-1).x, out[0].z - out.at(-1).z) < 1e-6) out.pop();
  return signedArea(out) < 0 ? out.reverse() : out;
}

export function profileOf(s) {
  if (s.kind === 'circle') {
    const pts = [];
    for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
      const a = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
      pts.push({ x: s.center.x + Math.cos(a) * s.radius, z: s.center.z + Math.sin(a) * s.radius });
    }
    return normalizeProfile(pts);
  }
  return s.points;
}

/** Outward normal (XZ, unit) of profile edge i → i+1. */
export function edgeNormal(pts, i) {
  const p = pts[i], q = pts[(i + 1) % pts.length];
  const dx = q.x - p.x, dz = q.z - p.z;
  const l = Math.hypot(dx, dz) || 1;
  return { x: dz / l, z: -dx / l };
}

// --- push / pull ---------------------------------------------------------------

/**
 * `orig` with `face` moved `d` metres along its outward normal.
 * Returns null if the result would be degenerate.
 */
export function pushPull(orig, face, d) {
  const s = structuredClone(orig);
  if (face.type === 'top') {
    if (orig.height < 1e-6) {
      // Flat face: pulling up extrudes up, pushing down extrudes down.
      if (Math.abs(d) < MIN_SIZE) return { ...s, height: 0 };
      if (d > 0) s.height = d;
      else { s.base = orig.base + d; s.height = -d; }
    } else {
      s.height = orig.height + d;
      if (s.height < MIN_SIZE) return null;
    }
    return s;
  }
  if (face.type === 'bottom') {
    s.base = orig.base - d;
    s.height = orig.height + d;
    return s.height < MIN_SIZE ? null : s;
  }
  // side
  if (orig.kind === 'circle') {
    s.radius = orig.radius + d;
    return s.radius < MIN_SIZE ? null : s;
  }
  const P = orig.points;
  const n = P.length;
  const i = face.i, j = (i + 1) % n;
  const nrm = edgeNormal(P, i);
  // Each end of the moved edge slides along its neighbouring edge (keeps neighbours' directions).
  const slide = (k, from) => {
    const ux = P[k].x - P[from].x, uz = P[k].z - P[from].z;
    const ul = Math.hypot(ux, uz) || 1;
    const dot = (ux / ul) * nrm.x + (uz / ul) * nrm.z;
    if (Math.abs(dot) < 0.05) return { x: P[k].x + nrm.x * d, z: P[k].z + nrm.z * d };
    const t = d / dot;
    return { x: P[k].x + (ux / ul) * t, z: P[k].z + (uz / ul) * t };
  };
  s.points = P.map((p) => ({ ...p }));
  s.points[i] = slide(i, (i - 1 + n) % n);
  s.points[j] = slide(j, (j + 1) % n);
  // Reject flips / collapses.
  if (signedArea(s.points) < 1e-4) return null;
  for (let k = 0; k < n; k++) {
    const p = s.points[k], q = s.points[(k + 1) % n];
    if (Math.hypot(q.x - p.x, q.z - p.z) < MIN_SIZE) return null;
  }
  return s;
}

// --- geometry ---------------------------------------------------------------------

/**
 * Non-indexed geometry for a shape, plus `faceIds[triangle]` so a raycast hit
 * can tell which face (top / bottom / side i) it landed on.
 */
function buildShapeGeometry(s) {
  const P = profileOf(s);
  const pos = [];
  const nor = [];
  const faceIds = [];
  // `vn` (optional): per-vertex normals for smooth shading (round sides of circles).
  const tri = (a, b, c, n, face, vn) => {
    // Fix winding so the triangle faces along n.
    const ab = new THREE.Vector3().subVectors(b, a);
    const ac = new THREE.Vector3().subVectors(c, a);
    let normals = vn ?? [n, n, n];
    if (ab.cross(ac).dot(n) < 0) { [b, c] = [c, b]; normals = [normals[0], normals[2], normals[1]]; }
    [a, b, c].forEach((v, k) => { pos.push(v.x, v.y, v.z); nor.push(normals[k].x, normals[k].y, normals[k].z); });
    faceIds.push(face);
  };
  const contour = P.map((p) => new THREE.Vector2(p.x, p.z));
  const caps = THREE.ShapeUtils.triangulateShape(contour, []);
  const flat = s.height < 1e-6;
  const y0 = s.base + (flat ? FLAT_LIFT : 0);
  const y1 = s.base + s.height;
  const up = new THREE.Vector3(0, 1, 0);
  const down = new THREE.Vector3(0, -1, 0);
  const v = (p, y) => new THREE.Vector3(p.x, y, p.z);

  for (const [a, b, c] of caps) tri(v(P[a], flat ? y0 : y1), v(P[b], flat ? y0 : y1), v(P[c], flat ? y0 : y1), up, { type: 'top' });
  if (!flat) {
    for (const [a, b, c] of caps) tri(v(P[a], y0), v(P[b], y0), v(P[c], y0), down, { type: 'bottom' });
    for (let i = 0; i < P.length; i++) {
      const p = P[i], q = P[(i + 1) % P.length];
      const en = edgeNormal(P, i);
      const n = new THREE.Vector3(en.x, 0, en.z);
      const face = { type: 'side', i };
      if (s.kind === 'circle') {
        // Round side: radial normals per vertex, so it shades smoothly instead of in facets.
        const rp = new THREE.Vector3(p.x - s.center.x, 0, p.z - s.center.z).normalize();
        const rq = new THREE.Vector3(q.x - s.center.x, 0, q.z - s.center.z).normalize();
        tri(v(p, y0), v(q, y0), v(q, y1), n, face, [rp, rq, rq]);
        tri(v(p, y0), v(q, y1), v(p, y1), n, face, [rp, rq, rp]);
      } else {
        tri(v(p, y0), v(q, y0), v(q, y1), n, face);
        tri(v(p, y0), v(q, y1), v(p, y1), n, face);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return { geometry: g, faceIds };
}

/** Corner points (world) of one face, in order: for highlighting it. */
export function facePolygon(s, face) {
  const P = profileOf(s);
  const y0 = s.base, y1 = s.base + s.height;
  if (face.type === 'top') return P.map((p) => new THREE.Vector3(p.x, s.height < 1e-6 ? y0 + FLAT_LIFT : y1, p.z));
  if (face.type === 'bottom') return P.map((p) => new THREE.Vector3(p.x, y0, p.z));
  if (s.kind === 'circle') {
    // A circle's side is one round face: highlight its top and bottom rims.
    return null;
  }
  const p = P[face.i], q = P[(face.i + 1) % P.length];
  return [new THREE.Vector3(p.x, y0, p.z), new THREE.Vector3(q.x, y0, q.z), new THREE.Vector3(q.x, y1, q.z), new THREE.Vector3(p.x, y1, p.z)];
}

/** Outward normal (world) of a face. */
export function faceNormal(s, face) {
  if (face.type === 'top') return new THREE.Vector3(0, 1, 0);
  if (face.type === 'bottom') return new THREE.Vector3(0, -1, 0);
  const n = edgeNormal(profileOf(s), face.i);
  return new THREE.Vector3(n.x, 0, n.z);
}

// --- materials --------------------------------------------------------------------

const materials = new Map();
function shapeMaterial(color, flat) {
  const key = `${color}|${flat}`;
  let m = materials.get(key);
  if (!m) {
    // Solids are pushed back slightly in depth so edge lines on their borders win cleanly.
    // Flat faces aren't: on a face seen at a shallow angle that offset grows large enough
    // to let the ground grid show through.
    m = new THREE.MeshStandardMaterial({
      color, roughness: 0.9,
      side: flat ? THREE.DoubleSide : THREE.FrontSide,
      polygonOffset: !flat, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    });
    materials.set(key, m);
  }
  return m;
}

const outlineMat = new THREE.LineBasicMaterial({ color: 0x2a6df4, depthTest: false, transparent: true, opacity: 0.9 });
// Thin dark lines along every edge, so faces that shade alike stay distinguishable.
const edgeMat = new THREE.LineBasicMaterial({ color: 0x2b2d31, transparent: true, opacity: 0.35, depthWrite: false });
// Open lines (Line tool, not closed): always clearly visible.
const lineMat = new THREE.LineBasicMaterial({ color: 0x2b2d31 });
const lineSelMat = new THREE.LineBasicMaterial({ color: 0x2a6df4, depthTest: false, transparent: true });

/** Edge line style (from the Rendering settings). */
export function setEdgeLines({ visible, opacity }) {
  edgeMat.opacity = opacity;
  edgeMat.visible = visible && opacity > 0;
}

function disposeObject(obj) {
  obj.geometry?.dispose();
  for (const child of [...obj.children]) {
    child.geometry?.dispose();
    obj.remove(child);
  }
}

// --- validation / legacy ---------------------------------------------------------------

const isNum = Number.isFinite;
const isColor = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);

function cleanShape(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const base = isNum(raw.base) ? raw.base : 0;
  const height = isNum(raw.height) && raw.height > 0 ? raw.height : 0;
  const color = isColor(raw.color) ? raw.color : DEFAULT_COLOR;
  if (raw.kind === 'circle') {
    const c = raw.center;
    if (!c || !isNum(c.x) || !isNum(c.z) || !isNum(raw.radius) || raw.radius < MIN_SIZE) return null;
    return { kind: 'circle', center: { x: c.x, z: c.z }, radius: raw.radius, base, height, color };
  }
  if (raw.kind === 'poly' && Array.isArray(raw.points)) {
    const pts = normalizeProfile(raw.points.filter((p) => p && isNum(p.x) && isNum(p.z)));
    if (pts.length < 3 || signedArea(pts) < 1e-6) return null;
    return { kind: 'poly', points: pts, base, height, color };
  }
  return null;
}

function cleanLine(raw) {
  if (!raw || !Array.isArray(raw.points)) return null;
  const pts = raw.points.filter((p) => p && isNum(p.x) && isNum(p.y) && isNum(p.z)).map(({ x, y, z }) => ({ x, y, z }));
  return pts.length >= 2 ? { kind: 'line', points: pts } : null;
}

/**
 * Walls from older files / sessions → extruded shapes (mitred like before).
 * A wall was { a:{x,z}, b:{x,z}, thickness, height, color }.
 */
export function wallsToShapes(walls) {
  const list = (Array.isArray(walls) ? walls : []).filter((w) => w?.a && w?.b && isNum(w.a.x) && isNum(w.a.z) && isNum(w.b.x) && isNum(w.b.z));
  const near = (p, q) => Math.abs(p.x - q.x) < 1e-4 && Math.abs(p.z - q.z) < 1e-4;
  const cross2 = (p, q) => p.x * q.z - p.z * q.x;
  const shapes = [];
  for (const w of list) {
    const len = Math.hypot(w.b.x - w.a.x, w.b.z - w.a.z);
    if (len < MIN_SIZE) continue;
    const t = isNum(w.thickness) && w.thickness > 0 ? w.thickness : 0.15;
    const h = t / 2;
    const u = { x: (w.b.x - w.a.x) / len, z: (w.b.z - w.a.z) / len };
    const n = { x: -u.z, z: u.x };
    const cut = (end) => {
      const P = w[end], Q = end === 'a' ? w.b : w.a;
      const e1 = { x: (Q.x - P.x) / len, z: (Q.z - P.z) / len };
      const others = [];
      for (const o of list) {
        if (o === w) continue;
        if (near(o.a, P)) others.push(o.b);
        else if (near(o.b, P)) others.push(o.a);
      }
      if (others.length === 0) return { e1, s: () => 0 };
      if (others.length > 1) return { e1, s: () => -h };
      const R = others[0];
      const ol = Math.hypot(R.x - P.x, R.z - P.z) || 1;
      const bis = { x: e1.x + (R.x - P.x) / ol, z: e1.z + (R.z - P.z) / ol };
      const bl = Math.hypot(bis.x, bis.z);
      if (bl < 1e-6) return { e1, s: () => 0 };
      bis.x /= bl; bis.z /= bl;
      return { e1, s: (off) => THREE.MathUtils.clamp(-off * cross2(n, bis) / cross2(e1, bis), -t * 3, Math.min(t * 3, len / 2)) };
    };
    const ca = cut('a'), cb = cut('b');
    const corner = (P, c, off) => {
      const s = c.s(off);
      return { x: P.x + n.x * off + c.e1.x * s, z: P.z + n.z * off + c.e1.z * s };
    };
    const shape = cleanShape({
      kind: 'poly',
      points: [corner(w.a, ca, h), corner(w.b, cb, h), corner(w.b, cb, -h), corner(w.a, ca, -h)],
      base: 0,
      height: isNum(w.height) && w.height > 0 ? w.height : 2.7,
      color: w.color,
    });
    if (shape) shapes.push(shape);
  }
  return shapes;
}

// --- the model -------------------------------------------------------------------------

export class Model {
  constructor(scene) {
    this.group = new THREE.Group(); // shape meshes (pickable)
    this.lineGroup = new THREE.Group(); // open lines
    scene.add(this.group, this.lineGroup);
    this.shapes = [];
    this.lines = [];
    this.objects = new Map(); // id → mesh / line object
    this.selectedId = null;
    this.undoStack = [];
    this.redoStack = [];
    this.listeners = new Set();
    this.load();
    this.sync(false);
  }

  onChange(fn) { this.listeners.add(fn); }

  get all() { return [...this.shapes, ...this.lines]; }
  get count() { return this.shapes.length + this.lines.length; }
  get selected() { return this.all.find((o) => o.id === this.selectedId) ?? null; }
  byId(id) { return this.all.find((o) => o.id === id) ?? null; }

  nextId() { return this.all.reduce((m, o) => Math.max(m, o.id), 0) + 1; }

  // --- history ---
  // Each step stores shapes + lines plus, via `extraState`, the person. Extra state is
  // only restored for steps that changed it (`{ extra: true }`).
  extraState = { get: () => null, set: () => {} };

  snapshot(extra) {
    return { data: JSON.stringify({ shapes: this.shapes, lines: this.lines }), extraValue: this.extraState.get(), extra };
  }
  checkpoint({ extra = false } = {}) {
    this.undoStack.push(this.snapshot(extra));
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack.length = 0;
  }
  dropCheckpoint() { this.undoStack.pop(); }
  restore(step) {
    const { shapes, lines } = JSON.parse(step.data);
    this.shapes = shapes;
    this.lines = lines;
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
  /** Add a shape (one undo step). Returns its id, or null if invalid. */
  addShape(raw) {
    const s = cleanShape(raw);
    if (!s) return null;
    this.checkpoint();
    s.id = this.nextId();
    this.shapes.push(s);
    this.sync();
    return s.id;
  }

  addLine(points) {
    const l = cleanLine({ points });
    if (!l) return null;
    this.checkpoint();
    l.id = this.nextId();
    this.lines.push(l);
    this.sync();
    return l.id;
  }

  /** Replace a shape's data without a history step (live editing; call sync yourself). */
  setShape(id, data) {
    const i = this.shapes.findIndex((s) => s.id === id);
    if (i >= 0) this.shapes[i] = { ...data, id };
  }

  update(id, patch) {
    const s = this.shapes.find((o) => o.id === id);
    if (!s) return;
    const next = cleanShape({ ...s, ...patch });
    if (!next) return;
    this.checkpoint();
    this.setShape(id, next);
    this.sync();
  }

  remove(id) {
    this.checkpoint();
    this.shapes = this.shapes.filter((o) => o.id !== id);
    this.lines = this.lines.filter((o) => o.id !== id);
    this.sync();
  }

  /** Remove everything; with `extra`, the step also records the person (see clearScene in main). */
  clear({ extra = false } = {}) {
    this.checkpoint({ extra });
    this.shapes = [];
    this.lines = [];
    this.sync();
  }

  /**
   * Start over with data from a file (fresh undo history). Accepts
   * { shapes, lines } and, from older files, { walls }. Returns the object count.
   */
  replaceAll(data) {
    const shapes = [
      ...(Array.isArray(data?.shapes) ? data.shapes.map(cleanShape).filter(Boolean) : []),
      ...wallsToShapes(data?.walls),
    ];
    const lines = Array.isArray(data?.lines) ? data.lines.map(cleanLine).filter(Boolean) : [];
    let id = 1;
    for (const o of [...shapes, ...lines]) o.id = id++;
    this.undoStack = [];
    this.redoStack = [];
    this.shapes = shapes;
    this.lines = lines;
    this.selectedId = null;
    this.sync();
    return this.count;
  }

  /** Plain data for saving. */
  toData() {
    const strip = ({ id, ...rest }) => rest;
    return { shapes: this.shapes.map(strip), lines: this.lines.map(strip) };
  }

  select(id) {
    this.selectedId = id;
    this.sync(false);
  }

  // --- queries ---
  /** Points to snap to on the horizontal plane at height y. */
  verticesAt(y) {
    const out = [];
    for (const s of this.shapes) {
      const levels = [s.base, s.base + s.height];
      for (const level of levels) {
        if (Math.abs(level - y) > 1e-3) continue;
        if (s.kind === 'circle') out.push({ x: s.center.x, z: s.center.z });
        for (const p of profileOf(s)) out.push(p);
      }
    }
    for (const l of this.lines) for (const p of l.points) if (Math.abs(p.y - y) < 1e-3) out.push(p);
    return out;
  }

  /** Raycast shapes: { shape, face, point } or null. */
  pick(raycaster) {
    const hit = raycaster.intersectObjects(this.group.children, false)[0];
    if (!hit) return null;
    const shape = this.byId(hit.object.userData.id);
    const face = hit.object.userData.faceIds?.[hit.faceIndex];
    return shape && face ? { shape, face, point: hit.point } : null;
  }

  /** Raycast open lines: the line or null. */
  pickLine(raycaster) {
    raycaster.params.Line.threshold = 0.08;
    const hit = raycaster.intersectObjects(this.lineGroup.children, false)[0];
    return hit ? this.byId(hit.object.userData.id) : null;
  }

  /** Does a person of `radius` at (x, z) collide with a shape that stands in their way? */
  blocks(x, z, radius, eyeHeight) {
    for (const s of this.shapes) {
      if (s.height < 0.05 || s.base > eyeHeight || s.base + s.height < 0.2) continue;
      if (s.kind === 'circle') {
        if (Math.hypot(x - s.center.x, z - s.center.z) < s.radius + radius) return true;
        continue;
      }
      const P = s.points;
      let inside = false;
      for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
        const a = P[i], b = P[j];
        if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
        const dx = b.x - a.x, dz = b.z - a.z;
        const t = THREE.MathUtils.clamp(((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1), 0, 1);
        if (Math.hypot(x - (a.x + t * dx), z - (a.z + t * dz)) < radius) return true;
      }
      if (inside) return true;
    }
    return false;
  }

  // --- rendering ---
  /** Rebuild scene objects from the data, persist, and notify listeners. */
  sync(save = true) {
    if (this.selectedId != null && !this.selected) this.selectedId = null;
    for (const obj of this.objects.values()) {
      disposeObject(obj);
      obj.parent?.remove(obj);
    }
    this.objects.clear();

    for (const s of this.shapes) {
      const { geometry, faceIds } = buildShapeGeometry(s);
      const flat = s.height < 1e-6;
      const mesh = new THREE.Mesh(geometry, shapeMaterial(s.color ?? DEFAULT_COLOR, flat));
      mesh.castShadow = !flat;
      mesh.receiveShadow = true;
      mesh.userData = { id: s.id, faceIds };
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 20), edgeMat);
      edges.raycast = () => {};
      mesh.add(edges);
      if (s.id === this.selectedId) {
        const outline = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 20), outlineMat);
        outline.renderOrder = 5;
        outline.raycast = () => {};
        mesh.add(outline);
      }
      this.group.add(mesh);
      this.objects.set(s.id, mesh);
    }

    for (const l of this.lines) {
      const g = new THREE.BufferGeometry().setFromPoints(l.points.map((p) => new THREE.Vector3(p.x, p.y + FLAT_LIFT, p.z)));
      const line = new THREE.Line(g, l.id === this.selectedId ? lineSelMat : lineMat);
      line.userData = { id: l.id };
      if (l.id === this.selectedId) line.renderOrder = 5;
      this.lineGroup.add(line);
      this.objects.set(l.id, line);
    }

    if (save) this.save();
    this.listeners.forEach((fn) => fn());
  }

  save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.toData())); } catch { /* ignore */ }
  }

  load() {
    let data = null;
    try { data = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'); } catch { /* ignore */ }
    if (!data) {
      // First run after the redesign: bring over the walls from the old version.
      try {
        const walls = JSON.parse(localStorage.getItem(LEGACY_WALLS_KEY) ?? 'null');
        if (Array.isArray(walls)) data = { walls };
      } catch { /* ignore */ }
    }
    const shapes = [
      ...(Array.isArray(data?.shapes) ? data.shapes.map(cleanShape).filter(Boolean) : []),
      ...wallsToShapes(data?.walls),
    ];
    const lines = Array.isArray(data?.lines) ? data.lines.map(cleanLine).filter(Boolean) : [];
    let id = 1;
    for (const o of [...shapes, ...lines]) o.id = id++;
    this.shapes = shapes;
    this.lines = lines;
  }
}
