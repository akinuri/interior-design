import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { Mesh, shapesToMesh, cleanTex } from './mesh.js';
import { createMeasureView, createGuideView } from './measurements.js';
import { textureOf, isGlass, hasPicture, GLASS_OPACITY, unitsOf, ADJUSTS } from './materials.js';
import { booleanOp, isSolid } from './boolean.js';

/*
 * The scene model: edges and faces (see mesh.js), with undo history, rendering,
 * picking and the selection.
 *
 * Selection = a set of keys: 'f<id>' (face) and 'e<id>' (edge) of the mesh being edited,
 * 'g<id>' (a whole group, outside group editing), 'm<id>' (a measurement) and 'u<id>' (a guide).
 *
 * Groups: pieces of geometry kept apart (they don't stick to the rest). Each has its own
 * mesh. Clicking a group selects all of it; while editing one (enterGroup), `mesh` is the
 * group's and everything else is faded and left alone.
 */

const STORAGE_KEY = 'interior-design.model.v2';
const LEGACY_SHAPES_KEY = 'interior-design.model.v1';
const LEGACY_WALLS_KEY = 'interior-design.walls.v1';
export const DEFAULT_COLOR = '#ffffff';
/** The material faces have when they name none: always there, can't be deleted. */
export const DEFAULT_MATERIAL = 'default';
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
function meshFromData(data, materialOf) {
  if (data?.geometry) return Mesh.fromData(data.geometry);
  const shapes = [
    ...(Array.isArray(data?.shapes) ? data.shapes.map(cleanShape).filter(Boolean) : []),
    ...wallsToShapes(data?.walls),
  ].map((s) => ({ ...s, material: materialOf(s.color) }));
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
  uDotScale: { value: Math.max(1, Math.round(Math.min(globalThis.devicePixelRatio || 1, 2))) },
  uStyle: { value: 0 }, // face style, see FACE_STYLES
};

// Face styles (SketchUp-like): shaded, monochrome (one neutral colour), hidden line (flat white,
// no shading), x-ray (see-through), wireframe (edges only).
export const FACE_STYLES = ['shaded', 'mono', 'hidden', 'xray', 'wire'];
let faceStyle = 'shaded';
// Every face material (plain and textured) gets the same shader additions; face styles
// change them all.
const faceMaterials = new Set([faceMat, groundFaceMat]);
function patchFaceMaterial(mat) {
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
patchFaceMaterial(faceMat);
patchFaceMaterial(groundFaceMat);

/** A face material with a texture (one per scene material and ground / not), shaped like the plain ones. */
const texturedMats = new Map(); // "materialId|ground" → THREE material
function texturedMaterial(mat, ground, texture) {
  const key = `${mat.id}|${ground ? 'g' : 'n'}`;
  let m = texturedMats.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.9, side: THREE.DoubleSide,
      ...(ground ? {} : { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
    });
    patchFaceMaterial(m);
    faceMaterials.add(m);
    texturedMats.set(key, m);
  }
  // Glass: glossy and see-through (its opacity can be set); the face style keeps it so.
  const glass = isGlass(mat);
  m.roughness = glass ? 0.05 : 0.9;
  m.userData.glassOpacity = glass ? mat.opacity ?? GLASS_OPACITY : null;
  applyFaceStyleTo(m);
  if (m.map !== texture) { m.map = texture; m.needsUpdate = true; }
  return m;
}

/** Face style (from the Rendering settings): one of FACE_STYLES. */
export function setFaceStyle(style) {
  faceStyle = FACE_STYLES.includes(style) ? style : 'shaded';
  faceUniforms.uStyle.value = FACE_STYLES.indexOf(faceStyle);
  faceMaterials.forEach(applyFaceStyleTo);
}

