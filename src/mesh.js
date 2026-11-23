import * as THREE from 'three';

/*
 * Edges-and-faces geometry, SketchUp style ("sticky" geometry).
 *
 *   vertices: id → THREE.Vector3     (points closer than EPS are the same point)
 *   edges:    id → { a, b, soft?, curve? }
 *               soft  = hidden and smoothed across (the sides of a cylinder)
 *               curve = id shared by the segments of one drawn circle
 *   faces:    id → { loops: [outer, ...holes], color, material?, tex? }   (material: a material id, see model.js;
 *             tex: where the texture sits on this face: { offset: [x, y] m, rotation deg, size? }, see cleanTex)
 *               each loop = vertex ids; the outer loop runs counter-clockwise around the
 *               face normal, holes clockwise. Every pair of neighbouring loop vertices has an edge.
 *
 * Faces are flat. Everything that touches joins: drawing on a face splits it, closed loops
 * of edges on a plane become faces, and push/pull cleans up after itself (coplanar faces merge,
 * faces that meet back to back cancel out, which is how pushing through makes a hole).
 */

export const EPS = 1e-4; // 0.1 mm: points / planes closer than this are the same
// A pulled-up circle's sides are smoothed when neighbouring sides meet at less than this
// (so a 48-sided circle comes out round, a hexagon stays faceted).
export const AUTO_SMOOTH_DEG = 30;
const UP = new THREE.Vector3(0, 1, 0);
const X = new THREE.Vector3(1, 0, 0);

const edgeKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const round6 = (v) => Math.round(v * 1e6) / 1e6;

// --- planes -------------------------------------------------------------------------

/**
 * A plane with a 2D basis: u × v = n. On horizontal planes u = +X; on others u is
 * horizontal and v points up, so 2D coordinates match how people measure.
 */
export function makePlane(normal, point) {
  const n = normal.clone().normalize();
  let u;
  if (Math.abs(n.y) > 0.9) u = X.clone();
  else u = new THREE.Vector3().crossVectors(UP, n).normalize();
  u.addScaledVector(n, -u.dot(n)).normalize();
  const v = new THREE.Vector3().crossVectors(n, u);
  const d = n.dot(point);
  return {
    n, u, v, d,
    origin: n.clone().multiplyScalar(d),
    has(p, eps = EPS) { return Math.abs(n.dot(p) - d) < eps; },
    to2D(p) { return { x: p.dot(u), y: p.dot(v) }; },
    from2D(x, y) { return n.clone().multiplyScalar(d).addScaledVector(u, x).addScaledVector(v, y); },
    project(p) { return p.clone().addScaledVector(n, d - n.dot(p)); },
  };
}

export const GROUND = makePlane(UP, new THREE.Vector3());

const planeKey = (p) => {
  // Same plane either way round.
  let { x, y, z } = p.n;
  let d = p.d;
  if (x < -1e-9 || (Math.abs(x) <= 1e-9 && (y < -1e-9 || (Math.abs(y) <= 1e-9 && z < 0)))) { x = -x; y = -y; z = -z; d = -d; }
  const r = (v) => Math.round(v * 1e3);
  return `${r(x)},${r(y)},${r(z)},${Math.round(d * 1e3)}`;
};

// --- 2D helpers -----------------------------------------------------------------------

