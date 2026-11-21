import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { Mesh, shapesToMesh } from './mesh.js';

/*
 * The scene model: edges and faces (see mesh.js), with undo history, rendering,
 * picking and the selection.
 *
 * Selection = a set of keys: 'f<id>' (face) and 'e<id>' (edge).
 */

const STORAGE_KEY = 'interior-design.model.v2';
const LEGACY_SHAPES_KEY = 'interior-design.model.v1';
const LEGACY_WALLS_KEY = 'interior-design.walls.v1';
export const DEFAULT_COLOR = '#ffffff';
export const CIRCLE_SEGMENTS = 48;
const onGround = (p) => Math.abs(p.y) < 1e-4;

// --- older formats: shapes (v3) and walls (v1/v2) ----------------------------------------

const isNum = Number.isFinite;

function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.z - q.x * p.z;
  }
  return a / 2;
}

function normalizeProfile(pts) {
  const out = [];
  for (const p of pts) {
    const prev = out.at(-1);
    if (!prev || Math.hypot(p.x - prev.x, p.z - prev.z) > 1e-6) out.push({ x: p.x, z: p.z });
  }
  if (out.length > 1 && Math.hypot(out[0].x - out.at(-1).x, out[0].z - out.at(-1).z) < 1e-6) out.pop();
  return signedArea(out) < 0 ? out.reverse() : out;
}

function profileOf(s) {
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

function cleanShape(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const base = isNum(raw.base) ? raw.base : 0;
  const height = isNum(raw.height) && raw.height > 0 ? raw.height : 0;
  const color = typeof raw.color === 'string' && /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : DEFAULT_COLOR;
  if (raw.kind === 'circle') {
    const c = raw.center;
    if (!c || !isNum(c.x) || !isNum(c.z) || !isNum(raw.radius) || raw.radius < 0.01) return null;
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
  return pts.length >= 2 ? { points: pts } : null;
}

/**
 * Walls from older files / sessions → extruded shapes (mitred like before).
 * A wall was { a:{x,z}, b:{x,z}, thickness, height, color }.
 */
function wallsToShapes(walls) {
  const list = (Array.isArray(walls) ? walls : []).filter((w) => w?.a && w?.b && isNum(w.a.x) && isNum(w.a.z) && isNum(w.b.x) && isNum(w.b.z));
  const near = (p, q) => Math.abs(p.x - q.x) < 1e-4 && Math.abs(p.z - q.z) < 1e-4;
  const cross2 = (p, q) => p.x * q.z - p.z * q.x;
  const shapes = [];
  for (const w of list) {
    const len = Math.hypot(w.b.x - w.a.x, w.b.z - w.a.z);
    if (len < 0.01) continue;
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

/** A mesh from any saved form: { geometry } (now), { shapes, lines } (v3), { walls } (v1/v2). */
function meshFromData(data) {
  if (data?.geometry) return Mesh.fromData(data.geometry);
  const shapes = [
    ...(Array.isArray(data?.shapes) ? data.shapes.map(cleanShape).filter(Boolean) : []),
    ...wallsToShapes(data?.walls),
  ];
  const lines = Array.isArray(data?.lines) ? data.lines.map(cleanLine).filter(Boolean) : [];
  return shapesToMesh(shapes, lines, profileOf);
}

// --- materials ---------------------------------------------------------------------------

const faceMat = new THREE.MeshStandardMaterial({
  vertexColors: true, roughness: 0.9, side: THREE.DoubleSide,
  // Pushed back slightly in depth so edge lines on their borders win cleanly.
  polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
});
// Faces lying on the ground: no offset (pushed back, the grid would show through them at
// shallow angles). They're drawn exactly at ground level; the grid itself is pushed back.
const groundFaceMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide });

// Back faces can show in their own colour (so a face turned the wrong way stands out), and
// selected faces are tinted in the shader (on both sides). Shared by both face materials.
const faceUniforms = {
  uBackOn: { value: 1 },
  uBackColor: { value: new THREE.Color('#a9b6c8') },
  uSelectTint: { value: new THREE.Color(0x2a6df4) },
  // Selection dots: pattern cell size in device pixels (scaled for high-DPI screens).
  uDotScale: { value: Math.max(1, Math.round(Math.min(window.devicePixelRatio || 1, 2))) },
  uStyle: { value: 0 }, // face style, see FACE_STYLES
};

// Face styles (SketchUp-like): shaded, monochrome (one neutral colour), hidden line (flat white,
// no shading), x-ray (see-through), wireframe (edges only).
export const FACE_STYLES = ['shaded', 'mono', 'hidden', 'xray', 'wire'];
let faceStyle = 'shaded';
for (const mat of [faceMat, groundFaceMat]) {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, faceUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aSelected;\nvarying float vSelected;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSelected = aSelected;')
      // Shadow normal bias along the side we look at (faces are two-sided; seen from the
      // back, the stored normal points away and the bias would cause shadow acne).
      .replace('#include <shadowmap_vertex>', [
        'if (dot(transformedNormal, isOrthographic ? vec3(0.0, 0.0, 1.0) : -mvPosition.xyz) < 0.0) transformedNormal = -transformedNormal;',
        '#include <shadowmap_vertex>',
      ].join('\n'));
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', [
        '#include <common>',
        'uniform float uBackOn;',
        'uniform vec3 uBackColor;',
        'uniform vec3 uSelectTint;',
        'uniform float uDotScale;',
        'uniform float uStyle;',
        'varying float vSelected;',
        // Selected (SketchUp-like): a light blue wash plus a fine pattern of blue dots.
        'vec3 markSelected(vec3 c) {',
        '  if (vSelected < 0.5) return c;',
        '  vec2 cell = mod(floor(gl_FragCoord.xy / uDotScale), 4.0);',
        '  float dotOn = (cell.x == 0.0 && cell.y == 0.0) || (cell.x == 2.0 && cell.y == 2.0) ? 1.0 : 0.0;',
        '  c = mix(c, vec3(0.55, 0.7, 1.0), 0.18);',
        '  return mix(c, uSelectTint * 0.6, dotOn * 0.9);',
        '}',
        // Back faces in their own colour (if on); monochrome: one neutral colour for all fronts.
        'vec3 faceColor(vec3 c) {',
        '  if (uBackOn > 0.5 && !gl_FrontFacing) return uBackColor;',
        '  return abs(uStyle - 1.0) < 0.5 ? vec3(0.86) : c;',
        '}',
      ].join('\n'))
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = markSelected(faceColor(diffuseColor.rgb));')
      // Hidden line: flat white (or the back colour), no shading or shadows.
      .replace('#include <opaque_fragment>', [
        '#include <opaque_fragment>',
        'if (abs(uStyle - 2.0) < 0.5) gl_FragColor.rgb = markSelected(faceColor(vec3(1.0)));',
      ].join('\n'));
  };
}