function applyFaceStyleTo(m) {
  const xray = faceStyle === 'xray';
  const glass = m.userData.glassOpacity != null;
  const see = xray || glass;
  if (m.transparent !== see) { m.transparent = see; m.depthWrite = !see; m.needsUpdate = true; }
  m.opacity = glass ? m.userData.glassOpacity * (xray ? 0.8 : 1) : xray ? 0.45 : 1;
  m.visible = faceStyle !== 'wire';
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

// While editing a group, everything else is faded out.
const fadedFaceMat = new THREE.MeshStandardMaterial({ color: 0xd9d9d9, roughness: 0.9, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide });
const fadedEdgeMat = new THREE.LineBasicMaterial({ color: 0x2b2d31, transparent: true, opacity: 0.12, depthWrite: false });
// A selected group: a blue box around it.
const groupBoxMat = new LineMaterial({ color: 0x2a6df4, linewidth: 2 });

/** Edge line style (from the Rendering settings). */
export function setEdgeLines({ visible, opacity }) {
  edgeMat.opacity = opacity;
  edgeMat.visible = visible && opacity > 0;
}

/** A material's settings, made valid (sizes in m, at least 1 cm). */
function cleanMaterial(m) {
  const num = (v, d) => (Number.isFinite(v) ? v : d);
  const size = Array.isArray(m.size) ? m.size : [];
  return {
    id: m.id,
    name: typeof m.name === 'string' && m.name.trim() ? m.name.trim().slice(0, 60) : 'Material',
    color: typeof m.color === 'string' && /^#[0-9a-f]{6}$/i.test(m.color) ? m.color : '#ffffff',
    ...(typeof m.builtin === 'string' ? { builtin: m.builtin } : {}),
    // Glass only: how opaque (0.05 – 1); missing = the default.
    ...(Number.isFinite(m.opacity) ? { opacity: Math.min(1, Math.max(0.05, m.opacity)) } : {}),
    ...(typeof m.image === 'string' && !m.image.startsWith('data:') ? { image: m.image } : {}),
    size: [Math.max(0.01, num(size[0], 1)), Math.max(0.01, num(size[1], 1))],
    rotation: num(m.rotation, 0) % 360,
    // Picture adjustments, -1 … 1 each; kept only when something is changed.
    ...(() => {
      const adj = {};
      for (const k of ADJUSTS) { const v = num(m.adjust?.[k], 0); if (Math.abs(v) > 1e-6) adj[k] = Math.min(1, Math.max(-1, v)); }
      return Object.keys(adj).length ? { adjust: adj } : {};
    })(),
    // (Where the pattern sits is per face: `tex` on faces, see cleanTex in mesh.js.)
  };
}

// --- the model -----------------------------------------------------------------------------

export class Model {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);
    this.root = new Mesh(); // the geometry outside groups
    this.groups = new Map(); // id → { mesh, parent: id of the group it's in (subgroup) | null }
    this.nextGroupId = 1;
    this.activeGroup = null; // id of the group being edited, or null
    // Isolation (a view setting: not in the history or files): what's faded out, per mesh ('root' or a
    // group id): { faces: Map(key → Set), edges: Map(key → Set), groups: Set (wholly faded) }. What was
    // there when isolating minus the isolated selection, so geometry made later shows.
    this.isolation = null;
    this.measurements = []; // { id, a, b } (Measure tool), points in metres
    this.nextMeasureId = 1;
    this.measureView = createMeasureView(scene);
    // { id, name, color, builtin? | image?, size: [w, h] m, rotation, adjust? } (see materials.js); no picture: a plain colour.
    // The default material (what faces without one show) is always the first.
    this.materials = [cleanMaterial({ id: DEFAULT_MATERIAL, name: 'Default', color: DEFAULT_COLOR })];
    this.images = new Map(); // image id → data URL (kept out of the undo history)
    this.nextMaterialId = 1;
    this.nextImageId = 1;
    this.guides = []; // { id, p, d } (Measure tool from an edge): infinite lines to snap to
    this.nextGuideId = 1;
    this.guideView = createGuideView(scene);
    this.selection = new Set();
    this.undoStack = [];
    this.redoStack = [];
    this.listeners = new Set();
    this.load();
    this.sync(false);
  }

  onChange(fn) { this.listeners.add(fn); }

  /** The mesh being edited: the group's while editing one, else the geometry outside groups. */
  get mesh() { return this.activeGroup != null ? this.groups.get(this.activeGroup).mesh : this.root; }
  set mesh(m) {
    if (this.activeGroup != null) this.groups.get(this.activeGroup).mesh = m;
    else this.root = m;
  }

  /** All meshes: outside groups first, then each group's. */
  get meshes() { return [this.root, ...[...this.groups.values()].map((g) => g.mesh)]; }

  // Groups nest (subgroups): each has a `parent`. Where you are (`activeGroup`, null outside all)
  // decides what's picked as a whole: the groups directly in it.
  /** Ids of the groups directly in group `id` (null: the top level). */
  childGroups(id) { return [...this.groups].filter(([, g]) => g.parent === id).map(([k]) => k); }
  /** A group and every group inside it, at any depth. */
  groupTree(id) {
    const out = [id];
    for (let i = 0; i < out.length; i++) out.push(...this.childGroups(out[i]));
    return out;
  }
  /** The meshes of a group and its subgroups. */
  groupMeshes(id) { return this.groupTree(id).map((k) => this.groups.get(k).mesh); }
  /** Is group `id` group `outer` or inside it (null: everything is)? */
  isWithin(id, outer) {
    if (outer == null) return true;
    for (let k = id; k != null; k = this.groups.get(k)?.parent ?? null) if (k === outer) return true;
    return false;
  }
  /** The group directly where you are that holds group `id` (itself or one around it), or null. */
  contextGroupOf(id) {
    for (let k = id; k != null; k = this.groups.get(k)?.parent ?? null) if (this.groups.get(k)?.parent === this.activeGroup) return k;
    return null;
  }

  // --- isolation ---
  /** A mesh's key in the isolation: 'root' or its group's id. */
  meshKey(m) {
    if (m === this.root) return 'root';
    for (const [id, g] of this.groups) if (g.mesh === m) return id;
    return null;
  }
  /** Is this face / edge ('f' / 'e') of the mesh with key `key` faded out by the isolation? */
  isolatedOut(key, kind, id) { return !!this.isolation?.[kind === 'f' ? 'faces' : 'edges'].get(key)?.has(id); }

  /**
   * Isolate the selection: everything else fades out and can't be picked (like editing a group,
   * for anything). Returns false with nothing selected.
   */
  isolate() {
    if (!this.selection.size) return false;
    const here = this.activeGroup ?? 'root';
    const keep = new Set(); // groups shown whole: the selected ones with their subgroups
    for (const g of this.selectedGroups) this.groupTree(g).forEach((k) => keep.add(k));
    const keepFaces = new Set(this.selectedFaces), keepEdges = new Set(this.selectedEdges);
    for (const f of keepFaces) if (this.mesh.faces.has(f)) this.mesh.faceEdges(f).forEach((e) => keepEdges.add(e)); // a face's own edges
    const faces = new Map(), edges = new Map(), groups = new Set();
    for (const [key, m] of [['root', this.root], ...[...this.groups].map(([id, g]) => [id, g.mesh])]) {
      if (keep.has(key)) continue;
      const mine = key === here;
      faces.set(key, new Set([...m.faces.keys()].filter((f) => !(mine && keepFaces.has(f)))));
      edges.set(key, new Set([...m.edges.keys()].filter((e) => !(mine && keepEdges.has(e)))));
      if (key !== 'root' && !(mine && (keepFaces.size || keepEdges.size)) && ![...keep].some((k) => this.isWithin(k, key))) groups.add(key);
    }
    this.isolation = { faces, edges, groups };
    this.selection = new Set(); // (what's shown is plain to see)
    this.sync(false);
    return true;
  }

  /** Points of what's isolated (shown, not faded), for framing; empty without isolation. */
  isolatedPoints() {
    if (!this.isolation) return [];
    const out = [];
    for (const [key, m] of [['root', this.root], ...[...this.groups].map(([id, g]) => [id, g.mesh])]) {
      const ids = new Set();
      for (const [f, face] of m.faces) if (!this.isolatedOut(key, 'f', f)) face.loops.flat().forEach((v) => ids.add(v));
      for (const [e, edge] of m.edges) if (!this.isolatedOut(key, 'e', e)) { ids.add(edge.a); ids.add(edge.b); }
      for (const v of ids) { const p = m.vertices.get(v); if (Number.isFinite(p.x + p.y + p.z)) out.push(p.clone()); }
    }
    return out;
  }

  /** Show everything again. */
  endIsolation() {
    if (!this.isolation) return;
    this.isolation = null;
    this.sync(false);
  }

  /** Separate pieces (connected geometry, each group counts as one): "objects" for messages. */
  get count() {
    const m = this.root;
    const parent = new Map();
    const find = (v) => { while (parent.get(v) !== v) v = parent.get(v); return v; };
    for (const v of m.vertices.keys()) parent.set(v, v);
    for (const e of m.edges.values()) parent.set(find(e.a), find(e.b));
    // A face joins its holes to its outline (a box with a hole through it is one object).
    for (const f of m.faces.values()) for (const l of f.loops.slice(1)) parent.set(find(l[0]), find(f.loops[0][0]));
    let n = this.childGroups(null).length;
    for (const v of m.vertices.keys()) if (find(v) === v) n++;
    return n;
  }

  get isEmpty() { return this.root.edges.size === 0 && this.groups.size === 0 && !this.measurements.length && !this.guides.length; }

  // --- history ---
  // Each step stores the geometry plus, via `extraState`, the person. Extra state is
  // only restored for steps that changed it (`{ extra: true }`).
  extraState = { get: () => null, set: () => {} };

  snapshot(extra) {
    const data = {
      root: this.root.toData(), groups: [...this.groups].map(([id, g]) => [id, g.mesh.toData(), g.parent]), active: this.activeGroup,
      measurements: this.measurements.map((m) => [m.id, m.a.toArray(), m.b.toArray()]),
      guides: this.guides.map((g) => [g.id, g.p.toArray(), g.d.toArray(), { from: g.from?.toArray(), label: g.label }]),
      materials: this.materials,
    };
    return { data: JSON.stringify(data), extraValue: this.extraState.get(), extra };
  }
  checkpoint({ extra = false } = {}) {
    this.undoStack.push(this.snapshot(extra));
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack.length = 0;
  }
  dropCheckpoint() { this.undoStack.pop(); }
  restore(step) {
    const data = JSON.parse(step.data);
    this.root = Mesh.fromData(data.root);
    this.groups = new Map(data.groups.map(([id, g, parent]) => [id, { mesh: Mesh.fromData(g), parent: parent ?? null }]));
    this.nextGroupId = Math.max(this.nextGroupId, ...this.groups.keys(), 0) + 1;
    this.activeGroup = this.groups.has(data.active) ? data.active : null;
    this.measurements = data.measurements.map(([id, a, b]) => ({ id, a: new THREE.Vector3(...a), b: new THREE.Vector3(...b) }));
    this.nextMeasureId = Math.max(this.nextMeasureId, ...this.measurements.map((m) => m.id), 0) + 1;
    this.guides = data.guides.map(([id, p, d, o]) => ({ id, p: new THREE.Vector3(...p), d: new THREE.Vector3(...d), label: o.label, from: o.from ? new THREE.Vector3(...o.from) : null }));
    this.materials = data.materials;
    this.nextGuideId = Math.max(this.nextGuideId, ...this.guides.map((g) => g.id), 0) + 1;
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
    this.root = new Mesh();
    this.groups.clear();
    this.activeGroup = null;
    this.isolation = null;
    this.measurements = [];
    this.guides = [];
    this.selection.clear();
    this.sync();
  }

  /** Start over with data from a file (fresh undo history). Returns the object count. */
  replaceAll(data) {
    this.setData(data);
    this.isolation = null;
    this.undoStack = [];
    this.redoStack = [];
    this.selection.clear();
    this.sync();
    return this.count;
  }

  /** Plain data for saving: the geometry outside groups, and each group's. */
  toData() {
    // A subgroup names its group by its place in this list.
    const index = new Map([...this.groups.keys()].map((id, i) => [id, i]));
    const groups = [...this.groups.values()].map((g) => ({ geometry: g.mesh.toData(), ...(g.parent != null ? { parent: index.get(g.parent) } : {}) }));
    const r = (v) => v.toArray().map((x) => Math.round(x * 1e6) / 1e6);
    const measurements = this.measurements.map((m) => ({ a: r(m.a), b: r(m.b) }));
    const guides = this.guides.map((g) => ({ p: r(g.p), d: r(g.d), ...(g.from ? { from: r(g.from) } : {}), ...(g.label === false ? { label: false } : {}) }));
    // Materials go with their picture (a data URL), so a design file is complete on its own.
    const materials = this.materials.map(({ image, ...m }) => ({ ...m, ...(image ? { image: this.images.get(image) } : {}) }));
    return {
      geometry: this.root.toData(), ...(groups.length ? { groups } : {}),
      ...(measurements.length ? { measurements } : {}), ...(guides.length ? { guides } : {}),
      ...(materials.length ? { materials } : {}),
    };
  }

  /** Load saved data (any version; groups since they exist). */
  setData(data) {
    this.materials = [];
    this.images = new Map();
    this.nextMaterialId = 1;
    this.nextImageId = 1;
    for (const m of Array.isArray(data?.materials) ? data.materials : []) {
      if (typeof m?.id !== 'string' || this.materialById(m.id)) continue;
      const mat = cleanMaterial(m);
      if (typeof m.image === 'string' && m.image.startsWith('data:image/')) {
        mat.image = `img${this.nextImageId++}`;
        this.images.set(mat.image, m.image);
      }
      this.materials.push(mat);
      const n = parseInt(mat.id.replace(/\D/g, ''), 10);
      if (Number.isFinite(n)) this.nextMaterialId = Math.max(this.nextMaterialId, n + 1);
    }
    // Faces used to have their own colour. Older files: the colour new faces got becomes the
    // default material; every other colour a plain-colour material (one per colour).
    const oldDefault = [data?.newShapes?.color, data?.newWalls?.color].find((c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)) ?? DEFAULT_COLOR;
    if (!this.materialById(DEFAULT_MATERIAL)) this.materials.unshift(cleanMaterial({ id: DEFAULT_MATERIAL, name: 'Default', color: oldDefault }));
    else this.materials = [this.materialById(DEFAULT_MATERIAL), ...this.materials.filter((m) => m.id !== DEFAULT_MATERIAL)];
    const byColor = new Map();
    const materialOf = (color) => {
      if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color) || color.toLowerCase() === oldDefault.toLowerCase()) return null;
      const c = color.toLowerCase();
      if (!byColor.has(c)) {
        const mat = cleanMaterial({ id: `mat${this.nextMaterialId++}`, name: c, color: c });
        this.materials.push(mat);
        byColor.set(c, mat.id);
      }
      return byColor.get(c);
    };
    const upgrade = (geo) => (Array.isArray(geo?.faces)
      ? { ...geo, faces: geo.faces.map((f) => (f && !f.material && f.color ? { ...f, material: materialOf(f.color) } : f)) }
      : geo);

    this.root = meshFromData(data?.geometry ? { ...data, geometry: upgrade(data.geometry) } : data, materialOf);
    this.groups = new Map();
    this.nextGroupId = 1;
    // Subgroups: `parent` is the index of the group they're in. A bad one (missing, itself, a
    // loop) puts the group at the top level. Kept: groups with geometry, and groups holding some.
    const list = (Array.isArray(data?.groups) ? data.groups : []).map((g) => ({ mesh: Mesh.fromData(upgrade(g?.geometry)), parent: g?.parent }));
    for (const [i, g] of list.entries()) {
      if (!Number.isInteger(g.parent) || g.parent < 0 || g.parent >= list.length || g.parent === i) g.parent = null;
    }
    for (const g of list) {
      const seen = new Set([g]);
      for (let k = g.parent; k != null; k = list[k].parent) { if (seen.has(list[k])) { g.parent = null; break; } seen.add(list[k]); }
    }
    const keep = list.map((g) => g.mesh.edges.size > 0);
    for (const [i, g] of list.entries()) if (keep[i]) for (let k = g.parent; k != null; k = list[k].parent) keep[k] = true;
    const ids = list.map((g, i) => (keep[i] ? this.nextGroupId++ : null));
    for (const [i, g] of list.entries()) if (keep[i]) this.groups.set(ids[i], { mesh: g.mesh, parent: g.parent != null ? ids[g.parent] : null });
    this.activeGroup = null;
    const point = (p) => (Array.isArray(p) && p.length === 3 && p.every(Number.isFinite) ? new THREE.Vector3(...p) : null);
    this.measurements = [];
    this.nextMeasureId = 1;
    for (const m of Array.isArray(data?.measurements) ? data.measurements : []) {
      const a = point(m?.a), b = point(m?.b);
      if (a && b) this.measurements.push({ id: this.nextMeasureId++, a, b });
    }
    this.guides = [];
    this.nextGuideId = 1;
    for (const g of Array.isArray(data?.guides) ? data.guides : []) {
      const p = point(g?.p), d = point(g?.d);
      if (p && d && d.lengthSq() > 1e-12) this.guides.push({ id: this.nextGuideId++, p, d: d.normalize(), from: point(g.from), ...(g.label === false ? { label: false } : {}) });
    }
  }

  // --- materials ---
  materialById(id) { return this.materials.find((m) => m.id === id) ?? null; }
  /** A face's material (none, or one that's gone: the default). */
  faceMaterial(face) { return (face.material && this.materialById(face.material)) || this.materialById(DEFAULT_MATERIAL); }

  /**
   * Add a material (one undo step): { name, builtin } or { name, imageDataURL }, or just a name
   * and colour (a plain colour); size, color, rotation. Returns its id.
   */
  addMaterial({ name, builtin = null, imageDataURL = null, size, color = '#ffffff', rotation = 0 }) {
    this.checkpoint();
    const mat = cleanMaterial({ id: `mat${this.nextMaterialId++}`, name, builtin, size, color, rotation });
    if (imageDataURL) {
      mat.image = `img${this.nextImageId++}`;
      this.images.set(mat.image, imageDataURL);
    }
    this.materials.push(mat);
    this.sync();
    return mat.id;
  }

  /**
   * Give a material a new picture (one undo step): faces using it show the new one. A built-in
   * becomes a picture material. One repeat stays as wide, its height from the picture's shape.
   */
  replaceMaterialImage(id, dataURL, aspect) {
    const i = this.materials.findIndex((m) => m.id === id);
    if (i < 0) return;
    this.checkpoint();
    // (The old picture stays in the table: undo goes back to it. Saving only writes pictures in use.)
    const image = `img${this.nextImageId++}`;
    this.images.set(image, dataURL);
    const { builtin, ...rest } = this.materials[i];
    const w = rest.size[0];
    this.materials[i] = cleanMaterial({ ...rest, image, size: [w, w / (aspect > 0 ? aspect : 1)] });
    this.sync();
  }

  /** Change a material's settings. `live`: while dragging / typing (one undo step on the commit). */
  updateMaterial(id, patch, { live = false } = {}) {
    const i = this.materials.findIndex((m) => m.id === id);
    if (i < 0) return;
    if (live) this.materialBefore ??= this.materials[i];
    else {
      if (this.materialBefore) { this.materials[i] = this.materialBefore; this.materialBefore = null; }
      this.checkpoint();
    }
    this.materials[i] = cleanMaterial({ ...this.materials[i], ...patch });
    this.sync(!live);
  }

  /** Remove a material (one undo step); faces using it get the default one (which stays). */
  deleteMaterial(id) {
    if (id === DEFAULT_MATERIAL) return;
    this.checkpoint();
    this.materials = this.materials.filter((m) => m.id !== id);
    for (const mesh of this.meshes) for (const f of mesh.faces.values()) if (f.material === id) delete f.material;
    this.sync();
  }

  /** The selected faces' material: an id, null if mixed, undefined without faces. */
  selectionMaterial() {
    const t = this.colorTargets();
    if (!t.length) return undefined;
    const ids = new Set(t.map(([m, f]) => this.faceMaterial(m.faces.get(f)).id));
    return ids.size === 1 ? [...ids][0] : null;
  }

  /** Selected faces (also of selected groups) with a pattern to place: a texture that isn't glass. */
  texTargets() {
    return this.colorTargets().filter(([m, f]) => {
      const mat = this.faceMaterial(m.faces.get(f));
      return hasPicture(mat) && !isGlass(mat);
    });
  }

  /**
   * Where the texture sits on the selected faces: { offsetX, offsetY (m), rotation (deg), width,
   * height (m per tile / plank / brick: the face's own size, else the material's) }, each null where
   * they differ; undefined when no selected face has a texture.
   */
  selectionTex() {
    const t = this.texTargets();
    if (!t.length) return undefined;
    const vals = t.map(([m, f]) => {
      const face = m.faces.get(f), x = face.tex, mat = this.faceMaterial(face);
      const size = x?.size ?? mat.size, u = unitsOf(mat);
      return { offsetX: x?.offset[0] ?? 0, offsetY: x?.offset[1] ?? 0, rotation: x?.rotation ?? 0, width: size[0] / u[0], height: size[1] / u[1] };
    });
    const out = {};
    for (const k of Object.keys(vals[0])) out[k] = vals.every((v) => Math.abs(v[k] - vals[0][k]) < 1e-9) ? vals[0][k] : null;
    return out;
  }

  /**
   * Change where the texture sits on the selected faces: `patch` sets some of offsetX, offsetY,
   * rotation, width, height (m per tile / plank / brick; the rest stay as each face has them);
   * `reset` puts it back to the material's own. `live`: while typing (one undo step for the change).
   */
  setSelectionTex(patch, { live = false, reset = false } = {}) {
    const t = this.texTargets();
    if (!t.length) return;
    if (!this.texLive) this.checkpoint();
    this.texLive = live;
    for (const [m, f] of t) {
      const face = m.faces.get(f);
      const cur = face.tex ?? { offset: [0, 0], rotation: 0 };
      const mat = this.faceMaterial(face), u = unitsOf(mat);
      // A new width / height makes the size this face's own (the other side as it is now).
      const own = patch.width != null || patch.height != null;
      const size = cur.size ?? mat.size;
      const next = reset ? null : cleanTex({
        offset: [patch.offsetX ?? cur.offset[0], patch.offsetY ?? cur.offset[1]],
        rotation: patch.rotation ?? cur.rotation,
        size: own ? [patch.width != null ? patch.width * u[0] : size[0], patch.height != null ? patch.height * u[1] : size[1]] : cur.size,
      });
      if (next) face.tex = next; else delete face.tex;
    }
    this.sync(!live);
  }

  /**
   * Fit the texture to each selected face (one undo step): one repeat of it covers the face's
   * outline exactly, as it's turned now (the face gets its own size and offset).
   */
  fitSelectionTex() {
    const t = this.texTargets();
    if (!t.length) return;
    this.checkpoint();
    for (const [m, f] of t) {
      const face = m.faces.get(f);
      const cur = face.tex ?? { offset: [0, 0], rotation: 0 };
      const mat = this.faceMaterial(face);
      // The face's corners in the texture's own (turned) directions, as the renderer lays it out.
      const plane = m.facePlane(f);
      const a = THREE.MathUtils.degToRad(mat.rotation + cur.rotation), cos = Math.cos(a), sin = Math.sin(a);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const v of face.loops[0]) {
        const p = m.vertices.get(v), s = p.dot(plane.u), r = p.dot(plane.v);
        const x = s * cos - r * sin, y = s * sin + r * cos;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
      const tex = cleanTex({ offset: [x0, y0], rotation: cur.rotation, size: [Math.max(0.01, x1 - x0), Math.max(0.01, y1 - y0)] });
      if (tex) face.tex = tex; else delete face.tex;
    }
    this.sync();
  }

  /** Put a material on the selected faces / groups (one undo step). */
  setSelectionMaterial(id) {
    const t = this.colorTargets();
    if (!t.length) return;
    this.checkpoint();
    for (const [m, f] of t) {
      const face = m.faces.get(f);
      if (id && id !== DEFAULT_MATERIAL) face.material = id; else delete face.material; // (none = the default)
    }
    this.sync();
  }

  // --- guides ---
  get selectedGuides() { return [...this.selection].filter((k) => k[0] === 'u').map((k) => +k.slice(1)); }

  /**
   * Add a guide through p along direction d (one undo step). `from`: the point it was measured
   * from (on the edge), so its offset can show as a measurement.
   */
  addGuide(p, d, from = null) {
    if (d.lengthSq() < 1e-12) return;
    this.checkpoint();
    this.guides.push({ id: this.nextGuideId++, p: p.clone(), d: d.clone().normalize(), from: from?.clone() ?? null });
    this.sync();
  }

  /**
   * The selected guides' offset label (the measurement back to the edge they came from):
   * true / false, null when mixed, undefined when no selected guide has one.
   */
  guideLabelState() {
    const gs = this.selectedGuides.map((id) => this.guides.find((g) => g.id === id)).filter((g) => g?.from);
    if (!gs.length) return undefined;
    const on = gs.map((g) => g.label !== false);
    return on.every(Boolean) ? true : on.some(Boolean) ? null : false;
  }

  /** Show / hide the selected guides' offset label (one undo step). */
  setGuideLabel(on) {
    this.checkpoint();
    for (const id of this.selectedGuides) {
      const g = this.guides.find((x) => x.id === id);
      if (g?.from) { if (on) delete g.label; else g.label = false; }
    }
    this.sync();
  }

  /** The guide under the mouse, or null. */
  pickGuide(ray, camera, size) { return this.guideView.pick(ray, camera, size); }

  // --- measurements ---
  get selectedMeasurements() { return [...this.selection].filter((k) => k[0] === 'm').map((k) => +k.slice(1)); }

  /** Keep a measurement from a to b (one undo step). */
  addMeasurement(a, b) {
    if (a.distanceTo(b) < 1e-3) return;
    this.checkpoint();
    this.measurements.push({ id: this.nextMeasureId++, a: a.clone(), b: b.clone() });
    this.sync();
  }

  /**
   * Selection keys for a screen box { x0, y0, x1, y1 } (px): with `crossing`, everything the box
   * touches; else only what's fully inside. Hidden things count too (like SketchUp).
   */
  keysInBox(box, camera, size, crossing) {
    const toScreen = (p) => { const v = p.clone().project(camera); return { x: (v.x + 1) / 2 * size.x, y: (1 - v.y) / 2 * size.y, ok: v.z <= 1 && v.z >= -1 }; };
    const inside = (s) => s.ok && s.x >= box.x0 && s.x <= box.x1 && s.y >= box.y0 && s.y <= box.y1;
    // Does segment a-b cross the box? (Clip it against the box, Liang-Barsky.)
    const crosses = (a, b) => {
      if (!a.ok || !b.ok) return false;
      let t0 = 0, t1 = 1;
      const dx = b.x - a.x, dy = b.y - a.y;
      for (const [p, q] of [[-dx, a.x - box.x0], [dx, box.x1 - a.x], [-dy, a.y - box.y0], [dy, box.y1 - a.y]]) {
        if (p === 0) { if (q < 0) return false; continue; }
        const r = q / p;
        if (p < 0) t0 = Math.max(t0, r); else t1 = Math.min(t1, r);
        if (t0 > t1) return false;
      }
      return true;
    };
    const caught = (pts, segs) => (crossing ? pts.some(inside) || segs.some(([a, b]) => crosses(a, b)) : pts.length > 0 && pts.every(inside));
    const screenOf = (m) => { const out = new Map(); for (const [id, v] of m.vertices) out.set(id, toScreen(v)); return out; };
    const keys = [];
    const m = this.mesh;
    const s = screenOf(m);
    // Crossing: a box drawn inside a face (touching none of its edges) still touches the face.
    const mid = { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 };
    const holds = (poly, pt) => {
      if (poly.some((q) => !q.ok)) return false;
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i], b = poly[j];
        if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
      }
      return inside;
    };
    const meKey = this.activeGroup ?? 'root';
    for (const [id, f] of m.faces) {
      if (this.isolatedOut(meKey, 'f', id)) continue; // faded out: not pickable
      const loops = f.loops.map((l) => l.map((v) => s.get(v)));
      const segs = loops.flatMap((l) => l.map((p, i) => [p, l[(i + 1) % l.length]]));
      if (caught(loops.flat(), segs) || (crossing && holds(loops[0], mid) && !loops.slice(1).some((h) => holds(h, mid)))) keys.push(`f${id}`);
    }
    for (const [id, e] of m.edges) {
      if (e.soft || this.isolatedOut(meKey, 'e', id)) continue;
      const a = s.get(e.a), b = s.get(e.b);
      if (caught([a, b], [[a, b]])) keys.push(`e${id}`);
    }
    // Groups directly where you are, each with its subgroups.
    for (const id of this.childGroups(this.activeGroup)) {
      if (this.isolation?.groups.has(id)) continue;
      const pts = [], segs = [];
      for (const gm of this.groupMeshes(id)) {
        const gs = screenOf(gm);
        pts.push(...gs.values());
        for (const e of gm.edges.values()) segs.push([gs.get(e.a), gs.get(e.b)]);
      }
      if (caught(pts, segs)) keys.push(`g${id}`);
    }
    if (this.activeGroup == null) {
      for (const it of this.measurements) {
        const a = toScreen(it.a), b = toScreen(it.b);
        if (caught([a, b], [[a, b]])) keys.push(`m${it.id}`);
      }
      // Guides with a visible offset label, by that offset measurement (bare infinite lines aren't caught).
      for (const g of this.guides) {
        if (!g.from || g.label === false) continue;
        const a = toScreen(g.from), b = toScreen(g.p);
        if (caught([a, b], [[a, b]])) keys.push(`u${g.id}`);
      }
    }
    return keys;
  }

  /** The measurement (or a guide's offset measurement) under the mouse: its key, or null. */
  pickMeasurement(ndc, camera, size) { return this.measureView.pick(ndc, camera, size); }

  // --- groups ---
  get selectedGroups() { return [...this.selection].filter((k) => k[0] === 'g').map((k) => +k.slice(1)); }

  /**
   * Make the selected faces / edges and groups one group (one undo step), where you are: inside a
   * group it's a subgroup; selected groups go into it.
   */
  groupSelection() {
    const faces = this.selectedFaces, edges = this.selectedEdges, groups = this.selectedGroups;
    if (!faces.length && !edges.length && !groups.length) return;
    this.checkpoint();
    const mesh = new Mesh();
    if (faces.length || edges.length) {
      this.mesh.copyInto(mesh, faces, edges);
      this.mesh.removeParts(faces, edges);
    }
    const id = this.nextGroupId++;
    this.groups.set(id, { mesh, parent: this.activeGroup });
    for (const g of groups) this.groups.get(g).parent = id;
    this.selection = new Set([`g${id}`]);
    this.sync();
  }

  /**
   * Boolean of the two selected groups (closed solids), one undo step: 'union', 'subtract'
   * (the first selected is cut out of the other) or 'intersect'. The result is one group,
   * selected. Returns null when done, else why not: 'two' (not exactly two groups selected),
   * 'solid' (one isn't closed), 'empty' (nothing left).
   */
  booleanSelection(op) {
    const ids = this.selectedGroups;
    if (ids.length !== 2 || this.selection.size !== 2) return 'two';
    const [first, second] = ids.map((id) => this.groups.get(id).mesh);
    // (A group holding subgroups isn't one solid.)
    if (ids.some((id) => this.childGroups(id).length) || !isSolid(first) || !isSolid(second)) return 'solid';
    const result = op === 'subtract' ? booleanOp(second, first, 'subtract') : booleanOp(first, second, op);
    if (!result) return 'empty';
    this.checkpoint();
    for (const id of ids) this.groups.delete(id);
    const id = this.nextGroupId++;
    this.groups.set(id, { mesh: result, parent: this.activeGroup });
    this.selection = new Set([`g${id}`]);
    this.sync();
    return null;
  }

  /**
   * Turn the selected groups back into plain geometry where you are (one undo step); their
   * subgroups come out as groups. It all stays selected.
   */
  ungroupSelection() {
    const ids = this.selectedGroups;
    if (!ids.length) return;
    this.checkpoint();
    const keys = [];
    for (const id of ids) {
      const g = this.groups.get(id).mesh;
      const { faces, edges } = g.copyInto(this.mesh, [...g.faces.keys()], [...g.edges.keys()]);
      for (const c of this.childGroups(id)) { this.groups.get(c).parent = this.activeGroup; keys.push(`g${c}`); }
      this.groups.delete(id);
      keys.push(...faces.map((f) => `f${f}`), ...edges.map((e) => `e${e}`));
    }
    this.selection = new Set(keys);
    this.sync();
  }

  /**
   * Take the selected faces / edges and subgroups out of the group being edited, into the one
   * around it (or the top level); `toWorld`: out of all groups. One undo step. Editing goes out
   * with them, and they stay selected.
   */
  moveOutOfGroup({ toWorld = false } = {}) {
    const id = this.activeGroup;
    const faces = this.selectedFaces, edges = this.selectedEdges, groups = this.selectedGroups;
    if (id == null || (!faces.length && !edges.length && !groups.length)) return;
    this.checkpoint();
    const parent = toWorld ? null : this.groups.get(id).parent;
    const outer = parent != null ? this.groups.get(parent).mesh : this.root;
    const keys = [];
    if (faces.length || edges.length) {
      const r = this.mesh.copyInto(outer, faces, edges);
      this.mesh.removeParts(faces, edges);
      keys.push(...r.faces.map((f) => `f${f}`), ...r.edges.map((e) => `e${e}`));
    }
    for (const g of groups) { this.groups.get(g).parent = parent; keys.push(`g${g}`); }
    this.activeGroup = parent;
    // Groups left with nothing in them go away (the one emptied, and the ones around it it was all of).
    for (let k = id; k != null && k !== parent;) {
      const g = this.groups.get(k);
      if (g.mesh.edges.size || this.childGroups(k).length) break;
      this.groups.delete(k);
      k = g.parent;
    }
    this.selection = new Set(keys);
    this.sync();
  }

  /** Edit a group's geometry (everything else fades out). */
  enterGroup(id) {
    if (!this.groups.has(id)) return;
    this.activeGroup = id;
    this.selection = new Set();
    this.sync(false);
  }

  /** Stop editing the group, back to the one around it (it stays selected); an emptied group goes away. */
  exitGroup() {
    const id = this.activeGroup;
    if (id == null) return;
    this.activeGroup = this.groups.get(id).parent;
    if (!this.groups.get(id).mesh.edges.size && !this.childGroups(id).length) this.groups.delete(id);
    this.selection = new Set(this.groups.has(id) ? [`g${id}`] : []);
    this.sync();
  }

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
    const here = this.activeGroup ?? 'root';
    const groups = this.childGroups(this.activeGroup).filter((g) => !this.isolation?.groups.has(g)).map((g) => `g${g}`);
    const measures = this.activeGroup == null ? [...this.measurements.map((m) => `m${m.id}`), ...this.guides.map((g) => `u${g.id}`)] : [];
    const faces = [...this.mesh.faces.keys()].filter((f) => !this.isolatedOut(here, 'f', f)), edges = [...this.mesh.edges.keys()].filter((e) => !this.isolatedOut(here, 'e', e));
    this.select([...faces.map((f) => `f${f}`), ...edges.map((e) => `e${e}`), ...groups, ...measures]);
  }

  deleteSelection() {
    if (!this.selection.size) return;
    const faces = this.selectedFaces, edges = this.selectedEdges, groups = this.selectedGroups;
    const measures = new Set(this.selectedMeasurements), guides = new Set(this.selectedGuides);
    this.selection.clear();
    this.checkpoint();
    for (const id of groups.flatMap((g) => this.groupTree(g))) this.groups.delete(id);
    this.measurements = this.measurements.filter((m) => !measures.has(m.id));
    this.guides = this.guides.filter((g) => !guides.has(g.id));
    if (faces.length || edges.length) this.mesh.erase(faces, edges);
    this.sync();
  }

  /**
   * Copies of the selected faces / edges, groups and measurements, in place, which become the
   * selection (no history: the Move tool's copy mode, inside its own undo step). Returns their keys.
   */
  duplicateSelection() {
    const keys = [];
    const faces = this.selectedFaces, edges = this.selectedEdges;
    if (faces.length || edges.length) {
      // Fresh points, so the copy doesn't stick to the original while it's being placed.
      const r = this.mesh.copyInto(this.mesh, faces, edges, { fresh: true });
      keys.push(...r.faces.map((f) => `f${f}`), ...r.edges.map((e) => `e${e}`));
    }
    // A group with its subgroups.
    const copy = (id, parent) => {
      const nid = this.nextGroupId++;
      const kids = this.childGroups(id);
      this.groups.set(nid, { mesh: Mesh.fromData(this.groups.get(id).mesh.toData()), parent });
      for (const c of kids) copy(c, nid);
      return nid;
    };
    for (const id of this.selectedGroups) keys.push(`g${copy(id, this.activeGroup)}`);
    for (const id of this.selectedMeasurements) {
      const it = this.measurements.find((x) => x.id === id);
      const nid = this.nextMeasureId++;
      this.measurements.push({ id: nid, a: it.a.clone(), b: it.b.clone() });
      keys.push(`m${nid}`);
    }
    this.selection = new Set(keys);
    return keys;
  }

  /** Take away what duplicateSelection made (no history). */
  removeKeys(keys) {
    const ids = (c) => keys.filter((k) => k[0] === c).map((k) => +k.slice(1));
    const faces = ids('f'), edges = ids('e'), measures = new Set(ids('m'));
    if (faces.length || edges.length) this.mesh.removeParts(faces, edges);
    for (const id of ids('g').flatMap((g) => this.groupTree(g))) this.groups.delete(id);
    this.measurements = this.measurements.filter((m) => !measures.has(m.id));
    keys.forEach((k) => this.selection.delete(k));
  }

  /** Faces a material change applies to: the selected faces and all faces of selected groups. */
  colorTargets() {
    const out = this.selectedFaces.filter((f) => this.mesh.faces.has(f)).map((f) => [this.mesh, f]);
    for (const id of this.selectedGroups) if (this.groups.has(id)) for (const m of this.groupMeshes(id)) for (const f of m.faces.keys()) out.push([m, f]);
    return out;
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
  makeFaces({ towards }) {
    const edges = this.selectedEdges;
    this.checkpoint();
    const made = this.mesh.makeFaces(edges, { towards });
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

  // --- queries ---
  boundingBox() {
    const box = new THREE.Box3();
    for (const m of this.meshes) for (const v of m.vertices.values()) box.expandByPoint(v);
    return box;
  }

  /** Every point of the geometry (groups included), for framing views. */
  allPoints() {
    // (Only real numbers: a broken point would wreck the framing.)
    return this.meshes.flatMap((m) => [...m.vertices.values()].filter((v) => Number.isFinite(v.x + v.y + v.z)).map((v) => v.clone()));
  }

  /** Meshes to snap to while drawing: everything outside group editing, else the group. */
  get snapMeshes() { return this.activeGroup != null ? [this.mesh] : this.meshes; }

  /** Raycast faces: { face, point, normal } or null. */
  pickFace(raycaster) {
    if (faceStyle === 'wire') return null; // no faces to pick
    const hit = raycaster.intersectObjects(this.pickables, false)[0];
    if (!hit) return null;
    const { faceIds, groupId, mesh } = hit.object.userData;
    const face = faceIds?.[hit.faceIndex];
    if (face == null || !mesh?.faces.has(face)) return null;
    // `group`: set when the face belongs to a group that isn't being edited (the group is the pick).
    return { face, mesh, group: groupId ?? null, point: hit.point, normal: mesh.faceNormal(face), distance: hit.distance };
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
    const here = this.activeGroup ?? 'root';
    for (const [id, e] of this.mesh.edges) {
      if (e.soft || (only && !only.has(id)) || this.isolatedOut(here, 'e', id)) continue;
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

  /**
   * The floor height at (x, z): the highest floor-like face (not steeper than ~45°) there that
   * isn't above `maxY` (so a ceiling or a table top overhead doesn't count); the ground is 0.
   */
  floorAt(x, z, maxY = Infinity) {
    let best = 0;
    const inside = (poly) => {
      let r = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i], b = poly[j];
        if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) r = !r;
      }
      return r;
    };
    for (const m of this.meshes) {
      for (const [id, f] of m.faces) {
        const n = m.faceNormal(id);
        if (Math.abs(n.y) < 0.7) continue;
        const loops = f.loops.map((l) => l.map((v) => m.vertices.get(v)));
        if (!inside(loops[0]) || loops.slice(1).some(inside)) continue;
        const p0 = loops[0][0];
        const y = p0.y - (n.x * (x - p0.x) + n.z * (z - p0.z)) / n.y;
        if (y <= maxY + 1e-6 && y > best) best = y;
      }
    }
    return best;
  }

  /**
   * Does a person of `radius` at (x, z), feet at `footY`, bump into a wall-like face between
   * knee and eye height? (Below the knee: a step they can climb.)
   */
  blocks(x, z, radius, eyeHeight, footY = 0) {
    return this.meshes.some((m) => this.meshBlocks(m, x, z, radius, eyeHeight, footY));
  }

  meshBlocks(m, x, z, radius, eyeHeight, footY = 0) {
    const heights = [0.4, eyeHeight * 0.6, eyeHeight].map((h) => footY + h);
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
    if (this.activeGroup != null && !this.groups.has(this.activeGroup)) this.activeGroup = null;
    const active = this.mesh;
    for (const k of [...this.selection]) {
      const id = +k.slice(1);
      const ok = k[0] === 'f' ? active.faces.has(id) : k[0] === 'e' ? active.edges.has(id)
        : k[0] === 'm' ? this.measurements.some((m) => m.id === id) : k[0] === 'u' ? this.guides.some((g) => g.id === id)
        : this.groups.has(id) && this.groups.get(id).parent === this.activeGroup;
      if (!ok) this.selection.delete(k);
    }
    for (const obj of [...this.group.children]) { obj.geometry?.dispose(); this.group.remove(obj); }
    this.pickables = [];

    // Editing a group: it and what's in it as usual, everything else faded. Its subgroups are
    // picked whole (as groups are at the top level).
    const editingGroup = this.activeGroup != null;
    this.renderMesh(this.root, { active: !editingGroup, faded: editingGroup, key: 'root' });
    for (const [id, g] of this.groups) {
      const isActive = id === this.activeGroup;
      this.renderMesh(g.mesh, { active: isActive, faded: !this.isWithin(id, this.activeGroup), groupId: isActive ? null : this.contextGroupOf(id), key: id });
    }
    // Selected groups: a blue box around each.
    const boxPos = [];
    for (const id of this.selectedGroups) {
      const box = new THREE.Box3();
      for (const m of this.groupMeshes(id)) for (const v of m.vertices.values()) box.expandByPoint(v);
      box.expandByScalar(0.02);
      const c = (i) => new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
      for (const [a, b] of [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]]) {
        boxPos.push(...c(a).toArray(), ...c(b).toArray());
      }
    }
    if (boxPos.length) {
      const lines = new LineSegments2(new LineSegmentsGeometry().setPositions(boxPos), groupBoxMat);
      lines.raycast = () => {};
      lines.userData.noAO = true;
      this.group.add(lines);
    }

    // Measurements, plus each guide's offset (from the edge it was measured from) as one.
    const dims = [
      ...this.measurements.map((m) => ({ key: `m${m.id}`, a: m.a, b: m.b })),
      ...this.guides.filter((g) => g.from && g.label !== false).map((g) => ({ key: `u${g.id}`, a: g.from, b: g.p })),
    ];
    this.measureView.set(dims, this.selection);
    this.guideView.set(this.guides, new Set(this.selectedGuides));

    if (save) this.save();
    this.listeners.forEach((fn) => fn());
  }

  /**
   * Scene objects for one mesh. `active`: the one being edited (selection shows, pickable);
   * `faded`: drawn faintly (while editing another group); `groupId`: a closed group,
   * pickable as a whole.
   */
  renderMesh(m, { active, faded, groupId = null, key = null }) {
    // Faded: the whole mesh (editing another group), or single faces / edges (isolation).
    const offF = (id) => faded || this.isolatedOut(key, 'f', id);
    const offE = (id) => faded || this.isolatedOut(key, 'e', id);

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

    // One bucket per (on the ground or not) × (material) × (faded or not); textured ones get texture coordinates.
    const buckets = new Map();
    const bucketFor = (ground, mat, off) => {
      const k = `${ground ? 'g' : 'n'}|${mat?.id ?? ''}|${off ? 'f' : ''}`;
      if (!buckets.has(k)) buckets.set(k, { ground, mat, off, pos: [], nor: [], col: [], sel: [], uv: [], ids: [] });
      return buckets.get(k);
    };
    const color = new THREE.Color();
    for (const [id, f] of m.faces) {
      const n = normals.get(id);
      const flatOnGround = Math.abs(n.y) > 0.999 && f.loops[0].every((v) => onGround(m.vertices.get(v)));
      const mat = this.faceMaterial(f);
      const off = offF(id);
      const tex = mat && !off ? textureOf(mat, this.images) : null;
      const b = bucketFor(flatOnGround, tex ? mat : null, off);
      const g = find(id);
      const soft = groupSize.get(g) > 1;
      color.set(mat.color); // the material's colour (textured: its tint)
      // Texture laid flat on the face, at real size, aligned to the world (tiles line up across faces).
      let uvOf = null;
      if (tex) {
        // This face's placement: turned on top of the material's turn, shifted, its size.
        const plane = m.facePlane(id);
        const place = f.tex ?? { offset: [0, 0], rotation: 0 };
        const a = THREE.MathUtils.degToRad(mat.rotation + place.rotation), cos = Math.cos(a), sin = Math.sin(a);
        const [w, h] = place.size ?? mat.size; // the face's own size, else the material's
        uvOf = (p) => {
          const s = p.dot(plane.u), t = p.dot(plane.v);
          return [(s * cos - t * sin - place.offset[0]) / w, (s * sin + t * cos - place.offset[1]) / h];
        };
      }
      // Selected faces are tinted in the shader (an overlay would fight the faces in depth).
      const selected = active && this.selection.has(`f${id}`) ? 1 : 0;
      for (const tri of m.faceTriangles(id)) {
        tri.pts.forEach((p, k) => {
          b.pos.push(p.x, p.y, p.z);
          const vn = soft ? smooth.get(`${g}|${tri.ids[k]}`).clone().normalize() : n;
          b.nor.push(vn.x, vn.y, vn.z);
          b.col.push(color.r, color.g, color.b);
          b.sel.push(selected);
          if (uvOf) b.uv.push(...uvOf(p));
        });
        b.ids.push(id);
      }
    }
    for (const b of buckets.values()) {
      if (!b.ids.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
      geo.setAttribute('aSelected', new THREE.Float32BufferAttribute(b.sel, 1));
      if (b.mat) geo.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
      geo.computeBoundingSphere();
      const material = b.off ? fadedFaceMat
        : b.mat ? texturedMaterial(b.mat, b.ground, textureOf(b.mat, this.images))
          : b.ground ? groundFaceMat : faceMat;
      const mesh = new THREE.Mesh(geo, material);
      const glass = !b.off && isGlass(b.mat);
      mesh.castShadow = !b.ground && !b.off && !glass; // light goes through glass
      mesh.receiveShadow = !b.off;
      mesh.userData = { faceIds: b.ids, groupId, mesh: m };
      if (b.off || glass) mesh.userData.noAO = true; // (AO would darken what's seen through it)
      this.group.add(mesh);
      if (!b.off) this.pickables.push(mesh);
    }

    const edgePos = [], linePos = [], selEdgePos = [], offPos = [];
    for (const [id, e] of m.edges) {
      const A = m.vertices.get(e.a), B = m.vertices.get(e.b);
      const seg = [A.x, A.y, A.z, B.x, B.y, B.z];
      if (e.soft) continue; // smooth edges stay hidden, selected or not
      if (active && this.selection.has(`e${id}`)) selEdgePos.push(...seg);
      (offE(id) ? offPos : m.facesOfEdge(id).length ? edgePos : linePos).push(...seg);
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
    addLines(offPos, fadedEdgeMat);
    if (selEdgePos.length) {
      const sel = new LineSegments2(new LineSegmentsGeometry().setPositions(selEdgePos), selEdgeMat);
      sel.raycast = () => {};
      sel.renderOrder = 5;
      sel.userData.noAO = true;
      this.group.add(sel);
    }
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
    // Saved before faces lost their own colour: the colour new faces got was a drawing setting.
    if (data && !data.materials?.some?.((m) => m?.id === DEFAULT_MATERIAL)) data = { ...data, newShapes: { color: read('interior-design.drawing.v1')?.color } };
    try { this.setData(data); } catch { this.root = new Mesh(); this.groups = new Map(); }
  }
}