function area2D(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function insidePoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

const insideLoops = (pt, loops2D) => insidePoly(pt, loops2D[0]) && !loops2D.slice(1).some((h) => insidePoly(pt, h));

/** Triangles of a polygon with holes (2D points); indices into outer.concat(...holes). */
export function triangulate(outer, holes) {
  const v2 = (p) => new THREE.Vector2(p.x, p.y);
  try {
    return THREE.ShapeUtils.triangulateShape(outer.map(v2), holes.map((h) => h.map(v2)));
  } catch {
    return [];
  }
}

/** A point well inside a polygon with holes (centroid of its largest triangle). */
function interiorPoint(outer, holes) {
  const all = outer.concat(...holes);
  let best = null, bestA = 0;
  for (const [a, b, c] of triangulate(outer, holes)) {
    const A = Math.abs(area2D([all[a], all[b], all[c]]));
    if (A > bestA) { bestA = A; best = { x: (all[a].x + all[b].x + all[c].x) / 3, y: (all[a].y + all[b].y + all[c].y) / 3 }; }
  }
  return best;
}

/**
 * A face's texture placement, made valid: offset (m, along the texture's own width / height),
 * rotation (deg, on top of the material's) and, only if this face has its own, size ([w, h] m of
 * one repeat; without it the material's size applies, and follows the material). null when it's
 * all default (nothing to store).
 */
export function cleanTex(t) {
  if (!t || typeof t !== 'object') return null;
  const num = (v, d) => (Number.isFinite(v) ? v : d);
  const off = Array.isArray(t.offset) ? t.offset : [];
  const size = Array.isArray(t.size) && t.size.every((v) => Number.isFinite(v) && v > 0) ? t.size.map((v) => Math.max(0.01, v)) : null;
  const out = {
    offset: [num(off[0], 0), num(off[1], 0)],
    rotation: num(t.rotation, 0) % 360,
    ...(size ? { size } : {}),
  };
  const plain = Math.abs(out.offset[0]) < 1e-9 && Math.abs(out.offset[1]) < 1e-9 && Math.abs(out.rotation) < 1e-9 && !size;
  return plain ? null : out;
}

// --- the mesh --------------------------------------------------------------------------

export class Mesh {
  constructor() {
    this.vertices = new Map();
    this.edges = new Map();
    this.faces = new Map();
    this.keys = new Map(); // edgeKey → edge id
    this.nextId = 1;
    this._index = null;
  }

  changed() { this._index = null; }

  // --- data ---
  toData() {
    const idx = new Map();
    const vertices = [];
    for (const [id, p] of this.vertices) { idx.set(id, vertices.length); vertices.push([round6(p.x), round6(p.y), round6(p.z)]); }
    const edges = [...this.edges.values()].map((e) => {
      const out = [idx.get(e.a), idx.get(e.b)];
      if (e.soft || e.curve) out.push(e.soft ? 1 : 0);
      if (e.curve) out.push(e.curve);
      return out;
    });
    const faces = [...this.faces.values()].map((f) => ({ loops: f.loops.map((l) => l.map((v) => idx.get(v))), color: f.color, ...(f.material ? { material: f.material } : {}), ...(f.tex ? { tex: f.tex } : {}) }));
    return { vertices, edges, faces };
  }

  /** From saved data; invalid parts are skipped. Ids are assigned in order (faces too). */
  static fromData(data) {
    const m = new Mesh();
    const vids = [];
    for (const v of Array.isArray(data?.vertices) ? data.vertices : []) {
      if (!Array.isArray(v) || !v.slice(0, 3).every(Number.isFinite)) { vids.push(null); continue; }
      const id = m.nextId++;
      m.vertices.set(id, new THREE.Vector3(v[0], v[1], v[2]));
      vids.push(id);
    }
    const vid = (i) => (Number.isInteger(i) ? vids[i] ?? null : null);
    for (const e of Array.isArray(data?.edges) ? data.edges : []) {
      if (!Array.isArray(e)) continue;
      const a = vid(e[0]), b = vid(e[1]);
      if (a == null || b == null) continue;
      const id = m.addEdge(a, b);
      if (id == null) continue;
      if (e[2]) m.edges.get(id).soft = true;
      if (Number.isInteger(e[3]) && e[3] > 0) { m.edges.get(id).curve = e[3]; m.nextId = Math.max(m.nextId, e[3] + 1); }
    }
    for (const f of Array.isArray(data?.faces) ? data.faces : []) {
      if (!f || !Array.isArray(f.loops)) continue;
      const loops = f.loops.filter(Array.isArray).map((l) => l.map(vid));
      if (!loops.length || loops.some((l) => l.includes(null))) continue;
      const color = typeof f.color === 'string' && /^#[0-9a-f]{6}$/i.test(f.color) ? f.color : '#ffffff';
      m.addFace(loops, { color, material: typeof f.material === 'string' ? f.material : null, tex: f.tex });
    }
    m.splitCurves();
    return m;
  }

  clone() { return Mesh.fromData(this.toData()); }

  /**
   * One curve = one connected run of edges. Edges sharing a curve id but not connected
   * (e.g. a cylinder's top and bottom rims, from older versions) get separate ids.
   */
  splitCurves() {
    const byCurve = new Map();
    for (const [id, e] of this.edges) if (e.curve) { if (!byCurve.has(e.curve)) byCurve.set(e.curve, []); byCurve.get(e.curve).push(id); }
    for (const ids of byCurve.values()) {
      const left = new Set(ids);
      let first = true;
      while (left.size) {
        // Grow one connected run from any remaining edge.
        const start = left.values().next().value;
        left.delete(start);
        const run = [start];
        const verts = new Set([this.edges.get(start).a, this.edges.get(start).b]);
        for (let grew = true; grew;) {
          grew = false;
          for (const id of left) {
            const e = this.edges.get(id);
            if (verts.has(e.a) || verts.has(e.b)) { left.delete(id); run.push(id); verts.add(e.a); verts.add(e.b); grew = true; }
          }
        }
        if (!first) { const c = this.nextId++; for (const id of run) this.edges.get(id).curve = c; }
        first = false;
      }
    }
  }

  // --- basic edits ---
  /** Vertex at p (an existing one if within EPS). */
  addVertex(p) {
    for (const [id, q] of this.vertices) if (q.distanceToSquared(p) < EPS * EPS) return id;
    const id = this.nextId++;
    this.vertices.set(id, new THREE.Vector3(p.x, p.y, p.z));
    this.changed();
    return id;
  }

  edgeBetween(a, b) { return this.keys.get(edgeKey(a, b)) ?? null; }

  addEdge(a, b, props) {
    if (a === b) return null;
    const k = edgeKey(a, b);
    let id = this.keys.get(k);
    if (id == null) {
      id = this.nextId++;
      this.edges.set(id, { a, b, ...props });
      this.keys.set(k, id);
      this.changed();
    }
    return id;
  }

  deleteEdge(id) {
    const e = this.edges.get(id);
    if (!e) return;
    this.edges.delete(id);
    this.keys.delete(edgeKey(e.a, e.b));
    this.changed();
  }

  /**
   * Add a face. Loops are cleaned up and oriented to `normal` (default: the outer
   * loop's own winding). Missing edges are added. Returns the face id or null.
   */
  addFace(loops, { normal, color = '#ffffff', material = null, tex = null } = {}) {
    const clean = loops.map((l) => {
      const out = [];
      for (const v of l) if (out.at(-1) !== v) out.push(v);
      while (out.length > 1 && out[0] === out.at(-1)) out.pop();
      return out;
    });
    if (clean[0].length < 3) return null;
    const n = this.loopNormal(clean[0]);
    if (n.lengthSq() < 1e-12) return null;
    if (normal && n.dot(normal) < 0) { clean[0].reverse(); n.negate(); }
    for (let i = 1; i < clean.length; i++) if (clean[i].length < 3 || this.loopNormal(clean[i]).dot(n) > 0) clean[i].reverse();
    const fixed = [clean[0], ...clean.slice(1).filter((l) => l.length >= 3)];
    for (const l of fixed) for (let i = 0; i < l.length; i++) this.addEdge(l[i], l[(i + 1) % l.length]);
    const id = this.nextId++;
    const place = cleanTex(tex);
    this.faces.set(id, { loops: fixed, color, ...(material ? { material } : {}), ...(place ? { tex: place } : {}) });
    this.changed();
    return id;
  }

  deleteFace(id) { if (this.faces.delete(id)) this.changed(); }

  /** Turn faces around (their front becomes the back). */
  reverseFaces(ids) {
    for (const id of ids) {
      const f = this.faces.get(id);
      if (f) f.loops = f.loops.map((l) => [...l].reverse());
    }
    this.changed();
  }

  /** Newell normal (not normalised: length = 2 × area). */
  loopNormal(loop) {
    const n = new THREE.Vector3();
    for (let i = 0; i < loop.length; i++) {
      const p = this.vertices.get(loop[i]), q = this.vertices.get(loop[(i + 1) % loop.length]);
      n.x += (p.y - q.y) * (p.z + q.z);
      n.y += (p.z - q.z) * (p.x + q.x);
      n.z += (p.x - q.x) * (p.y + q.y);
    }
    return n;
  }

  faceNormal(id) { return this.loopNormal(this.faces.get(id).loops[0]).normalize(); }
  facePlane(id) { return makePlane(this.faceNormal(id), this.vertices.get(this.faces.get(id).loops[0][0])); }

  /** Face area (outer minus holes), m². */
  faceArea(id) {
    const [outer, ...holes] = this.faces.get(id).loops;
    return (this.loopNormal(outer).length() - holes.reduce((s, h) => s + this.loopNormal(h).length(), 0)) / 2;
  }

  edgeLength(id) {
    const e = this.edges.get(id);
    return this.vertices.get(e.a).distanceTo(this.vertices.get(e.b));
  }

  // --- adjacency ---
  /** { edgeFaces: edge id → face ids, vertexEdges: vertex id → edge ids } (cached until a change). */
  index() {
    if (this._index) return this._index;
    const edgeFaces = new Map();
    const vertexEdges = new Map();
    for (const id of this.edges.keys()) edgeFaces.set(id, []);
    for (const [id, e] of this.edges) {
      for (const v of [e.a, e.b]) {
        if (!vertexEdges.has(v)) vertexEdges.set(v, []);
        vertexEdges.get(v).push(id);
      }
    }
    for (const [fid, f] of this.faces) {
      for (const l of f.loops) {
        for (let i = 0; i < l.length; i++) {
          const eid = this.edgeBetween(l[i], l[(i + 1) % l.length]);
          if (eid != null) edgeFaces.get(eid).push(fid);
        }
      }
    }
    this._index = { edgeFaces, vertexEdges };
    return this._index;
  }

  facesOfEdge(id) { return this.index().edgeFaces.get(id) ?? []; }

  faceEdges(fid) {
    const out = [];
    for (const l of this.faces.get(fid).loops) {
      for (let i = 0; i < l.length; i++) {
        const e = this.edgeBetween(l[i], l[(i + 1) % l.length]);
        if (e != null) out.push(e);
      }
    }
    return out;
  }

  /** Split edge `id` at the given vertices (lying on it). Face loops get the new points too. */
  splitEdge(id, vids) {
    const e = this.edges.get(id);
    if (!e) return [id];
    const A = this.vertices.get(e.a), B = this.vertices.get(e.b);
    const dir = B.clone().sub(A);
    const pts = [...new Set(vids)].filter((v) => v !== e.a && v !== e.b)
      .sort((p, q) => this.vertices.get(p).clone().sub(A).dot(dir) - this.vertices.get(q).clone().sub(A).dot(dir));
    if (!pts.length) return [id];
    const chain = [e.a, ...pts, e.b];
    const { a, b, ...props } = e;
    this.deleteEdge(id);
    const pieces = [];
    for (let i = 0; i < chain.length - 1; i++) {
      const pid = this.addEdge(chain[i], chain[i + 1], props);
      if (pid != null) pieces.push(pid);
    }
    for (const f of this.faces.values()) {
      for (const l of f.loops) {
        for (let i = 0; i < l.length; i++) {
          const p = l[i], q = l[(i + 1) % l.length];
          if (p === a && q === b) { l.splice(i + 1, 0, ...pts); i += pts.length; }
          else if (p === b && q === a) { l.splice(i + 1, 0, ...[...pts].reverse()); i += pts.length; }
        }
      }
    }
    this.changed();
    return pieces;
  }

  /** Remove vertices without edges. */
  pruneVertices() {
    const used = new Set();
    for (const e of this.edges.values()) { used.add(e.a); used.add(e.b); }
    for (const id of [...this.vertices.keys()]) if (!used.has(id)) this.vertices.delete(id);
    this.changed();
  }

  /**
   * A vertex between exactly two collinear edges that border the same faces is
   * redundant: join the edges.
   */
  heal(vids) {
    for (const v of vids) {
      if (!this.vertices.has(v)) continue;
      const ve = this.index().vertexEdges.get(v) ?? [];
      if (ve.length !== 2) continue;
      const [e1, e2] = ve.map((id) => this.edges.get(id));
      const a = e1.a === v ? e1.b : e1.a, b = e2.a === v ? e2.b : e2.a;
      if (a === b) continue;
      const P = this.vertices.get(v);
      const da = this.vertices.get(a).clone().sub(P), db = this.vertices.get(b).clone().sub(P);
      if (da.clone().cross(db).length() > 1e-6 * da.length() * db.length() || da.dot(db) > 0) continue;
      const f1 = this.facesOfEdge(ve[0]), f2 = this.facesOfEdge(ve[1]);
      if (f1.length !== f2.length || f1.some((f) => !f2.includes(f))) continue;
      if (this.edgeBetween(a, b) != null) continue;
      const props = { tag: e1.tag ?? e2.tag };
      if (e1.soft && e2.soft) props.soft = true;
      if (e1.curve && e1.curve === e2.curve) props.curve = e1.curve;
      for (const fid of f1) {
        const f = this.faces.get(fid);
        f.loops = f.loops.map((l) => l.filter((x) => x !== v));
      }
      this.deleteEdge(ve[0]);
      this.deleteEdge(ve[1]);
      this.vertices.delete(v);
      this.addEdge(a, b, props);
      this.changed();
    }
  }

  /** Faces lying in `plane` (either way round). */
  facesIn(plane) {
    const out = [];
    for (const [id, f] of this.faces) {
      if (!f.loops[0].every((v) => plane.has(this.vertices.get(v)))) continue;
      if (Math.abs(this.faceNormal(id).dot(plane.n)) > 0.999) out.push(id);
    }
    return out;
  }

  // --- the heart: rebuild the faces of one plane ---
  /**
   * Recompute the faces of `plane` from all edges lying in it:
   *  - crossing / touching edges are split where they meet;
   *  - each closed region becomes a face if it was inside an existing face here
   *    (keeping its colour and side), unless faces back to back cover it (they cancel);
   *  - with `createFaces`, regions closed by one of `newEdges` become new faces;
   *  - edges in `dissolve` between two faces facing the same way are removed (faces merge).
   * Returns the ids of the faces now in the plane.
   */
  rebuildPlane(plane, { newEdges = new Set(), dissolve = new Set(), createFaces = false, color = '#ffffff', normal = null } = {}) {
    const onPlane = (v) => plane.has(this.vertices.get(v));
    const planeEdges = () => [...this.edges.keys()].filter((id) => { const e = this.edges.get(id); return onPlane(e.a) && onPlane(e.b); });
    const p2 = (v) => plane.to2D(this.vertices.get(v));

    // 1. Split edges where they cross or touch.
    {
      const list = planeEdges().map((id) => { const e = this.edges.get(id); return { id, a: e.a, b: e.b, A: p2(e.a), B: p2(e.b) }; });
      const splits = new Map();
      const addSplit = (id, v) => { if (!splits.has(id)) splits.set(id, new Set()); splits.get(id).add(v); };
      for (let i = 0; i < list.length; i++) {
        const E = list[i];
        const rx = E.B.x - E.A.x, ry = E.B.y - E.A.y;
        const rl = Math.hypot(rx, ry);
        if (rl < EPS) continue;
        for (let j = i + 1; j < list.length; j++) {
          const F = list[j];
          const sx = F.B.x - F.A.x, sy = F.B.y - F.A.y;
          const sl = Math.hypot(sx, sy);
          if (sl < EPS) continue;
          // Quick reject by bounding boxes.
          if (Math.max(E.A.x, E.B.x) < Math.min(F.A.x, F.B.x) - EPS || Math.max(F.A.x, F.B.x) < Math.min(E.A.x, E.B.x) - EPS) continue;
          if (Math.max(E.A.y, E.B.y) < Math.min(F.A.y, F.B.y) - EPS || Math.max(F.A.y, F.B.y) < Math.min(E.A.y, E.B.y) - EPS) continue;
          const denom = rx * sy - ry * sx;
          const qx = F.A.x - E.A.x, qy = F.A.y - E.A.y;
          if (Math.abs(denom) < 1e-9 * rl * sl) {
            // Parallel: if on one line, each splits the other at its end points.
            if (Math.abs(qx * ry - qy * rx) / rl > EPS) continue;
            for (const [G, H, gl] of [[E, F, rl], [F, E, sl]]) {
              const gx = (G.B.x - G.A.x) / gl, gy = (G.B.y - G.A.y) / gl;
              for (const [v, P] of [[H.a, H.A], [H.b, H.B]]) {
                const t = (P.x - G.A.x) * gx + (P.y - G.A.y) * gy;
                if (t > EPS && t < gl - EPS) addSplit(G.id, v);
              }
            }
            continue;
          }
          const t = (qx * sy - qy * sx) / denom;
          const u = (qx * ry - qy * rx) / denom;
          const tE = EPS / rl, tF = EPS / sl;
          if (t < -tE || t > 1 + tE || u < -tF || u > 1 + tF) continue;
          const inE = t > tE && t < 1 - tE, inF = u > tF && u < 1 - tF;
          if (!inE && !inF) continue;
          // The meeting point: an end point if it is one, else a new vertex.
          let v;
          if (!inE) v = t <= tE ? E.a : E.b;
          else if (!inF) v = u <= tF ? F.a : F.b;
          else v = this.addVertex(this.vertices.get(E.a).clone().lerp(this.vertices.get(E.b), t));
          if (inE) addSplit(E.id, v);
          if (inF) addSplit(F.id, v);
        }
      }
      for (const [id, vs] of splits) {
        const pieces = this.splitEdge(id, [...vs]);
        if (newEdges.has(id)) pieces.forEach((p) => newEdges.add(p));
        if (dissolve.has(id)) pieces.forEach((p) => dissolve.add(p));
      }
    }

    // Old faces here (their outlines decide which regions are faces).
    const oldFaces = this.facesIn(plane).map((id) => {
      const f = this.faces.get(id);
      return { id, color: f.color, material: f.material, tex: f.tex, side: Math.sign(this.faceNormal(id).dot(plane.n)), loops2D: f.loops.map((l) => l.map(p2)) };
    });
    // Edges also used by faces in other planes can't be dissolved.
    const usedElsewhere = (eid) => this.facesOfEdge(eid).some((fid) => !oldFaces.some((o) => o.id === fid));

    const removed = new Set(); // bridges / dangling edges (not region boundaries)
    const dissolved = new Set();
    let regions;
    for (let pass = 0; pass < 50; pass++) {
      // 2. Planar graph: outgoing half-edges per vertex, sorted by angle.
      const ids = planeEdges().filter((id) => !removed.has(id) && !dissolved.has(id));
      const out = new Map();
      const pos = new Map();
      for (const id of ids) {
        const e = this.edges.get(id);
        for (const [s, t] of [[e.a, e.b], [e.b, e.a]]) {
          if (!pos.has(s)) pos.set(s, p2(s));
          if (!pos.has(t)) pos.set(t, p2(t));
          if (!out.has(s)) out.set(s, []);
          out.get(s).push({ to: t, id });
        }
      }
      for (const [s, list] of out) {
        const P = pos.get(s);
        for (const h of list) { const Q = pos.get(h.to); h.angle = Math.atan2(Q.y - P.y, Q.x - P.x); }
        list.sort((p, q) => p.angle - q.angle);
      }
      // 3. Trace cycles (region on the left).
      const visited = new Set();
      const cycles = [];
      const halfOf = new Map(); // "s>t" → cycle index
      for (const [s, list] of out) {
        for (const h of list) {
          const k0 = `${s}>${h.to}`;
          if (visited.has(k0)) continue;
          const verts = [], edges = [];
          let from = s, cur = h;
          for (let guard = 0; guard < 100000; guard++) {
            const k = `${from}>${cur.to}`;
            if (visited.has(k)) break;
            visited.add(k);
            halfOf.set(k, cycles.length);
            verts.push(from);
            edges.push(cur.id);
            const at = out.get(cur.to);
            const back = at.findIndex((x) => x.to === from);
            const next = at[(back - 1 + at.length) % at.length];
            from = cur.to;
            cur = next;
          }
          cycles.push({ verts, edges, area: area2D(verts.map((v) => pos.get(v))) });
        }
      }
      // Edges with the same cycle on both sides don't bound a region: drop and retrace.
      let dropped = false;
      for (const id of ids) {
        const e = this.edges.get(id);
        if (halfOf.get(`${e.a}>${e.b}`) === halfOf.get(`${e.b}>${e.a}`)) { removed.add(id); dropped = true; }
      }
      if (dropped) continue;

      // 4. Regions: counter-clockwise cycles; clockwise ones are the outsides of
      //    connected groups, i.e. holes of the smallest region around them.
      const comp = new Map();
      const find = (v) => { while (comp.get(v) !== v) { comp.set(v, comp.get(comp.get(v))); v = comp.get(v); } return v; };
      for (const v of pos.keys()) comp.set(v, v);
      for (const id of ids) { const e = this.edges.get(id); comp.set(find(e.a), find(e.b)); }
      regions = [];
      const regionOfCycle = new Map();
      cycles.forEach((c, i) => {
        if (c.area > 1e-10) { regionOfCycle.set(i, regions.length); regions.push({ outer: c, holes: [], comp: find(c.verts[0]) }); }
      });
      cycles.forEach((c, i) => {
        if (c.area > 1e-10) return;
        const P = pos.get(c.verts[0]);
        const k = find(c.verts[0]);
        let best = null;
        for (const r of regions) {
          if (r.comp === k || r.outer.area < -c.area) continue;
          if (!insidePoly(P, r.outer.verts.map((v) => pos.get(v)))) continue;
          if (!best || r.outer.area < best.outer.area) best = r;
        }
        if (best) { best.holes.push(c); regionOfCycle.set(i, regions.indexOf(best)); }
      });
      // 5. Which regions are faces?
      for (const r of regions) {
        const outer2 = r.outer.verts.map((v) => pos.get(v));
        const holes2 = r.holes.map((h) => h.verts.map((v) => pos.get(v)));
        const pt = interiorPoint(outer2, holes2);
        r.side = 0;
        if (!pt) continue;
        const cover = oldFaces.filter((o) => insideLoops(pt, o.loops2D));
        if (cover.length) {
          if (cover.some((o) => o.side > 0) && cover.some((o) => o.side < 0)) continue; // back to back: cancel
          r.side = cover[0].side;
          r.color = cover[0].color;
          r.material = cover[0].material;
          r.tex = cover[0].tex;
        } else if (createFaces && r.outer.edges.some((id) => newEdges.has(id))) {
          r.side = normal && normal.dot(plane.n) < 0 ? -1 : 1;
          r.color = color;
        }
      }
      // 6. Dissolve edges between two faces facing the same way.
      let merged = false;
      for (const id of dissolve) {
        if (!ids.includes(id) || usedElsewhere(id)) continue;
        const e = this.edges.get(id);
        const r1 = regionOfCycle.get(halfOf.get(`${e.a}>${e.b}`));
        const r2 = regionOfCycle.get(halfOf.get(`${e.b}>${e.a}`));
        if (r1 == null || r2 == null || r1 === r2) continue;
        if (regions[r1].side && regions[r1].side === regions[r2].side) { dissolved.add(id); merged = true; }
      }
      if (!merged) break;
    }

    // 7. Replace the faces of this plane.
    for (const o of oldFaces) this.deleteFace(o.id);
    for (const id of dissolved) this.deleteEdge(id);
    const result = [];
    for (const r of regions ?? []) {
      if (!r.side) continue;
      const n = plane.n.clone().multiplyScalar(r.side);
      const fid = this.addFace([r.outer.verts, ...r.holes.map((h) => h.verts)], { normal: n, color: r.color, material: r.material, tex: r.tex });
      if (fid != null) result.push(fid);
    }
    return result;
  }

  /** Remove edges left without faces that weren't loose lines before (tag 'l'). */
  dropBareEdges() {
    for (const [id, e] of [...this.edges]) if (e.tag !== 'l' && !this.facesOfEdge(id).length) this.deleteEdge(id);
  }

  /** Mark edges before an operation: 'l' = loose line (kept), 'f' = face edge. */
  tagEdges() {
    for (const [id, e] of this.edges) e.tag = this.facesOfEdge(id).length ? 'f' : 'l';
  }

  untag() { for (const e of this.edges.values()) delete e.tag; }

  // --- drawing ---
  /**
   * Add a closed outline (3D points on `plane`), splitting faces it crosses and
   * filling the regions it closes. `curve`: mark the edges as one curve (circles).
   */
  addLoop(points, plane, { color, normal, curve = false } = {}) {
    const vids = points.map((p) => this.addVertex(plane.project(p)));
    const curveId = curve ? this.nextId++ : undefined;
    const newEdges = new Set();
    for (let i = 0; i < vids.length; i++) {
      const id = this.addEdge(vids[i], vids[(i + 1) % vids.length], curveId ? { curve: curveId } : undefined);
      if (id != null) newEdges.add(id);
    }
    return this.rebuildPlane(plane, { newEdges, createFaces: true, color, normal });
  }

  /**
   * Add one straight edge on `plane`. Returns true if it closed a region into a new face.
   */
  addSegment(p, q, plane, { color, normal } = {}) {
    const a = this.addVertex(plane.project(p)), b = this.addVertex(plane.project(q));
    const id = this.addEdge(a, b);
    if (id == null) return false;
    const area = () => this.facesIn(plane).reduce((s, f) => s + this.faceArea(f), 0);
    const before = area();
    this.rebuildPlane(plane, { newEdges: new Set([id]), createFaces: true, color, normal });
    return area() > before + 1e-6; // closed something new (splitting a face doesn't add area)
  }

  // --- push / pull ---
  /** Is the face part of something 3D (connected to faces in other planes)? */
  attached(fid) {
    const n0 = this.faceNormal(fid);
    const plane = this.facePlane(fid);
    const seen = new Set([fid]);
    const queue = [fid];
    while (queue.length) {
      const f = queue.pop();
      for (const e of this.faceEdges(f)) {
        for (const g of this.facesOfEdge(e)) {
          if (seen.has(g)) continue;
          const v0 = this.vertices.get(this.faces.get(g).loops[0][0]);
          if (Math.abs(this.faceNormal(g).dot(n0)) < 0.999 || !plane.has(v0)) return true;
          seen.add(g);
          queue.push(g);
        }
      }
    }
    return false;
  }

  /** Can this face be pushed / pulled? (Not the facets of a smooth, curved surface.) */
  canPushPull(fid) {
    return this.faces.has(fid) && !this.faceEdges(fid).some((e) => this.edges.get(e).soft);
  }

  /**
   * Push / pull face `fid` by `d` metres along its normal. A free-standing face stays
   * as the base and the new part grows from it; a face of a solid moves (pull out adds,
   * push in carves; pushing all the way through leaves a hole).
   */
  pushPull(fid, d) {
    if (!this.canPushPull(fid) || Math.abs(d) < 1e-3) return false;
    const face = this.faces.get(fid);
    const n = this.faceNormal(fid);
    const sign = Math.sign(d);
    const offset = n.clone().multiplyScalar(d);
    const attached = this.attached(fid);
    this.tagEdges();

    const loops = face.loops.map((l) => [...l]);
    const edgeProps = new Map(); // "a>b" (loop order) → { curve }
    for (const l of loops) for (let i = 0; i < l.length; i++) {
      const e = this.edges.get(this.edgeBetween(l[i], l[(i + 1) % l.length]));
      edgeProps.set(`${l[i]}>${l[(i + 1) % l.length]}`, e?.curve);
    }
    if (attached) this.deleteFace(fid);
    else {
      // Stays as the base, facing away from the new part.
      this.deleteFace(fid);
      this.addFace(loops, { normal: n.clone().multiplyScalar(-sign), color: face.color, material: face.material, tex: face.tex });
    }

    const moved = new Map();
    for (const l of loops) for (const v of l) if (!moved.has(v)) moved.set(v, this.addVertex(this.vertices.get(v).clone().add(offset)));

    // The moved copy of a curve is a curve of its own.
    const topCurves = new Map();
    const topCurve = (c) => { if (!topCurves.has(c)) topCurves.set(c, this.nextId++); return topCurves.get(c); };
    const touched = new Set();
    const planes = new Map();
    const addPlane = (fidNew) => { if (fidNew == null) return; const p = this.facePlane(fidNew); planes.set(planeKey(p), p); };
    for (const l of loops) {
      for (let i = 0; i < l.length; i++) {
        const a = l[i], b = l[(i + 1) % l.length];
        const A = this.vertices.get(a), B = this.vertices.get(b);
        const out = B.clone().sub(A).cross(n).normalize();
        if (attached) out.multiplyScalar(sign);
        const curve = edgeProps.get(`${a}>${b}`);
        const side = this.addFace([[a, b, moved.get(b), moved.get(a)]], { normal: out, color: face.color, material: face.material });
        addPlane(side);
        const top = this.edgeBetween(moved.get(a), moved.get(b));
        if (top != null && curve) this.edges.get(top).curve = topCurve(curve);
        for (const e of [this.edgeBetween(a, b), top, this.edgeBetween(a, moved.get(a))]) if (e != null) touched.add(e);
        // Between two segments of the same curve that meet at a shallow angle, the side is smooth.
        const before = l[(i - 1 + l.length) % l.length];
        const prev = edgeProps.get(`${before}>${a}`);
        const vert = this.edgeBetween(a, moved.get(a));
        if (vert != null && curve && prev === curve) {
          const d1 = A.clone().sub(this.vertices.get(before)).normalize(), d2 = B.clone().sub(A).normalize();
          const turn = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(d1.dot(d2), -1, 1)));
          if (turn < AUTO_SMOOTH_DEG - 0.01) this.edges.get(vert).soft = true; // (tolerance: exactly 30° stays faceted)
        }
      }
    }
    const capLoops = loops.map((l) => l.map((v) => moved.get(v)));
    const cap = this.addFace(capLoops, { normal: attached ? n : n.clone().multiplyScalar(sign), color: face.color, material: face.material, tex: face.tex });
    addPlane(cap);

    // Clean up: merge with coplanar neighbours, cancel faces that meet back to back.
    for (const p of planes.values()) this.rebuildPlane(p, { dissolve: touched });
    this.dropBareEdges();
    this.pruneVertices();
    this.heal([...moved.keys(), ...moved.values()]);
    this.untag();
    return true;
  }

  // --- deleting ---
  /**
   * Delete faces and edges. Deleting a face keeps its edges; deleting an edge removes
   * the faces it bounds, except between two coplanar faces, which merge instead.
   */
  erase(faceIds, edgeIds) {
    const ends = new Set();
    for (const eid of edgeIds) {
      const e = this.edges.get(eid);
      if (!e) continue;
      ends.add(e.a); ends.add(e.b);
      const fs = this.facesOfEdge(eid);
      if (fs.length === 2) {
        const [f, g] = fs;
        const pf = this.facePlane(f);
        if (this.faceNormal(f).dot(this.faceNormal(g)) > 0.999 && pf.has(this.vertices.get(this.faces.get(g).loops[0][0]))) {
          this.tagEdges();
          this.rebuildPlane(pf, { dissolve: new Set([eid]) });
          this.untag();
          if (!this.edges.has(eid)) continue;
        }
      }
      for (const f of this.facesOfEdge(eid)) this.deleteFace(f);
      this.deleteEdge(eid);
    }
    for (const f of faceIds) this.deleteFace(f);
    this.pruneVertices();
    this.heal([...ends]);
    this.pruneVertices();
  }

  // --- queries ---
  /** All faces and edges connected to the given ones (through shared vertices). */
  connected(faceIds, edgeIds) {
    const { vertexEdges } = this.index();
    const edges = new Set(edgeIds);
    for (const f of faceIds) this.faceEdges(f).forEach((e) => edges.add(e));
    const queue = [...edges];
    while (queue.length) {
      const id = queue.pop();
      const e = this.edges.get(id);
      const next = [...(vertexEdges.get(e.a) ?? []), ...(vertexEdges.get(e.b) ?? [])];
      // Through faces too: a hole's edges touch the rest only by the face around them (a box
      // with a hole cut through it is one thing).
      for (const f of this.facesOfEdge(id)) next.push(...this.faceEdges(f));
      for (const x of next) if (!edges.has(x)) { edges.add(x); queue.push(x); }
    }
    const faces = new Set();
    for (const e of edges) this.facesOfEdge(e).forEach((f) => faces.add(f));
    return { faces, edges };
  }

  /** Angle (degrees) between the two faces on an edge; null unless it has exactly two. */
  edgeAngle(eid) {
    const fs = this.facesOfEdge(eid);
    if (fs.length !== 2) return null;
    const d = THREE.MathUtils.clamp(this.faceNormal(fs[0]).dot(this.faceNormal(fs[1])), -1, 1);
    return THREE.MathUtils.radToDeg(Math.acos(d));
  }

  /**
   * Smooth the given edges where their two faces meet at less than `maxDeg` (hidden, shading
   * blends across); harden the rest. 0 = all hard.
   */
  setSmoothing(edgeIds, maxDeg) {
    for (const id of edgeIds) {
      const e = this.edges.get(id);
      if (!e) continue;
      const a = this.edgeAngle(id);
      if (a != null && a < maxDeg - 0.01) e.soft = true;
      else delete e.soft;
    }
    this.changed();
  }

  /** The edges of the curve (drawn circle) edge `eid` belongs to; just `eid` if none. */
  curveEdges(eid) {
    const curve = this.edges.get(eid)?.curve;
    if (!curve) return [eid];
    return [...this.edges].filter(([, e]) => e.curve === curve).map(([id]) => id);
  }

  // --- moving parts between meshes (groups) ---

  /**
   * Copy faces and edges (ids in this mesh) into mesh `dst`; points merge with dst's.
   * Edge looks (soft, curve) come along. Returns the new ids in dst: { faces, edges }.
   * `fresh`: new points even where dst already has one (a copy into the same mesh, kept apart).
   */
  copyInto(dst, faceIds, edgeIds, { fresh = false } = {}) {
    const vmap = new Map();
    const newVertex = (p) => { const id = dst.nextId++; dst.vertices.set(id, p.clone()); dst.changed(); return id; };
    const v = (id) => { if (!vmap.has(id)) vmap.set(id, fresh ? newVertex(this.vertices.get(id)) : dst.addVertex(this.vertices.get(id))); return vmap.get(id); };
    const cmap = new Map(); // curve ids are per mesh: give copied curves fresh ones
    const curveOf = (c) => { if (!cmap.has(c)) cmap.set(c, dst.nextId++); return cmap.get(c); };
    const faces = [], edges = new Set();
    const copyEdge = (eid) => {
      const e = this.edges.get(eid);
      if (!e) return;
      const ne = dst.addEdge(v(e.a), v(e.b));
      if (ne == null) return;
      const t = dst.edges.get(ne);
      if (e.soft) t.soft = true;
      if (e.curve) t.curve = curveOf(e.curve);
      edges.add(ne);
    };
    for (const fid of faceIds) {
      const f = this.faces.get(fid);
      if (!f) continue;
      const nf = dst.addFace(f.loops.map((l) => l.map(v)), { normal: this.faceNormal(fid), color: f.color, material: f.material, tex: f.tex });
      if (nf != null) faces.push(nf);
      this.faceEdges(fid).forEach(copyEdge);
    }
    edgeIds.forEach(copyEdge);
    dst.splitCurves();
    return { faces, edges: [...edges] };
  }

  /** Remove faces and edges, plus the edges of those faces left without any face. */
  removeParts(faceIds, edgeIds) {
    const touched = new Set();
    for (const f of faceIds) if (this.faces.has(f)) this.faceEdges(f).forEach((e) => touched.add(e));
    for (const f of faceIds) this.deleteFace(f);
    for (const e of edgeIds) this.deleteEdge(e);
    for (const e of touched) if (this.edges.has(e) && !this.facesOfEdge(e).length) this.deleteEdge(e);
    this.pruneVertices();
  }

  // --- make face ---

  /**
   * Groups of the given edges that could hold a face: connected, lying in one plane and
   * containing a closed loop. Returns [{ edges, plane }].
   */
  faceableGroups(edgeIds) {
    const left = new Set(edgeIds.filter((id) => this.edges.has(id)));
    const groups = [];
    while (left.size) {
      const start = left.values().next().value;
      left.delete(start);
      const edges = [start];
      const verts = new Set([this.edges.get(start).a, this.edges.get(start).b]);
      for (let grew = true; grew;) {
        grew = false;
        for (const id of left) {
          const e = this.edges.get(id);
          if (verts.has(e.a) || verts.has(e.b)) { left.delete(id); edges.push(id); verts.add(e.a); verts.add(e.b); grew = true; }
        }
      }
      if (edges.length < verts.size) continue; // a tree: no closed loop
      // A plane through three points that aren't on one line; every point must lie on it.
      const pts = [...verts].map((v) => this.vertices.get(v));
      let normal = null;
      for (let i = 2; i < pts.length && !normal; i++) {
        const n = pts[1].clone().sub(pts[0]).cross(pts[i].clone().sub(pts[0]));
        if (n.lengthSq() > 1e-10) normal = n.normalize();
      }
      if (!normal) continue;
      const plane = makePlane(normal, pts[0]);
      if (pts.every((p) => plane.has(p, 1e-3))) groups.push({ edges, plane });
    }
    return groups;
  }

  /**
   * Fill the closed loops among the given edges with faces (where there's none yet).
   * `towards`: a point the new faces should face (e.g. the camera). Returns the new face ids.
   */
  makeFaces(edgeIds, { color, towards } = {}) {
    const created = [];
    for (const { edges, plane } of this.faceableGroups(edgeIds)) {
      const before = new Set(this.facesIn(plane));
      const pt = this.vertices.get(this.edges.get(edges[0]).a);
      const normal = towards && plane.n.dot(towards.clone().sub(pt)) < 0 ? plane.n.clone().negate() : plane.n.clone();
      const area = () => this.facesIn(plane).reduce((s, f) => s + this.faceArea(f), 0);
      const a0 = area();
      const faces = this.rebuildPlane(plane, { newEdges: new Set(edges), createFaces: true, color, normal });
      if (area() > a0 + 1e-9) created.push(...faces.filter((f) => !before.has(f)));
    }
    return created;
  }

  // --- selection helpers (loops, rings, grow / shrink) ---

  /** In a four-sided face, the edge opposite edge `eid`; null for other faces. */
  quadOpposite(fid, eid) {
    const f = this.faces.get(fid), e = this.edges.get(eid);
    if (!f || !e || f.loops.length !== 1 || f.loops[0].length !== 4) return null;
    const l = f.loops[0];
    for (let i = 0; i < 4; i++) {
      const p = l[i], q = l[(i + 1) % 4];
      if ((p === e.a && q === e.b) || (p === e.b && q === e.a)) return this.edgeBetween(l[(i + 2) % 4], l[(i + 3) % 4]);
    }
    return null;
  }

  /**
   * Edge loop: for a face edge, the outline (loop) of the face it bounds that has the most
   * sides (a prism's cap rather than a side); on a tie the flattest face (a box's top).
   * For a loose line, the whole chain of lines it's part of; for an open border (an edge
   * with a face on one side only, e.g. where a face was deleted), the whole border.
   */
  edgeLoop(eid) {
    const e = this.edges.get(eid);
    if (!e) return [];
    const fs = this.facesOfEdge(eid);
    if (fs.length < 2) {
      // Follow the chain of edges like this one (same number of faces) through points where
      // exactly two of them meet.
      const { vertexEdges } = this.index();
      const kind = fs.length;
      const out = new Set([eid]);
      const queue = [eid];
      while (queue.length) {
        const cur = this.edges.get(queue.pop());
        for (const v of [cur.a, cur.b]) {
          const same = (vertexEdges.get(v) ?? []).filter((x) => this.facesOfEdge(x).length === kind);
          if (same.length !== 2) continue;
          for (const x of same) if (!out.has(x)) { out.add(x); queue.push(x); }
        }
      }
      return [...out];
    }
    const loopOf = (fid) => this.faces.get(fid).loops.find((l) => l.some((v, i) => {
      const w = l[(i + 1) % l.length];
      return (v === e.a && w === e.b) || (v === e.b && w === e.a);
    }));
    let best = null, bestKey = null;
    for (const fid of fs) {
      const l = loopOf(fid);
      if (!l) continue;
      const key = [l.length, Math.abs(this.faceNormal(fid).y)];
      if (!best || key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1] + 1e-6)) { best = l; bestKey = key; }
    }
    if (!best) return [eid];
    return best.map((v, i) => this.edgeBetween(v, best[(i + 1) % best.length])).filter((x) => x != null);
  }

  /** Edge ring: the edges across neighbouring four-sided faces, parallel to `eid`. */
  edgeRing(eid) {
    const out = new Set([eid]);
    const queue = [eid];
    while (queue.length) {
      const cur = queue.pop();
      for (const f of this.facesOfEdge(cur)) {
        const opp = this.quadOpposite(f, cur);
        if (opp != null && !out.has(opp)) { out.add(opp); queue.push(opp); }
      }
    }
    return [...out];
  }

  /**
   * Face loop: the strip of four-sided faces through face `fid`, crossing edge `eid` (one of
   * its edges) and the edge opposite it.
   */
  faceLoop(fid, eid) {
    const out = new Set([fid]);
    const opp = this.quadOpposite(fid, eid);
    if (opp == null) return [...out];
    for (const start of [eid, opp]) {
      let face = fid, cross = start;
      for (let guard = 0; guard < 10000; guard++) {
        const next = this.facesOfEdge(cross).filter((g) => g !== face);
        if (next.length !== 1 || out.has(next[0])) break;
        const g = next[0];
        const across = this.quadOpposite(g, cross);
        if (across == null) break;
        out.add(g);
        face = g;
        cross = across;
      }
    }
    return [...out];
  }

  /** The edge of face `fid` nearest to point `p` (on the face). */
  nearestEdgeOfFace(fid, p) {
    let best = null, bestD = Infinity;
    for (const id of this.faceEdges(fid)) {
      const e = this.edges.get(id);
      const d = new THREE.Line3(this.vertices.get(e.a), this.vertices.get(e.b)).closestPointToPoint(p, true, new THREE.Vector3()).distanceTo(p);
      if (d < bestD) { bestD = d; best = id; }
    }
    return best;
  }

  /** Grow: faces gain the faces next to them; edges gain the edges touching them. */
  grow(faceIds, edgeIds) {
    const faces = new Set(faceIds), edges = new Set(edgeIds);
    for (const f of faceIds) for (const e of this.faceEdges(f)) this.facesOfEdge(e).forEach((g) => faces.add(g));
    const { vertexEdges } = this.index();
    for (const id of edgeIds) {
      const e = this.edges.get(id);
      for (const v of [e.a, e.b]) (vertexEdges.get(v) ?? []).forEach((x) => edges.add(x));
    }
    return { faces, edges };
  }

  /** Shrink: drop the faces on the selection's border, and the edges at the ends of chains. */
  shrink(faceIds, edgeIds) {
    const fsel = new Set(faceIds), esel = new Set(edgeIds);
    const faces = new Set([...fsel].filter((f) => this.faceEdges(f).every((e) => this.facesOfEdge(e).every((g) => fsel.has(g)))));
    const { vertexEdges } = this.index();
    const selectedAt = (v) => (vertexEdges.get(v) ?? []).filter((x) => esel.has(x)).length;
    const edges = new Set([...esel].filter((id) => { const e = this.edges.get(id); return selectedAt(e.a) > 1 && selectedAt(e.b) > 1; }));
    return { faces, edges };
  }

  /** Faces joined to `fid` through soft edges (one smooth surface). */
  surface(fid) {
    const out = new Set([fid]);
    const queue = [fid];
    while (queue.length) {
      for (const e of this.faceEdges(queue.pop())) {
        if (!this.edges.get(e).soft) continue;
        for (const g of this.facesOfEdge(e)) if (!out.has(g)) { out.add(g); queue.push(g); }
      }
    }
    return out;
  }

  /** Triangles of a face as 3D points (flat list, 3 per triangle, wound along the normal). */
  faceTriangles(fid) {
    const f = this.faces.get(fid);
    const plane = this.facePlane(fid);
    const loops3 = f.loops.map((l) => l.map((v) => this.vertices.get(v)));
    const loops2 = loops3.map((l) => l.map((p) => plane.to2D(p)));
    const all3 = loops3.flat(), all2 = loops2.flat();
    const out = [];
    for (let [a, b, c] of triangulate(loops2[0], loops2.slice(1))) {
      if (area2D([all2[a], all2[b], all2[c]]) < 0) [b, c] = [c, b];
      out.push({ ids: [a, b, c].map((i) => f.loops.flat()[i]), pts: [all3[a], all3[b], all3[c]] });
    }
    return out;
  }
}

