import * as THREE from 'three';
import { Mesh, makePlane } from './mesh.js';

/*
 * Boolean operations on solids (closed groups): union, subtract, intersect.
 *
 * The faces are cut against each other with BSP trees (the classic csg.js method by Evan
 * Wallace), which gives many small coplanar pieces. Those are then put back together into
 * whole faces with the mesh's own planar rebuild (the same one drawing uses): the pieces
 * of a plane merge, edges between pieces disappear, real corners stay.
 * Faces keep their material; cut faces get the cutter's.
 */

const EPS = 1e-5;
const COPLANAR = 0, FRONT = 1, BACK = 2, SPANNING = 3;

class Plane {
  constructor(normal, w) { this.normal = normal; this.w = w; }
  clone() { return new Plane(this.normal.clone(), this.w); }
  flip() { this.normal.negate(); this.w = -this.w; }

  /** Sort `polygon` into the lists (splitting it if it spans the plane). */
  split(polygon, coFront, coBack, front, back) {
    let type = 0;
    const types = polygon.points.map((p) => {
      const t = this.normal.dot(p) - this.w;
      const k = t < -EPS ? BACK : t > EPS ? FRONT : COPLANAR;
      type |= k;
      return k;
    });
    if (type === COPLANAR) (this.normal.dot(polygon.plane.normal) > 0 ? coFront : coBack).push(polygon);
    else if (type === FRONT) front.push(polygon);
    else if (type === BACK) back.push(polygon);
    else {
      const f = [], b = [];
      const n = polygon.points.length;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n, ti = types[i], tj = types[j];
        const vi = polygon.points[i], vj = polygon.points[j];
        if (ti !== BACK) f.push(vi);
        if (ti !== FRONT) b.push(ti !== BACK ? vi.clone() : vi);
        if ((ti | tj) === SPANNING) {
          const t = (this.w - this.normal.dot(vi)) / this.normal.dot(vj.clone().sub(vi));
          const v = vi.clone().lerp(vj, t);
          f.push(v);
          b.push(v.clone());
        }
      }
      if (f.length >= 3) front.push(new Polygon(f, polygon.shared, polygon.plane));
      if (b.length >= 3) back.push(new Polygon(b, polygon.shared, polygon.plane));
    }
  }
}

class Polygon {
  /** `plane`: the plane it lies in (pieces keep their face's plane: no drift from rounding). */
  constructor(points, shared, plane) {
    this.points = points;
    this.shared = shared;
    this.plane = plane;
  }
  clone() { return new Polygon(this.points.map((p) => p.clone()), this.shared, this.plane.clone()); }
  flip() { this.points.reverse(); this.plane = this.plane.clone(); this.plane.flip(); }
}

class Node {
  constructor(polygons) {
    this.plane = null;
    this.front = null;
    this.back = null;
    this.polygons = [];
    if (polygons) this.build(polygons);
  }
  invert() {
    for (const p of this.polygons) p.flip();
    this.plane.flip();
    this.front?.invert();
    this.back?.invert();
    [this.front, this.back] = [this.back, this.front];
  }
  clipPolygons(polygons) {
    if (!this.plane) return polygons.slice();
    let front = [], back = [];
    for (const p of polygons) this.plane.split(p, front, back, front, back);
    if (this.front) front = this.front.clipPolygons(front);
    back = this.back ? this.back.clipPolygons(back) : [];
    return front.concat(back);
  }
  clipTo(bsp) {
    this.polygons = bsp.clipPolygons(this.polygons);
    this.front?.clipTo(bsp);
    this.back?.clipTo(bsp);
  }
  allPolygons() {
    return [...this.polygons, ...(this.front?.allPolygons() ?? []), ...(this.back?.allPolygons() ?? [])];
  }
  build(polygons) {
    if (!polygons.length) return;
    if (!this.plane) this.plane = polygons[0].plane.clone();
    const front = [], back = [];
    for (const p of polygons) this.plane.split(p, this.polygons, this.polygons, front, back);
    if (front.length) (this.front ??= new Node()).build(front);
    if (back.length) (this.back ??= new Node()).build(back);
  }
}