/** Face style (from the Rendering settings): one of FACE_STYLES. */
export function setFaceStyle(style) {
  faceStyle = FACE_STYLES.includes(style) ? style : 'shaded';
  faceUniforms.uStyle.value = FACE_STYLES.indexOf(faceStyle);
  const xray = faceStyle === 'xray';
  for (const m of [faceMat, groundFaceMat]) {
    if (m.transparent !== xray) { m.transparent = xray; m.depthWrite = !xray; m.needsUpdate = true; }
    m.opacity = xray ? 0.45 : 1;
    m.visible = faceStyle !== 'wire';
  }
}

/** Back face colouring (from the Rendering settings). */
export function setBackFaces({ visible, color }) {
  faceUniforms.uBackOn.value = visible ? 1 : 0;
  faceUniforms.uBackColor.value.set(color);
}
// Thin dark lines along every edge, so faces that shade alike stay distinguishable.
const edgeMat = new THREE.LineBasicMaterial({ color: 0x2b2d31, transparent: true, opacity: 0.35, depthWrite: false });
// Edges without faces (lines): always clearly visible.
const lineMat = new THREE.LineBasicMaterial({ color: 0x2b2d31 });
// Selected edges: thick (plain WebGL lines are always 1 px), drawn over the normal edge line.
const selEdgeMat = new LineMaterial({ color: 0x2a6df4, linewidth: 3.5, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });

/** Edge line style (from the Rendering settings). */
export function setEdgeLines({ visible, opacity }) {
  edgeMat.opacity = opacity;
  edgeMat.visible = visible && opacity > 0;
}

// --- the model -----------------------------------------------------------------------------