// --- older data -----------------------------------------------------------------------------

/**
 * Shapes / lines from version 3 files (extruded profiles) → edges and faces.
 * `profileOf(shape)` gives the shape's outline (XZ points, counter-clockwise from above).
 */
export function shapesToMesh(shapes, lines, profileOf) {
  const m = new Mesh();
  for (const s of shapes) {
    const P = profileOf(s);
    const base = s.base ?? 0, h = s.height ?? 0;
    const color = s.color;
    const at = (y) => P.map((p) => m.addVertex(new THREE.Vector3(p.x, y, p.z)));
    const curve = s.kind === 'circle' ? m.nextId++ : undefined; // bottom rim
    const topCurve = s.kind === 'circle' ? m.nextId++ : undefined;
    const bottom = at(base);
    if (h < 1e-6) {
      m.addFace([bottom], { normal: UP, color });
      if (curve) for (let i = 0; i < bottom.length; i++) m.edges.get(m.edgeBetween(bottom[i], bottom[(i + 1) % bottom.length])).curve = curve;
      continue;
    }
    const top = at(base + h);
    m.addFace([bottom], { normal: UP.clone().negate(), color });
    m.addFace([top], { normal: UP, color });
    const c = P.reduce((acc, p) => ({ x: acc.x + p.x / P.length, z: acc.z + p.z / P.length }), { x: 0, z: 0 });
    for (let i = 0; i < P.length; i++) {
      const j = (i + 1) % P.length;
      const p = P[i], q = P[j];
      let out = new THREE.Vector3(q.z - p.z, 0, -(q.x - p.x));
      const mid = new THREE.Vector3((p.x + q.x) / 2 - c.x, 0, (p.z + q.z) / 2 - c.z);
      if (s.kind === 'circle' && out.dot(mid) < 0) out.negate();
      m.addFace([[bottom[i], bottom[j], top[j], top[i]]], { normal: out, color });
      if (curve) {
        m.edges.get(m.edgeBetween(bottom[i], bottom[j])).curve = curve;
        m.edges.get(m.edgeBetween(top[i], top[j])).curve = topCurve;
        m.edges.get(m.edgeBetween(bottom[i], top[i])).soft = true;
      }
    }
  }
  for (const l of lines) {
    for (let i = 1; i < l.points.length; i++) {
      const a = m.addVertex(new THREE.Vector3(l.points[i - 1].x, l.points[i - 1].y, l.points[i - 1].z));
      const b = m.addVertex(new THREE.Vector3(l.points[i].x, l.points[i].y, l.points[i].z));
      m.addEdge(a, b);
    }
  }
  // Pieces that touch join up: coplanar neighbours merge, back-to-back faces cancel.
  m.tagEdges();
  const planes = new Map();
  for (const id of m.faces.keys()) { const p = m.facePlane(id); planes.set(planeKey(p), p); }
  const all = new Set(m.edges.keys());
  for (const p of planes.values()) m.rebuildPlane(p, { dissolve: all });
  m.dropBareEdges();
  m.pruneVertices();
  m.heal([...m.vertices.keys()]);
  m.untag();
  return m;
}