/** Is the mesh a closed solid (every edge of a face shared by exactly two faces)? */
export function isSolid(mesh) {
  if (!mesh.faces.size) return false;
  const count = new Map();
  for (const f of mesh.faces.values()) {
    for (const l of f.loops) {
      for (let i = 0; i < l.length; i++) {
        const a = l[i], b = l[(i + 1) % l.length];
        const k = a < b ? `${a}|${b}` : `${b}|${a}`;
        count.set(k, (count.get(k) ?? 0) + 1);
      }
    }
  }
  return [...count.values()].every((n) => n === 2);
}

/** The faces of a mesh as polygons (triangles of each face, all sharing the face's plane). */
function polygonsOf(mesh) {
  const out = [];
  for (const [fid, f] of mesh.faces) {
    const n = mesh.faceNormal(fid);
    const plane = new Plane(n.clone(), n.dot(mesh.vertices.get(f.loops[0][0])));
    const shared = { material: f.material ?? null, tex: f.tex ?? null };
    for (const tri of mesh.faceTriangles(fid)) {
      out.push(new Polygon(tri.pts.map((p) => p.clone()), shared, plane));
    }
  }
  return out;
}

function csg(op, aPolys, bPolys) {
  const a = new Node(aPolys), b = new Node(bPolys);
  if (op === 'union') {
    a.clipTo(b); b.clipTo(a); b.invert(); b.clipTo(a); b.invert();
    a.build(b.allPolygons());
  } else if (op === 'subtract') {
    a.invert(); a.clipTo(b); b.clipTo(a); b.invert(); b.clipTo(a); b.invert();
    a.build(b.allPolygons());
    a.invert();
  } else {
    a.invert(); b.clipTo(a); b.invert(); a.clipTo(b); b.clipTo(a);
    a.build(b.allPolygons());
    a.invert();
  }
  return a.allPolygons();
}

/**
 * `a` op `b` (meshes of closed solids) → a new Mesh, or null when nothing is left.
 * op: 'union' | 'subtract' (a minus b) | 'intersect'.
 */
export function booleanOp(a, b, op) {
  const polys = csg(op, polygonsOf(a), polygonsOf(b));
  const m = new Mesh();
  // Pieces → faces, grouped by plane (either way round) for the rebuild.
  const planes = [];
  const planeOf = (n, w) => {
    for (const p of planes) {
      const k = p.n.dot(n);
      if (Math.abs(k) > 1 - 1e-7 && Math.abs(p.w - w * Math.sign(k)) < 1e-5) return p;
    }
    const p = { n: n.clone(), w, faces: new Set() };
    planes.push(p);
    return p;
  };
  for (const poly of polys) {
    const ids = [];
    for (const q of poly.points) {
      const id = m.addVertex(q);
      if (ids.at(-1) !== id) ids.push(id);
    }
    while (ids.length > 1 && ids[0] === ids.at(-1)) ids.pop();
    if (new Set(ids).size < 3) continue;
    const n = poly.plane.normal;
    const fid = m.addFace([ids], { normal: n, material: poly.shared.material, tex: poly.shared.tex });
    if (fid != null) planeOf(n, poly.plane.w).faces.add(fid);
  }
  if (!m.faces.size) return null;

  // Merge the pieces of each plane into whole faces (edges between pieces of the same look go).
  for (const p of planes) {
    const pt = p.n.clone().multiplyScalar(p.w);
    const plane = makePlane(p.n, pt);
    const dissolve = new Set();
    for (const [eid, e] of m.edges) {
      if (!plane.has(m.vertices.get(e.a)) || !plane.has(m.vertices.get(e.b))) continue;
      const fs = m.facesOfEdge(eid).map((f) => m.faces.get(f));
      const look = (f) => `${f.material ?? ''}|${JSON.stringify(f.tex ?? null)}`;
      if (fs.length && fs.every((f) => look(f) === look(fs[0]))) dissolve.add(eid);
    }
    m.rebuildPlane(plane, { dissolve });
  }
  // Tidy up: no loose edges, no points in the middle of straight edges.
  for (const [eid] of m.edges) if (!m.facesOfEdge(eid).length) m.deleteEdge(eid);
  m.heal([...m.vertices.keys()]);
  m.pruneVertices();
  return m.faces.size ? m : null;
}