export class Model {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);
    this.mesh = new Mesh();
    this.selection = new Set();
    this.undoStack = [];
    this.redoStack = [];
    this.listeners = new Set();
    this.load();
    this.sync(false);
  }

  onChange(fn) { this.listeners.add(fn); }

  /** Separate pieces (groups of connected edges and faces): "objects" for messages. */
  get count() {
    const parent = new Map();
    const find = (v) => { while (parent.get(v) !== v) v = parent.get(v); return v; };
    for (const v of this.mesh.vertices.keys()) parent.set(v, v);
    for (const e of this.mesh.edges.values()) parent.set(find(e.a), find(e.b));
    let n = 0;
    for (const v of this.mesh.vertices.keys()) if (find(v) === v) n++;
    return n;
  }

  get isEmpty() { return this.mesh.edges.size === 0; }

  // --- history ---
  // Each step stores the geometry plus, via `extraState`, the person. Extra state is
  // only restored for steps that changed it (`{ extra: true }`).
  extraState = { get: () => null, set: () => {} };

  snapshot(extra) {
    return { data: JSON.stringify(this.mesh.toData()), extraValue: this.extraState.get(), extra };
  }
  checkpoint({ extra = false } = {}) {
    this.undoStack.push(this.snapshot(extra));
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack.length = 0;
  }
  dropCheckpoint() { this.undoStack.pop(); }
  restore(step) {
    this.mesh = Mesh.fromData(JSON.parse(step.data));
    this.selection.clear();
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

  /** Change the geometry as one undo step: `fn(mesh)`; returns its result. */
  edit(fn) {
    this.checkpoint();
    const result = fn(this.mesh);
    this.sync();
    return result;
  }

  /** Remove everything; with `extra`, the step also records the person (see clearScene in main). */
  clear({ extra = false } = {}) {
    this.checkpoint({ extra });
    this.mesh = new Mesh();
    this.selection.clear();
    this.sync();
  }

  /** Start over with data from a file (fresh undo history). Returns the object count. */
  replaceAll(data) {
    this.mesh = meshFromData(data);
    this.undoStack = [];
    this.redoStack = [];
    this.selection.clear();
    this.sync();
    return this.count;
  }

  /** Plain data for saving. */
  toData() { return { geometry: this.mesh.toData() }; }

  // --- selection ---
  get selectedFaces() { return [...this.selection].filter((k) => k[0] === 'f').map((k) => +k.slice(1)); }
  get selectedEdges() { return [...this.selection].filter((k) => k[0] === 'e').map((k) => +k.slice(1)); }

  /** mode: 'replace' | 'add' | 'toggle' */
  select(keys, mode = 'replace') {
    if (mode === 'replace') this.selection = new Set(keys);
    else if (mode === 'add') keys.forEach((k) => this.selection.add(k));
    else {
      const all = keys.every((k) => this.selection.has(k));
      keys.forEach((k) => (all ? this.selection.delete(k) : this.selection.add(k)));
    }
    this.sync(false);
  }

  selectAll() {
    this.select([...[...this.mesh.faces.keys()].map((f) => `f${f}`), ...[...this.mesh.edges.keys()].map((e) => `e${e}`)]);
  }

  deleteSelection() {
    if (!this.selection.size) return;
    const faces = this.selectedFaces, edges = this.selectedEdges;
    this.selection.clear();
    this.edit((m) => m.erase(faces, edges));
  }

  /** Live colour preview for the selected faces (no history; see commitColor). */
  previewColor(color) {
    this.colorsBefore ??= new Map(this.selectedFaces.map((f) => [f, this.mesh.faces.get(f)?.color]));
    for (const f of this.selectedFaces) { const face = this.mesh.faces.get(f); if (face) face.color = color; }
    this.sync(false);
  }

  /** Would filling the selected edges make a face? (A closed loop in one plane, not filled yet.) */
  canMakeFace() {
    const edges = this.selectedEdges;
    if (edges.length < 3 || edges.length > 2000 || !this.mesh.faceableGroups(edges).length) return false;
    // Try it on a copy (ids survive: fromData keeps their order).
    const ids = [...this.mesh.edges.keys()];
    const copy = Mesh.fromData(this.mesh.toData());
    const copyIds = [...copy.edges.keys()];
    return copy.makeFaces(edges.map((e) => copyIds[ids.indexOf(e)])).length > 0;
  }

  /**
   * Fill the closed loops among the selected edges with faces (one undo step); the new faces
   * end up selected. Returns how many were made.
   */
  makeFaces({ color, towards }) {
    const edges = this.selectedEdges;
    this.checkpoint();
    const made = this.mesh.makeFaces(edges, { color, towards });
    if (!made.length) { this.dropCheckpoint(); return 0; }
    this.selection = new Set(made.map((f) => `f${f}`));
    this.sync();
    return made.length;
  }

  /** Selection helpers on the current selection: 'loop' | 'ring' (edges), 'grow' | 'shrink'. */
  selectHelper(kind) {
    const m = this.mesh;
    const faces = this.selectedFaces, edges = this.selectedEdges;
    let out;
    if (kind === 'loop' || kind === 'ring') {
      out = { faces: new Set(faces), edges: new Set(edges) };
      for (const e of edges) (kind === 'loop' ? m.edgeLoop(e) : m.edgeRing(e)).forEach((x) => out.edges.add(x));
    } else {
      out = kind === 'grow' ? m.grow(faces, edges) : m.shrink(faces, edges);
    }
    this.select([...[...out.faces].map((f) => `f${f}`), ...[...out.edges].map((e) => `e${e}`)]);
  }

  /** Edges the Smooth slider works on: the selected edges and all edges of the selected faces. */
  smoothingEdges() {
    const out = new Set(this.selectedEdges);
    for (const f of this.selectedFaces) if (this.mesh.faces.has(f)) this.mesh.faceEdges(f).forEach((e) => out.add(e));
    return [...out].filter((e) => this.mesh.edgeAngle(e) != null);
  }

  /** The slider position that matches the selection now: just above its steepest smooth edge (0 = none). */
  smoothingAngle() {
    let max = -1;
    for (const e of this.smoothingEdges()) if (this.mesh.edges.get(e).soft) max = Math.max(max, this.mesh.edgeAngle(e));
    return max < 0 ? 0 : Math.min(90, Math.floor(max) + 1);
  }

  /** Live smoothing preview (no history; see commitSmoothing). */
  previewSmoothing(maxDeg) {
    const edges = this.smoothingEdges();
    this.softBefore ??= new Map(edges.map((e) => [e, !!this.mesh.edges.get(e).soft]));
    this.mesh.setSmoothing(edges, maxDeg);
    this.sync(false);
  }

  /** Smooth the selection's edges below `maxDeg` as one undo step. */
  commitSmoothing(maxDeg) {
    // Put the previewed state back first, so the undo step holds the old one.
    for (const [e, soft] of this.softBefore ?? []) { const edge = this.mesh.edges.get(e); if (edge) { if (soft) edge.soft = true; else delete edge.soft; } }
    this.softBefore = null;
    this.mesh.changed();
    const edges = this.smoothingEdges();
    this.edit((m) => m.setSmoothing(edges, maxDeg));
  }

  /** Turn the selected faces around (front ↔ back), one undo step. */
  reverseSelection() {
    const faces = this.selectedFaces;
    if (faces.length) this.edit((m) => m.reverseFaces(faces));
  }

  /** Set the colour of the selected faces as one undo step. */
  commitColor(color) {
    // Put the previewed colours back first, so the undo step holds the old ones.
    for (const [f, c] of this.colorsBefore ?? []) { const face = this.mesh.faces.get(f); if (face && c) face.color = c; }
    this.colorsBefore = null;
    this.edit((m) => { for (const f of this.selectedFaces) { const face = m.faces.get(f); if (face) face.color = color; } });
  }

  // --- queries ---
  boundingBox() {
    const box = new THREE.Box3();
    for (const v of this.mesh.vertices.values()) box.expandByPoint(v);
    return box;
  }

  /** Raycast faces: { face, point, normal } or null. */
  pickFace(raycaster) {
    if (faceStyle === 'wire') return null; // no faces to pick
    const hit = raycaster.intersectObjects(this.pickables, false)[0];
    if (!hit) return null;
    const face = hit.object.userData.faceIds?.[hit.faceIndex];
    if (face == null || !this.mesh.faces.has(face)) return null;
    return { face, point: hit.point, normal: this.mesh.faceNormal(face), distance: hit.distance };
  }

  /**
   * The edge nearest to the mouse on screen (within `px`), not hidden behind a face.
   * `ndc` = mouse in normalised device coords; `size` = viewport size in px;
   * `only` (optional) limits the search to some edges. Returns { edge, point, px } or null.
   */
  pickEdge(raycaster, camera, ndc, size, px = 6, only = null) {
    const toScreen = (p) => { const v = p.clone().project(camera); return { x: (v.x + 1) / 2 * size.x, y: (1 - v.y) / 2 * size.y, z: v.z }; };
    const mouse = { x: (ndc.x + 1) / 2 * size.x, y: (1 - ndc.y) / 2 * size.y };
    const near = [];
    for (const [id, e] of this.mesh.edges) {
      if (e.soft || (only && !only.has(id))) continue;
      const A = this.mesh.vertices.get(e.a), B = this.mesh.vertices.get(e.b);
      const a = toScreen(A), b = toScreen(B);
      if (a.z > 1 || b.z > 1 || a.z < -1 || b.z < -1) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const t = THREE.MathUtils.clamp(((mouse.x - a.x) * dx + (mouse.y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1);
      const d = Math.hypot(mouse.x - (a.x + t * dx), mouse.y - (a.y + t * dy));
      if (d < px) near.push({ edge: id, point: A.clone().lerp(B, t), px: d });
    }
    near.sort((p, q) => p.px - q.px);
    // The nearest one that isn't hidden behind a face: aim a ray straight at it.
    const ray = new THREE.Raycaster();
    for (const c of near) {
      const v = c.point.clone().project(camera);
      ray.setFromCamera(new THREE.Vector2(v.x, v.y), camera);
      const dist = c.point.clone().sub(ray.ray.origin).dot(ray.ray.direction);
      if (faceStyle === 'xray' || faceStyle === 'wire') return c; // faces hide nothing
      const hit = ray.intersectObjects(this.pickables, false)[0];
      if (!hit || hit.distance > dist - (0.02 + 0.005 * dist)) return c;
    }
    return null;
  }

  /** Does a person of `radius` at (x, z) bump into a wall-like face between knee and eye height? */
  blocks(x, z, radius, eyeHeight) {
    const m = this.mesh;
    const heights = [0.3, eyeHeight * 0.6, eyeHeight];
    for (const [id, f] of m.faces) {
      const n = m.faceNormal(id);
      if (Math.abs(n.y) > 0.95) continue; // floors / ceilings don't block
      const u = new THREE.Vector3(-n.z, 0, n.x).normalize();
      for (const h0 of heights) {
        const h = h0 + 1e-5;
        // Slice the face at height h: pairs of crossings = solid parts of the face.
        const cuts = [];
        for (const l of f.loops) {
          for (let i = 0; i < l.length; i++) {
            const p = m.vertices.get(l[i]), q = m.vertices.get(l[(i + 1) % l.length]);
            if ((p.y - h) * (q.y - h) >= 0) continue;
            const t = (h - p.y) / (q.y - p.y);
            cuts.push(new THREE.Vector3().lerpVectors(p, q, t));
          }
        }
        cuts.sort((a, b) => a.dot(u) - b.dot(u));
        for (let i = 0; i + 1 < cuts.length; i += 2) {
          const a = cuts[i], b = cuts[i + 1];
          const dx = b.x - a.x, dz = b.z - a.z;
          const t = THREE.MathUtils.clamp(((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1), 0, 1);
          if (Math.hypot(x - (a.x + t * dx), z - (a.z + t * dz)) < radius) return true;
        }
      }
    }
    return false;
  }

  // --- rendering ---
  /** Rebuild scene objects from the data, persist, and notify listeners. */
  sync(save = true) {
    const m = this.mesh;
    for (const k of [...this.selection]) {
      const id = +k.slice(1);
      if (k[0] === 'f' ? !m.faces.has(id) : !m.edges.has(id)) this.selection.delete(k);
    }
    for (const obj of [...this.group.children]) { obj.geometry?.dispose(); this.group.remove(obj); }

    // Smooth groups: faces joined through soft edges share vertex normals.
    const group = new Map();
    for (const f of m.faces.keys()) group.set(f, f);
    const find = (f) => { while (group.get(f) !== f) f = group.get(f); return f; };
    for (const [id, e] of m.edges) {
      if (!e.soft) continue;
      const fs = m.facesOfEdge(id);
      for (let i = 1; i < fs.length; i++) group.set(find(fs[i]), find(fs[0]));
    }
    const groupSize = new Map();
    for (const f of m.faces.keys()) groupSize.set(find(f), (groupSize.get(find(f)) ?? 0) + 1);
    const normals = new Map(); // face → normal
    const smooth = new Map(); // "group|vertex" → summed normal
    for (const f of m.faces.keys()) {
      const n = m.faceNormal(f);
      normals.set(f, n);
      const g = find(f);
      for (const v of m.faces.get(f).loops.flat()) {
        const k = `${g}|${v}`;
        if (!smooth.has(k)) smooth.set(k, new THREE.Vector3());
        smooth.get(k).add(n);
      }
    }

    const bucket = () => ({ pos: [], nor: [], col: [], sel: [], ids: [] });
    const buckets = { ground: bucket(), normal: bucket() };
    const color = new THREE.Color();
    for (const [id, f] of m.faces) {
      const n = normals.get(id);
      const flatOnGround = Math.abs(n.y) > 0.999 && f.loops[0].every((v) => onGround(m.vertices.get(v)));
      const b = flatOnGround ? buckets.ground : buckets.normal;
      const g = find(id);
      const soft = groupSize.get(g) > 1;
      color.set(f.color);
      // Selected faces are tinted in the shader (an overlay would fight the faces in depth).
      const selected = this.selection.has(`f${id}`) ? 1 : 0;
      for (const tri of m.faceTriangles(id)) {
        tri.pts.forEach((p, k) => {
          b.pos.push(p.x, p.y, p.z);
          const vn = soft ? smooth.get(`${g}|${tri.ids[k]}`).clone().normalize() : n;
          b.nor.push(vn.x, vn.y, vn.z);
          b.col.push(color.r, color.g, color.b);
          b.sel.push(selected);
        });
        b.ids.push(id);
      }
    }
    this.pickables = [];
    for (const [key, b] of Object.entries(buckets)) {
      if (!b.ids.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
      geo.setAttribute('aSelected', new THREE.Float32BufferAttribute(b.sel, 1));
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, key === 'ground' ? groundFaceMat : faceMat);
      mesh.castShadow = key !== 'ground';
      mesh.receiveShadow = true;
      mesh.userData.faceIds = b.ids;
      this.group.add(mesh);
      this.pickables.push(mesh);
    }

    const edgePos = [], linePos = [], selEdgePos = [];
    for (const [id, e] of m.edges) {
      const A = m.vertices.get(e.a), B = m.vertices.get(e.b);
      const seg = [A.x, A.y, A.z, B.x, B.y, B.z];
      if (e.soft) continue; // smooth edges stay hidden, selected or not
      if (this.selection.has(`e${id}`)) selEdgePos.push(...seg);
      (m.facesOfEdge(id).length ? edgePos : linePos).push(...seg);
    }
    const addLines = (pos, mat, order = 0) => {
      if (!pos.length) return;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const lines = new THREE.LineSegments(geo, mat);
      lines.raycast = () => {};
      lines.renderOrder = order;
      this.group.add(lines);
    };
    addLines(edgePos, edgeMat);
    addLines(linePos, lineMat);
    if (selEdgePos.length) {
      const sel = new LineSegments2(new LineSegmentsGeometry().setPositions(selEdgePos), selEdgeMat);
      sel.raycast = () => {};
      sel.renderOrder = 5;
      sel.userData.noAO = true;
      this.group.add(sel);
    }

    if (save) this.save();
    this.listeners.forEach((fn) => fn());
  }

  save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.toData())); } catch { /* ignore */ }
  }

  load() {
    const read = (key) => { try { return JSON.parse(localStorage.getItem(key) ?? 'null'); } catch { return null; } };
    let data = read(STORAGE_KEY);
    if (!data) {
      // From older versions: shapes, or walls before that.
      data = read(LEGACY_SHAPES_KEY);
      if (!data) { const walls = read(LEGACY_WALLS_KEY); if (Array.isArray(walls)) data = { walls }; }
    }
    try { this.mesh = meshFromData(data); } catch { this.mesh = new Mesh(); }
  }
}
