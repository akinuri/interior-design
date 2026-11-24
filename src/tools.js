import * as THREE from 'three';
import { Mesh, GROUND, triangulate, makePlane, cleanTex } from './mesh.js';
import { t } from './i18n.js';
import { cm, formatLength, parseLength } from './units.js';

/** Typing into a text / number field or a dropdown (shortcuts stay out of the way)? Checkboxes, sliders and colour pickers don't count. */
const isTyping = (e) => !!e.target.closest?.('input:not([type="checkbox"]):not([type="range"]):not([type="color"]), select, textarea');

export const MIN_SIDES = 3;
export const MAX_SIDES = 360;

/*
 * Tools
 *  - select:   click a face or edge; double-click adds its neighbours (face → its edges,
 *              edge → its faces); triple-click selects everything connected. Drag a box:
 *              left to right = what's fully inside, right to left = what it touches.
 *              Ctrl = add, Shift = add / remove.
 *  - orbit:    left-drag turns the view; a click selects (as with Select).
 *  - pan:      left-drag slides the view; a click selects (as with Select).
 *  - line:     click points; each click adds an edge. Closing a loop makes a face;
 *              a line across a face splits it. Enter / double-click / right-click / Esc stops.
 *  - rect:     two opposite corners (click-click or drag). Shift = square.
 *  - circle:   centre, then radius (click-click or drag).
 *  - pushpull: grab a face and move it along its normal (drag, or click-move-click).
 *  - move:     move the selection (or what's clicked): click a point, then where it goes
 *              (or drag). Along the floor; ↑ toggles up / down; Shift (held) locks to X or Z,
 *              whichever it's closer to; → / ← lock to X / Z. Snaps to corners and measurement
 *              ends at any height; when locked, to where they line up with the axis.
 *  - rotate:   turn the selection (or what's clicked): click the centre (the protractor lies on
 *              the face under the mouse; ↑ / → / ← lock it to Y / X / Z), a point for the start
 *              direction, then the angle (15° steps; corners exact; type degrees). Or grab a
 *              handle on the bounding box: it turns about the axis square to that side.
 *  - offset:   on a face: a copy of its outline, inside (the face splits; holes grow) or outside
 *              (a ring face around it), through the mouse; type a distance. A double-click
 *              repeats the last offset on another face.
 *  - person:   place the person; drag while placing to set the facing direction.
 *
 * Drawing happens on the face under the cursor (any direction: floors, walls, tops),
 * or on the ground. While drawing / pushing, typing a value + Enter sets it exactly:
 *   line = length · rect = width;depth (or width,depth) · circle = radius · push/pull = distance,
 *   in cm (or with a unit: 2.5m, 25mm).
 * Circle sides: with the Circle tool, type a number before the first click (a pause starts
 * a new number), or a number + "s" while drawing (e.g. 12s, Enter).
 */

const CLICK_TOLERANCE_PX = 5;
const BLUE = 0x2a6df4;
const ALIGN_COLOR = 0xc026d3; // along / across an edge (inference)
const SNAP_COLORS = { cross: 0xe03131, vertex: 0xf28c28, mid: 0x18a6b8, edge: 0xd6336c, guide: 0xd6336c, face: 0x3a6fe8 };
const UP = new THREE.Vector3(0, 1, 0);
const AXES = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
// Axis colours, like the ground / side grid axes: X red, Y green, Z blue.
const AXIS_COLORS = { x: 0xe0453f, y: 0x36a84a, z: 0x3a6fe8 };

const round6 = (v) => Math.round(v * 1e6) / 1e6;
const ANGLE_STEP = Math.PI / 12; // Rotate tool: 15° steps (with snapping on)
/** The main axis key ('x' / 'y' / 'z') a direction runs along, or null. */
const axisKeyOf = (n) => ['x', 'y', 'z'].find((k) => Math.abs(n[k]) > 0.9999) ?? null;
const fmt = formatLength; // labels in the working unit (cm)

export function createTools({ getCamera, canvas, controls, scene, model, settings, person }) {
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  let tool = 'select';
  let plane = null; // drawing plane while a shape / line is in progress
  let hoverPlane = GROUND; // plane under the cursor (before drawing starts)
  let chain = []; // line tool: points (THREE.Vector3) of the current chain
  let anchor = null; // rect corner / circle centre (THREE.Vector3)
  let anchorPress = false; // anchor was set by the current press (so release = drag end, not 2nd click)
  let op = null; // push/pull in progress
  let mv = null; // move in progress: { base, targets: [{ p, orig }], exclude, delta, byPress }
  let moveVertical = false; // Move tool: ↑ toggles moving up / down instead of along the floor
  let moveAxis = null; // Move tool: 'x' / 'z' locked with → / ← (until toggled off or the move ends)
  let moveCopy = false; // Move tool: a tap on Ctrl toggles copying (the original stays; until the move ends)
  let ctrlTap = false; // Ctrl is down and nothing else happened since (so its release is a tap)
  // Rotate tool in progress: { phase: 'ref' (centre placed) | 'turn', center, axis, ref (unit, in the
  // plane), refPt, targets, guides, exclude, angle, byPress, copy }
  let rot = null;
  let rotAxis = null; // Rotate tool: 'x' / 'y' / 'z' locked with the arrows (until toggled off or the turn ends)
  let rotHoverAxis = UP.clone(); // Rotate tool, before the first click: the protractor's axis (face under the mouse)
  let rotBox = null; // Rotate tool, before starting: { keys, handles: [{ p, axis, center, ref, k }], edges: Vector3[] }
  let rotHandle = null; // the bounding box handle under the mouse
  let ofs = null; // Offset tool in progress: { fid, plane, loops (2D, ccw), curve, d (+ inside), result (3D loops), byPress, t0, x0, y0 }
  let lastOffset = null; // the last offset made (a double-click repeats it)
  let hover = null; // push/pull: face id under the cursor
  let cursor = null; // snapped point: THREE.Vector3 with .kind
  let typed = ''; // typed value (measurements box)
  let press = null; // { x, y, button } of the current mouse press
  let lastMoved = false; // the last press was a drag (so its click isn't a selection)
  let aiming = null; // person tool: placed point; drag sets facing
  let boxStart = null; // Select tool: where a selection box drag started { x, y } (client px)
  let shift = false;
  let measureLock = null; // Measure tool, Shift held: { dir, kind, axis } the line is locked to
  let lastPointer = null;
  const toolListeners = new Set();
  const stateListeners = new Set(); // busy / can-finish changes (touch action bar)
  const sidesListeners = new Set(); // circle side count changed
  let sidesTyped = ''; // Circle tool, before the first click: digits typed for the side count
  let sidesTimer = 0;

  // Measurement label anchor in world space (read by main's loop).
  const label = { pos: null, text: '' };

  // --- visuals ---
  const previewMat = new THREE.LineBasicMaterial({ color: BLUE, depthTest: false, transparent: true });
  const preview = new THREE.Line(new THREE.BufferGeometry(), previewMat);
  preview.renderOrder = 10;
  const fillMat = new THREE.MeshBasicMaterial({ color: BLUE, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false });
  const fill = new THREE.Mesh(new THREE.BufferGeometry(), fillMat);
  fill.renderOrder = 9;
  const hiMat = new THREE.MeshBasicMaterial({
    color: BLUE, transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const hiFill = new THREE.Mesh(new THREE.BufferGeometry(), hiMat);
  const hiLine = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: BLUE }));
  hiFill.renderOrder = hiLine.renderOrder = 8;
  const markerMat = new THREE.MeshBasicMaterial({ color: BLUE, depthTest: false, transparent: true, side: THREE.DoubleSide });
  const marker = new THREE.Mesh(new THREE.RingGeometry(0.07, 0.12, 32).rotateX(-Math.PI / 2), markerMat);
  marker.renderOrder = 11;
  // Measure from an edge: the guide that will be made (dashed, long).
  const guideMat = new THREE.LineDashedMaterial({ color: BLUE, dashSize: 0.1, gapSize: 0.08, depthTest: false, transparent: true, opacity: 0.8 });
  const guidePreview = new THREE.Line(new THREE.BufferGeometry(), guideMat);
  guidePreview.renderOrder = 10;
  // Snap points drawn as points, a fixed size on screen: square = corner, diamond = midpoint,
  // round = on an edge / face. `grips`: the corners and midpoints the Move tool can grab.
  const shapeTexture = (shape) => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    g.beginPath();
    if (shape === 'ex') { // an X: where lines cross
      g.lineCap = 'round';
      for (const [w, col] of [[16, '#1b1b1b'], [8, '#fff']]) {
        g.lineWidth = w;
        g.strokeStyle = col;
        g.beginPath(); g.moveTo(14, 14); g.lineTo(50, 50); g.moveTo(50, 14); g.lineTo(14, 50); g.stroke();
      }
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    }
    if (shape === 'ring') { // a rotate handle: a ring, white so it takes the axis colour
      g.arc(32, 32, 17, 0, Math.PI * 2);
      for (const [w, col] of [[16, '#1b1b1b'], [8, '#fff']]) { g.lineWidth = w; g.strokeStyle = col; g.stroke(); }
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    }
    if (shape === 'square') g.rect(14, 14, 36, 36);
    else if (shape === 'diamond') { g.moveTo(32, 8); g.lineTo(56, 32); g.lineTo(32, 56); g.lineTo(8, 32); g.closePath(); }
    else if (shape === 'cross') {
      // A thin plus with a dark outline: a point that isn't a corner etc. (free, grid, along a line).
      g.lineCap = 'round';
      for (const [w, col] of [[10, '#1b1b1b'], [4, '#fff']]) {
        g.lineWidth = w;
        g.strokeStyle = col;
        g.beginPath(); g.moveTo(32, 6); g.lineTo(32, 58); g.moveTo(6, 32); g.lineTo(58, 32); g.stroke();
      }
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    } else g.arc(32, 32, 20, 0, Math.PI * 2);
    g.fillStyle = '#fff';
    g.fill();
    g.lineWidth = 7;
    g.strokeStyle = '#1b1b1b';
    g.stroke();
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  };
  const SHAPES = { square: shapeTexture('square'), diamond: shapeTexture('diamond'), round: shapeTexture('round'), cross: shapeTexture('cross'), ex: shapeTexture('ex'), ring: shapeTexture('ring') };
  const shapeOf = (kind) => (kind === 'vertex' ? 'square' : kind === 'mid' ? 'diamond' : kind === 'cross' ? 'ex' : 'round');
  const pointsObj = (size, opacity = 1) => {
    const o = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({
      size, sizeAttenuation: false, map: SHAPES.square, transparent: true, opacity, depthTest: false, alphaTest: 0.1,
    }));
    o.renderOrder = 12;
    o.frustumCulled = false;
    return o;
  };
  const gripCorners = pointsObj(10, 0.95); // the grab points (Move tool), in the snap colours
  gripCorners.material.color.set(0xf28c28);
  const gripMids = pointsObj(10, 0.95);
  gripMids.material.map = SHAPES.diamond;
  gripMids.material.color.set(0x18a6b8);
  const snapDot = pointsObj(15); // the point snapped to (the cursor)
  snapDot.renderOrder = 13;
  const crossDot = pointsObj(20, 0.7); // the cursor elsewhere: a see-through cross
  crossDot.material.map = SHAPES.cross;
  crossDot.renderOrder = 13;
  let grips = null; // { corners: Vector3[], mids: Vector3[] }: Move tool, before grabbing
  // Rotate tool: the protractor (a unit circle with a tick every 15°, around +Z; placed, turned and
  // scaled to a fixed size on screen), the bounding box and its handles (in the axis colours).
  const protractor = (() => {
    const pos = [];
    const at = (a, r) => [Math.cos(a) * r, Math.sin(a) * r, 0];
    for (let i = 0; i < 72; i++) pos.push(...at((i / 72) * Math.PI * 2, 1), ...at(((i + 1) / 72) * Math.PI * 2, 1));
    for (let i = 0; i < 24; i++) pos.push(...at(i * ANGLE_STEP, i % 6 ? 0.86 : 0.7), ...at(i * ANGLE_STEP, 1));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const o = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: BLUE, depthTest: false, transparent: true, opacity: 0.9 }));
    o.renderOrder = 11;
    o.frustumCulled = false;
    return o;
  })();
  const rotBoxLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: BLUE, depthTest: false, transparent: true, opacity: 0.45 }));
  rotBoxLines.renderOrder = 10;
  const rotHandles = pointsObj(13, 0.95);
  rotHandles.material.map = SHAPES.ring;
  rotHandles.material.color.set(BLUE);
  const rotHandleHi = pointsObj(19);
  rotHandleHi.material.map = SHAPES.ring;
  rotHandleHi.material.color.set(BLUE);
  rotHandleHi.renderOrder = 13;
  const offsetLines = new THREE.LineSegments(new THREE.BufferGeometry(), previewMat); // Offset tool: the new outline(s)
  offsetLines.renderOrder = 10;
  const helpers = [preview, fill, hiFill, hiLine, marker, guidePreview, gripCorners, gripMids, snapDot, crossDot, protractor, rotBoxLines, rotHandles, rotHandleHi, offsetLines];

  // Selection box (Select tool): solid = fully inside (dragged left to right), dashed = touching.
  const boxEl = document.createElement('div');
  boxEl.className = 'select-box';
  boxEl.hidden = true;
  canvas.parentElement.append(boxEl);
  // Overlays: not pickable, and kept out of the AO pass (it would shade them like solid surfaces).
  for (const h of helpers) { h.visible = false; h.raycast = () => {}; h.userData.noAO = true; scene.add(h); }

  const setPoints = (obj, pts) => { obj.geometry.dispose(); obj.geometry = new THREE.BufferGeometry().setFromPoints(pts); };

  /** Slightly in front of the plane, so previews / highlights draw over the faces there. */
  const liftOf = () => 0.003;

  /** Triangulated fill for a polygon on `p`. */
  function fillGeometry(pts, p) {
    const tris = triangulate(pts.map((q) => p.to2D(q)), []);
    return new THREE.BufferGeometry().setFromPoints(tris.flat().map((i) => pts[i]));
  }

  // --- picking & snapping ---
  function setRay(e) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, getCamera());
  }

  function rayToPlane(e, p) {
    setRay(e);
    const hit = raycaster.ray.intersectPlane(new THREE.Plane(p.n, -p.d), new THREE.Vector3());
    return hit ? p.project(hit) : null;
  }

  /** Drawing plane under the cursor: the face there, else the ground. */
  function planeUnder(e) {
    setRay(e);
    const hit = model.pickFace(raycaster);
    return hit ? hit.mesh.facePlane(hit.face) : GROUND; // a group's face too (the drawing stays outside it)
  }

  /**
   * Snap a point on plane `p` (SketchUp-like inference), in order: corners (and where guides
   * cross edges / other guides), midpoints, on an edge or guide, along an axis from `from`
   * (line / measure), the grid. The result is a Vector3 with `kind` (and `edge` / `axis`).
   */
  /**
   * Where lines cross (in 3D): guides with guides and with edges, and edges of different
   * objects / groups (edges of one object are split where they cross already).
   * `skip(A, B)`: leave out edges (e.g. ones that are moving). Cached while nothing changes.
   */
  let crossCache = null;
  model.onChange(() => { crossCache = null; });
  function crossings(skip = null) {
    if (!skip && crossCache) return crossCache;
    const lines = [];
    for (const g of model.guides) lines.push({ A: g.p, d: g.d.clone().normalize(), len: Infinity, owner: null });
    for (const m of model.meshes) {
      for (const ed of m.edges.values()) {
        if (ed.soft) continue;
        const A = m.vertices.get(ed.a), B = m.vertices.get(ed.b);
        if (skip?.(A, B)) continue;
        const d = B.clone().sub(A), len = d.length();
        if (len > 1e-6) lines.push({ A, d: d.divideScalar(len), len, owner: m });
      }
    }
    const out = [];
    const w = new THREE.Vector3();
    for (let i = 0; i < lines.length; i++) {
      const a = lines[i];
      for (let j = i + 1; j < lines.length; j++) {
        const b = lines[j];
        if (a.owner && a.owner === b.owner) continue;
        const k = a.d.dot(b.d), den = 1 - k * k;
        if (den < 1e-9) continue; // parallel
        w.copy(a.A).sub(b.A);
        const dd = a.d.dot(w), ee = b.d.dot(w);
        const s = (k * ee - dd) / den, t = (ee - k * dd) / den;
        if (s < -1e-6 || s > a.len + 1e-6 || t < -1e-6 || t > b.len + 1e-6) continue;
        const P = a.A.clone().addScaledVector(a.d, s);
        if (P.distanceToSquared(b.A.clone().addScaledVector(b.d, t)) > 1e-8) continue;
        // An edge's own end (a corner): that's a corner already.
        if ((a.owner && (s < 1e-6 || s > a.len - 1e-6)) || (b.owner && (t < 1e-6 || t > b.len - 1e-6))) continue;
        out.push(P);
      }
    }
    if (!skip) crossCache = out;
    return out;
  }

  /** Ends of measurements and of labelled guides' reference lines: points to snap to. */
  function notePoints() {
    const out = [];
    for (const ms of model.measurements) out.push(ms.a, ms.b);
    for (const g of model.guides) {
      if (!g.from) continue;
      const foot = g.p.clone().addScaledVector(g.d, g.from.clone().sub(g.p).dot(g.d) / g.d.lengthSq());
      out.push(g.from, foot);
    }
    return out;
  }

  /**
   * The corner (geometry point or measurement end, at any height) nearest to the mouse on
   * screen, within a few px; null if none (or snapping is off).
   */
  function screenSnap(e, exclude = null, px = 14) {
    if (!settings.snapping) return null;
    const cam = getCamera();
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    let best = null, bestD = px;
    const pts = [...model.meshes.flatMap((m) => [...m.vertices.values()]), ...notePoints()];
    const v = new THREE.Vector3();
    const near = (q) => {
      v.copy(q).project(cam);
      if (v.z < -1 || v.z > 1) return Infinity;
      return Math.hypot((v.x + 1) / 2 * r.width - mx, (1 - v.y) / 2 * r.height - my);
    };
    for (const q of pts) {
      if (exclude?.has(q)) continue;
      const d = near(q);
      if (d < bestD) { bestD = d; best = Object.assign(q.clone(), { kind: 'vertex' }); }
    }
    for (const q of exclude ? mv?.crossPts ?? [] : crossings()) {
      const d = near(q);
      if (d < bestD) { bestD = d; best = Object.assign(q.clone(), { kind: 'cross' }); }
    }
    if (best) return best;
    // Then midpoints of edges (straight ones, not moving).
    bestD = px * 0.85;
    for (const m of model.meshes) {
      for (const ed of m.edges.values()) {
        if (ed.soft || ed.curve) continue;
        const A = m.vertices.get(ed.a), B = m.vertices.get(ed.b);
        if (exclude?.has(A) || exclude?.has(B)) continue;
        const mid = A.clone().add(B).multiplyScalar(0.5);
        const d = near(mid);
        if (d < bestD) { bestD = d; best = Object.assign(mid, { kind: 'mid' }); }
      }
    }
    return best;
  }

  function snap(raw, p, from, exclude = null) {
    if (!settings.snapping) return Object.assign(p.project(raw), { kind: 'free' }); // snapping off
    const cam = getCamera();
    // Snap radius grows with distance so it feels the same at any zoom.
    const r = THREE.MathUtils.clamp(0.012 * cam.position.distanceTo(raw), 0.05, 0.6);
    const meshes = model.snapMeshes;
    const at = (q, kind, extra) => Object.assign(p.project(q), { kind }, extra);

    // Lines on this plane: edges, and guides (infinite).
    const segs = [];
    for (const m of meshes) {
      for (const e of m.edges.values()) {
        if (e.soft) continue;
        const A = m.vertices.get(e.a), B = m.vertices.get(e.b);
        if (exclude && (exclude.has(A) || exclude.has(B))) continue;
        if (p.has(A, 1e-3) && p.has(B, 1e-3)) segs.push({ A, B });
      }
    }
    const guides = model.guides.filter((g) => p.has(g.p, 1e-3) && Math.abs(g.d.dot(p.n)) < 1e-6)
      .map((g) => ({ A: g.p, B: g.p.clone().add(g.d), guide: true }));

    // Corners: points of the geometry and of the shape being drawn; then where lines cross
    // (guides, edges of other objects), on this plane.
    const points = [...meshes.flatMap((m) => [...m.vertices.values()]), ...notePoints(), ...chain, ...(anchor ? [anchor] : [])]
      .filter((v) => p.has(v, 1e-3) && !exclude?.has(v));
    const crosses = (exclude ? mv?.crossPts ?? [] : crossings()).filter((v) => p.has(v, 1e-3));
    let best = null, bestD = r, bestKind = 'vertex';
    for (const [list, kind] of [[points, 'vertex'], [crosses, 'cross']]) {
      for (const v of list) {
        const d = v.distanceTo(raw);
        if (d < bestD - 1e-9) { bestD = d; best = v; bestKind = kind; }
      }
    }
    if (best) return at(best, bestKind);
    // Midpoints (of edges), then anywhere on an edge or a guide.
    bestD = r * 0.8;
    for (const { A, B } of segs) {
      const mid = A.clone().add(B).multiplyScalar(0.5);
      const d = mid.distanceTo(raw);
      if (d < bestD) { bestD = d; best = mid; }
    }
    if (best) return at(best, 'mid');
    bestD = r * 0.6;
    let bestLine = null;
    for (const l of [...segs, ...guides]) {
      const q = new THREE.Line3(l.A, l.B).closestPointToPoint(raw, !l.guide, new THREE.Vector3());
      const d = q.distanceTo(raw);
      if (d < bestD) { bestD = d; best = q; bestLine = l; }
    }
    if (best) return at(best, bestLine.guide ? 'guide' : 'edge', { edge: [bestLine.A, bestLine.B] });

    const step = settings.snap;
    // Along an axis from the start point (line / measure), when the direction is close to one.
    if (from && (tool === 'measure' || (tool === 'line' && !shift))) { // (measure + Shift: this is what gets locked)
      const d = raw.clone().sub(from);
      const len = d.length();
      if (len > 1e-6) {
        for (const [axis, dir] of [['x', AXES.x], ['y', AXES.y], ['z', AXES.z]]) {
          const along = d.dot(dir);
          if (Math.abs(along) / len < Math.cos(THREE.MathUtils.degToRad(4))) continue;
          if (tool === 'line' && Math.abs(dir.dot(p.n)) > 1e-6) continue; // a line stays on its plane
          const l = step ? Math.round(along / step) * step : along;
          return Object.assign(from.clone().addScaledVector(dir, round6(l)), { kind: 'axis', axis, dir: dir.clone() });
        }
        // Along an edge on this surface, or square to one (∥ / ⊥).
        const dirs = [];
        for (const { A, B } of segs) {
          const e = B.clone().sub(A).normalize();
          for (const [kind, dir] of [['parallel', e], ['perp', new THREE.Vector3().crossVectors(p.n, e).normalize()]]) {
            if (dir.lengthSq() < 0.5) continue;
            if (Object.values(AXES).some((a) => Math.abs(a.dot(dir)) > 0.9999)) continue; // an axis: done above
            if (!dirs.some((x) => Math.abs(x.dir.dot(dir)) > 0.9999)) dirs.push({ kind, dir });
          }
        }
        for (const { kind, dir } of dirs) {
          const along = d.dot(dir);
          if (Math.abs(along) / len < Math.cos(THREE.MathUtils.degToRad(3))) continue;
          const l = step ? Math.round(along / step) * step : along;
          return Object.assign(from.clone().addScaledVector(dir, round6(l)), { kind, dir: dir.clone() });
        }
      }
    }
    const c = p.to2D(raw);
    if (from && shift && tool === 'line') {
      const f = p.to2D(from);
      const ang = Math.round(Math.atan2(c.y - f.y, c.x - f.x) / (Math.PI / 4)) * (Math.PI / 4);
      let len = Math.hypot(c.x - f.x, c.y - f.y);
      if (step) len = Math.round(len / step) * step;
      return at(p.from2D(round6(f.x + Math.cos(ang) * len), round6(f.y + Math.sin(ang) * len)), 'angle');
    }
    if (!step) return at(raw, 'free');
    return at(p.from2D(round6(Math.round(c.x / step) * step), round6(Math.round(c.y / step) * step)), 'grid');
  }

  const drawing = () => chain.length > 0 || !!anchor;
  const isDrawTool = () => tool === 'line' || tool === 'rect' || tool === 'circle' || tool === 'measure';

  function updateCursor(e) {
    cursor = null;
    if (tool === 'person') {
      // On the floor-like surface under the cursor (a platform, a raised floor), else the ground.
      setRay(e);
      const hit = model.pickFace(raycaster);
      if (hit && Math.abs(hit.normal.y) > 0.7) cursor = Object.assign(hit.point.clone(), { kind: 'free' });
      else {
        const raw = rayToPlane(e, GROUND);
        if (raw) cursor = Object.assign(raw, { kind: 'free' });
      }
    } else if (isDrawTool()) {
      // (Measure: the plane under the cursor each time, so points can be on different faces.)
      hoverPlane = (tool === 'measure' ? null : plane) ?? planeUnder(e);
      const raw = rayToPlane(e, hoverPlane);
      if (raw) cursor = snap(raw, hoverPlane, tool === 'line' ? chain.at(-1) : tool === 'measure' ? anchor : null);
      // The lock stays after Shift is let go (to type a distance, to look for a point): until
      // the mouse is waved well away from the locked line, Shift is pressed again, or the
      // measurement ends.
      if (measureLock && !shift && !typed && anchor && lockWavedAway(e)) measureLock = null;
      if (cursor && tool === 'measure' && anchor && (shift || measureLock)) {
        // Shift: lock the direction it's on (an axis, along / across an edge); with none, the
        // main axis (X, Y or Z) it's closest to. Then corners etc. project onto that line.
        if (!measureLock) {
          if (cursor.dir) measureLock = { dir: cursor.dir.clone(), kind: cursor.kind, axis: cursor.axis };
          else {
            const d = cursor.clone().sub(anchor);
            const axis = ['x', 'y', 'z'].reduce((best, k) => (Math.abs(d[k]) > Math.abs(d[best]) ? k : best), 'x');
            measureLock = { dir: AXES[axis].clone(), kind: 'axis', axis };
          }
        }
        const { dir, kind, axis } = measureLock;
        // On a snapped point (a corner...): where it lines up. Else: the point of the line
        // nearest the mouse (on screen), not where the mouse meets the surface.
        let t = cursor.clone().sub(anchor).dot(dir);
        if (!marksPlace(cursor)) {
          // (The plane through the line that faces the camera most: where the mouse meets it.)
          setRay(e);
          const view = raycaster.ray.direction;
          const n = new THREE.Vector3().crossVectors(dir, view).cross(dir);
          const q = n.lengthSq() > 1e-10 ? raycaster.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(n.normalize(), anchor), new THREE.Vector3()) : null;
          if (q) t = q.sub(anchor).dot(dir);
          if (settings.snapping && settings.snap) t = Math.round(t / settings.snap) * settings.snap;
        }
        cursor = Object.assign(anchor.clone().addScaledVector(dir, t), { kind, axis, dir: dir.clone(), locked: true });
      }
    } else if (tool === 'move') {
      if (mv) updateMove(e);
      else {
        // The point to move from: one of the grips (corners / midpoints of what would move)
        // near the mouse; else snapped like drawing, on the surface under the cursor.
        // (Off the object but still near one of its grips, e.g. reaching for an outer corner:
        // keep them.)
        const next = gripsOf(e);
        const keep = !next.corners.length && grips && nearestOnScreen(e, [...grips.corners, ...grips.mids].map((q) => [q]), 24);
        if (!keep) grips = next;
        const g = nearestOnScreen(e, [...grips.corners.map((q) => [q, 'vertex']), ...grips.mids.map((q) => [q, 'mid'])], 18);
        hoverPlane = planeUnder(e);
        // Looking nearly level (front / side views) at empty space: the ground is seen edge-on,
        // so grab on the upright plane facing the camera (through the selection's middle).
        const view = getCamera().getWorldDirection(new THREE.Vector3());
        if (hoverPlane === GROUND && Math.abs(view.y) <= 0.26) {
          const box = new THREE.Box3();
          for (const t of model.selection.size ? moveTargets() : []) box.expandByPoint(t.p);
          hoverPlane = makePlane(Math.abs(view.x) > Math.abs(view.z) ? AXES.x : AXES.z, box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3()));
        }
        if (g) cursor = Object.assign(g[0].clone(), { kind: g[1] });
        else {
          const raw = rayToPlane(e, hoverPlane);
          if (raw) cursor = snap(raw, hoverPlane, null);
        }
      }
    } else if (tool === 'rotate') {
      updateRotateCursor(e);
    } else if (tool === 'offset') {
      if (ofs) updateOffset(e);
      else {
        setRay(e);
        const hit = model.pickFace(raycaster);
        hover = hit && hit.group == null && hit.mesh === model.mesh ? hit.face : null; // not a closed group's
      }
    } else if (tool === 'pushpull') {
      if (op) updateOp(e);
      else {
        setRay(e);
        const hit = model.pickFace(raycaster);
        hover = hit && hit.group == null && model.mesh.canPushPull(hit.face) ? hit.face : null; // not a closed group's
      }
    }
  }

  // --- shapes from the current input ---
  function rectCorners(a, c, p = plane) {
    const A = p.to2D(a), C = p.to2D(c);
    let dx = C.x - A.x, dy = C.y - A.y;
    if (shift) { const s = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * s; dy = Math.sign(dy || 1) * s; }
    return [[0, 0], [dx, 0], [dx, dy], [0, dy]].map(([x, y]) => p.from2D(round6(A.x + x), round6(A.y + y)));
  }

  function circlePoints(center, radius, p = plane) {
    const pts = [];
    const n = settings.circleSides;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      pts.push(center.clone().addScaledVector(p.u, Math.cos(a) * radius).addScaledVector(p.v, Math.sin(a) * radius));
    }
    return pts;
  }

  // --- preview ---
  function setLabel(pos, text) {
    label.pos = pos;
    label.text = typed ? `${typed}▏` : text;
  }

  /** Draw the snapped-to point: its shape (corner / midpoint / edge) in its colour. */
  function showSnapDot(q, kind) {
    snapDot.geometry.setFromPoints([q]);
    snapDot.material.map = SHAPES[shapeOf(kind)];
    snapDot.material.color.set(SNAP_COLORS[kind] ?? BLUE);
    snapDot.material.needsUpdate = true;
    snapDot.visible = true;
  }

  function updatePreview() {
    for (const h of helpers) h.visible = false;
    label.pos = null;
    const p = plane ?? hoverPlane;
    const lift = p.n.clone().multiplyScalar(liftOf(p));
    const up = (q) => q.clone().add(lift);
    const labelAt = (q) => q.clone().add(lift).addScaledVector(UP, 0.25);

    if (cursor && (isDrawTool() || tool === 'person' || tool === 'move' || (tool === 'rotate' && !rotHandle))) {
      const n = tool === 'person' ? UP : p.n;
      marker.position.copy(cursor).addScaledVector(n, 0.01);
      marker.quaternion.setFromUnitVectors(UP, n);
      markerMat.color.set(cursor.kind === 'axis' ? AXIS_COLORS[cursor.axis] : SNAP_COLORS[cursor.kind] ?? BLUE);
      if (cursor.kind === 'parallel' || cursor.kind === 'perp') markerMat.color.set(ALIGN_COLOR);
      if (SNAP_COLORS[cursor.kind]) showSnapDot(cursor, cursor.kind); // a point: drawn as one
      else { // elsewhere: a cross, in the colour of the axis / alignment it's on (if any)
        crossDot.geometry.setFromPoints([cursor]);
        crossDot.material.color.copy(markerMat.color);
        crossDot.visible = true;
      }
    }
    if (tool === 'move' && !mv && grips) {
      for (const [o, pts] of [[gripCorners, grips.corners], [gripMids, grips.mids]]) {
        o.geometry.dispose();
        o.geometry = new THREE.BufferGeometry().setFromPoints(pts);
      }
      gripCorners.visible = grips.corners.length > 0;
      gripMids.visible = grips.mids.length > 0;
    }
    if (tool === 'move' && mv && cursor?.snapped) showSnapDot(cursor.snapped, cursor.snapped.kind);
    if (tool === 'rotate') previewRotate();
    if ((tool === 'move' || tool === 'rotate') && !mv && !rot && moveCopy && cursor) { label.pos = cursor.clone().addScaledVector(UP, 0.25); label.text = t('tool.copyMode'); }

    if (tool === 'line' && chain.length && cursor) {
      const a = chain.at(-1);
      setPoints(preview, [up(a), up(cursor)]);
      preview.visible = true;
      setLabel(labelAt(a.clone().add(cursor).multiplyScalar(0.5)), fmt(a.distanceTo(cursor)));
    }

    if (tool === 'rect' && anchor && cursor) {
      const c = rectCorners(anchor, cursor);
      setPoints(preview, [...c, c[0]].map(up));
      fill.geometry.dispose();
      fill.geometry = fillGeometry(c.map(up), p);
      preview.visible = fill.visible = true;
      const w = c[0].distanceTo(c[1]), d = c[0].distanceTo(c[3]);
      setLabel(labelAt(c[0].clone().add(c[2]).multiplyScalar(0.5)), `${cm(w)} × ${cm(d)} cm`);
    }

    if (tool === 'circle' && !anchor && cursor) {
      // Before drawing: how many sides the circle will have (type a number to change it).
      label.pos = labelAt(cursor);
      label.text = t('tool.sides', { n: sidesTyped || settings.circleSides }); // live, as digits are typed
    }

    if (tool === 'move' && mv && cursor) {
      setPoints(preview, [mv.base, cursor]);
      preview.visible = true;
      label.pos = cursor.clone().addScaledVector(UP, 0.25);
      const lock = (mv.copy ? '+ ' : '') + (moveVertical ? '↕ ' : mv.axis ? `${mv.axis.toUpperCase()} ` : '');
      label.text = typed ? `${typed}▏` : `${lock}${fmt(mv.delta.length())}`;
    }

    // Preview lines take the axis colour when the cursor runs along one.
    previewMat.color.set(cursor?.kind === 'axis' ? AXIS_COLORS[cursor.axis] : cursor?.kind === 'parallel' || cursor?.kind === 'perp' ? ALIGN_COLOR : BLUE);
    if (tool === 'measure' && anchor && cursor) {
      if (anchor.edge) {
        // From an edge: the offset to it (straight across) and the guide through the cursor.
        const { foot, dir } = edgeOffset(anchor.edge, cursor);
        setPoints(preview, [foot, cursor]);
        if (!marksPlace(cursor) || typed) { // a guide only when ending in open space
          setPoints(guidePreview, [cursor.clone().addScaledVector(dir, -1000), cursor.clone().addScaledVector(dir, 1000)]);
          guidePreview.computeLineDistances();
          const s = getCamera().position.distanceTo(cursor);
          guideMat.dashSize = 0.008 * s;
          guideMat.gapSize = 0.006 * s;
          guidePreview.visible = true;
        }
        label.pos = foot.clone().add(cursor).multiplyScalar(0.5);
        label.text = typed ? `${typed}▏` : fmt(foot.distanceTo(cursor));
      } else {
        setPoints(preview, [anchor, cursor]);
        const dir = !marksPlace(cursor) && anchor.distanceTo(cursor) > 1e-3 ? acrossDir(anchor, cursor) : null;
        if (dir) { // the guide it makes: at the end, across the line
          setPoints(guidePreview, [cursor.clone().addScaledVector(dir, -1000), cursor.clone().addScaledVector(dir, 1000)]);
          guidePreview.computeLineDistances();
          const s = getCamera().position.distanceTo(cursor);
          guideMat.dashSize = 0.008 * s;
          guideMat.gapSize = 0.006 * s;
          guidePreview.visible = true;
        }
        label.pos = anchor.clone().add(cursor).multiplyScalar(0.5);
        const how = (cursor.locked ? '⇥ ' : '') + (cursor.kind === 'parallel' ? '∥ ' : cursor.kind === 'perp' ? '⊥ ' : '');
        label.text = typed ? `${typed}▏` : `${how}${fmt(anchor.distanceTo(cursor))}`;
      }
      preview.visible = true;
    }

    if (tool === 'circle' && anchor && cursor) {
      const radius = anchor.distanceTo(cursor);
      if (radius > 1e-4) {
        const ring = circlePoints(anchor, radius).map(up);
        setPoints(preview, [...ring, ring[0]]);
        fill.geometry.dispose();
        fill.geometry = fillGeometry(ring, p);
        preview.visible = fill.visible = true;
      }
      setLabel(labelAt(anchor.clone().add(cursor).multiplyScalar(0.5)), `R ${fmt(radius)} · ${sidesText()}`);
    }

    if (tool === 'pushpull') {
      if (op) setLabel(op.anchor.clone().addScaledVector(op.normal, op.d).addScaledVector(UP, 0.25), fmt(op.d));
      if (op?.snap) {
        // What it snapped to: the marker there, and a line to it from the pulled face.
        showSnapDot(op.snap, op.snap.kind);
        setPoints(preview, [op.anchor.clone().addScaledVector(op.normal, op.d), op.snap]);
        previewMat.color.set(SNAP_COLORS[op.snap.kind] ?? BLUE);
        preview.visible = true;
      }
      else if (hover != null && model.mesh.faces.has(hover)) highlightFace(hover);
    }
    if (tool === 'offset') {
      const fid = ofs?.fid ?? hover;
      if (fid != null && model.mesh.faces.has(fid)) highlightFace(fid);
      if (ofs?.result) {
        const lift = ofs.plane.n.clone().multiplyScalar(liftOf());
        setPoints(offsetLines, ofs.result.flatMap((l) => l.flatMap((q, i) => [q.clone().add(lift), l[(i + 1) % l.length].clone().add(lift)])));
        offsetLines.visible = true;
      }
      if (ofs && cursor) {
        if (cursor.kind !== 'free') showSnapDot(cursor, cursor.kind);
        setLabel(cursor.clone().addScaledVector(UP, 0.25), fmt(Math.abs(ofs.d)));
      }
    }
    stateListeners.forEach((fn) => fn());
  }

  function highlightFace(fid) {
    const m = model.mesh;
    const off = m.faceNormal(fid).multiplyScalar(liftOf(m.facePlane(fid)) - 0.002);
    hiFill.geometry.dispose();
    hiFill.geometry = new THREE.BufferGeometry().setFromPoints(m.faceTriangles(fid).flatMap((t) => t.pts.map((q) => q.clone().add(off))));
    const seg = [];
    for (const l of m.faces.get(fid).loops) {
      l.forEach((v, i) => seg.push(m.vertices.get(v).clone().add(off), m.vertices.get(l[(i + 1) % l.length]).clone().add(off)));
    }
    setPoints(hiLine, seg);
    hiFill.visible = hiLine.visible = true;
  }

  // --- drawing actions ---
  /**
   * A Shift lock (Measure, Move), Shift let go: has the mouse left the locked line (through
   * `origin` along `dir`)? Far from it (on screen), or a little away once it's been kept a
   * moment (so it isn't lost by a small slip).
   */
  function lockWavedAway(e, origin = anchor, dir = measureLock.dir, releasedAt = measureLock.releasedAt) {
    const cam = getCamera();
    const r = canvas.getBoundingClientRect();
    const toScr = (q) => { const v = q.clone().project(cam); return { x: (v.x + 1) / 2 * r.width, y: (1 - v.y) / 2 * r.height }; };
    const a = toScr(origin), b = toScr(origin.clone().addScaledVector(dir, 1));
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    if (len < 1e-6) return false; // looking straight along it
    const off = Math.abs((e.clientX - r.left - a.x) * dy - (e.clientY - r.top - a.y) * dx) / len;
    const age = performance.now() - (releasedAt ?? performance.now());
    return off > 220 || (off > 90 && age > 2000);
  }

  function resetDraw() {
    measureLock = null;
    chain = [];
    anchor = null;
    anchorPress = false;
    plane = null;
    typed = '';
  }

  const drawOpts = () => ({ color: settings.color, normal: plane.n });

  function addChainPoint(p) {
    if (!p) return;
    if (!chain.length) { plane = hoverPlane; chain.push(p.clone()); return; }
    const a = chain.at(-1);
    if (a.distanceTo(p) < 0.005) return;
    const closed = model.edit((m) => m.addSegment(a, p, plane, drawOpts()));
    chain.push(p.clone());
    if (closed) resetDraw(); // made a face: done, like closing the loop
  }

  /** Stop the current line chain (the edges drawn so far stay). */
  function finishLine() {
    resetDraw();
  }

  function completeShape(c = cursor) {
    if (!anchor || !c) return;
    if (tool === 'rect') {
      const pts = rectCorners(anchor, c);
      if (pts[0].distanceTo(pts[1]) > 0.01 && pts[0].distanceTo(pts[3]) > 0.01) {
        model.edit((m) => m.addLoop(pts, plane, drawOpts()));
      }
    } else if (tool === 'circle') {
      const radius = anchor.distanceTo(c);
      if (radius > 0.01) model.edit((m) => m.addLoop(circlePoints(anchor, radius), plane, { ...drawOpts(), curve: true }));
    } else if (tool === 'measure') {
      // From an edge to open space: a guide parallel to it through the end point. To something
      // already there (an edge, corner, guide): a measurement, straight across from the edge.
      if (anchor.edge) {
        const { foot, dir } = edgeOffset(anchor.edge, c);
        if (marksPlace(c)) model.addMeasurement(foot, c);
        else model.addGuide(c, dir, foot);
      } else {
        // Ending in open space (on a face, the ground), from anywhere: a guide at the end,
        // across the measured line, labelled with the distance (like measuring from an edge).
        // (Ending on a corner / edge: that's marked already: a measurement.)
        const across = !marksPlace(c) ? acrossDir(anchor, c) : null;
        if (across) model.addGuide(c, across, anchor);
        else model.addMeasurement(anchor, c);
      }
    }
    resetDraw();
  }

  /** Is the point on something that already marks the place (corner, midpoint, edge, guide)? */
  const marksPlace = (c) => ['vertex', 'cross', 'mid', 'edge', 'guide'].includes(c?.kind);
  /** On the surface being measured on: the direction across the line a → c (or null). */
  const acrossDir = (a, c) => {
    const d = c.clone().sub(a);
    const n = (plane ?? hoverPlane).n;
    const across = new THREE.Vector3().crossVectors(n, d);
    if (across.lengthSq() < 1e-10) across.crossVectors(UP, d); // measured straight off the surface
    return across.lengthSq() < 1e-10 ? null : across.normalize();
  };

  /** For a line [A, B] and a point c: the point on the line nearest c, and the line's direction. */
  function edgeOffset([A, B], c) {
    const dir = B.clone().sub(A).normalize();
    const foot = A.clone().addScaledVector(dir, c.clone().sub(A).dot(dir));
    return { foot, dir };
  }

  // --- push / pull ---
  function startOp(e, hit) {
    const m = model.mesh;
    model.checkpoint();
    const normal = m.faceNormal(hit.face);
    const base = normal.dot(m.vertices.get(m.faces.get(hit.face).loops[0][0]));
    // Distances that bring the face level with another corner (e.g. through a wall).
    const levels = new Set();
    for (const v of m.vertices.values()) { const dd = normal.dot(v) - base; if (Math.abs(dd) > 1e-3) levels.add(round6(dd)); }
    // Corners, edges and faces to snap to while pulling (as they are now; every group, also
    // while editing one; not the face's own corners). Faces: other objects' faces facing the
    // same way (pull level with them), as outlines on their plane.
    const own = new Set(m.faces.get(hit.face).loops.flat());
    const snapPts = [], snapSegs = [], snapFaces = [];
    for (const mesh of model.meshes) {
      for (const [id, v] of mesh.vertices) if (!(mesh === m && own.has(id))) snapPts.push(v.clone());
      for (const ed of mesh.edges.values()) {
        if (ed.soft || (mesh === m && own.has(ed.a) && own.has(ed.b))) continue;
        snapSegs.push([mesh.vertices.get(ed.a).clone(), mesh.vertices.get(ed.b).clone()]);
      }
      if (mesh === m) continue;
      for (const [id, f] of mesh.faces) {
        const fp = mesh.facePlane(id);
        if (Math.abs(fp.n.dot(normal)) < 0.999) continue;
        snapFaces.push({ p: fp, loops: f.loops.map((l) => l.map((v) => fp.to2D(mesh.vertices.get(v)))) });
      }
    }
    snapPts.push(...notePoints().map((q) => q.clone()));
    const ownPts = new Set([...own].map((id) => m.vertices.get(id)));
    const crossPts = crossings((A, B) => ownPts.has(A) || ownPts.has(B)).map((q) => q.clone());
    op = {
      crossPts,
      base,
      snapPts,
      snapSegs,
      snapFaces,
      snap: null, // the corner / edge point snapped to (shown with the marker)
      data: m.toData(),
      faceIndex: [...m.faces.keys()].indexOf(hit.face),
      normal,
      anchor: hit.point.clone(),
      levels: [...levels],
      startY: e.clientY,
      byPress: true, // released after dragging = done; released without moving = keep following
      d: 0,
    };
    hover = null;
  }

  /** Push / pull: the corner (else the point of an edge) under the mouse on screen, or null. */
  function pullSnap(e) {
    const cam = getCamera();
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const scr = (q) => { const v = q.clone().project(cam); return { x: (v.x + 1) / 2 * r.width, y: (1 - v.y) / 2 * r.height, ok: v.z >= -1 && v.z <= 1 }; };
    let best = null, bestD = 14;
    for (const q of op.snapPts) {
      const s = scr(q);
      const d = Math.hypot(s.x - mx, s.y - my);
      if (s.ok && d < bestD) { bestD = d; best = Object.assign(q.clone(), { kind: 'vertex' }); }
    }
    for (const q of op.crossPts) {
      const s = scr(q);
      const d = Math.hypot(s.x - mx, s.y - my);
      if (s.ok && d < bestD) { bestD = d; best = Object.assign(q.clone(), { kind: 'cross' }); }
    }
    if (best) return best;
    bestD = 9;
    for (const [A, B] of op.snapSegs) {
      const a = scr(A), b = scr(B);
      if (!a.ok || !b.ok) continue;
      const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
      if (len2 < 1) continue;
      const t = THREE.MathUtils.clamp(((mx - a.x) * dx + (my - a.y) * dy) / len2, 0, 1);
      const d = Math.hypot(a.x + dx * t - mx, a.y + dy * t - my);
      if (d < bestD) {
        bestD = d;
        // The edge's point under the mouse: closest to the mouse ray (exact in perspective).
        const pt = new THREE.Vector3();
        raycaster.ray.distanceSqToSegment(A, B, undefined, pt);
        best = Object.assign(pt, { kind: 'edge' });
      }
    }
    if (best) return best;
    // A face (of another object) under the mouse, facing the same way: the nearest one.
    const inside = (poly, q) => {
      let r = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i], b = poly[j];
        if ((a.y > q.y) !== (b.y > q.y) && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x) r = !r;
      }
      return r;
    };
    let bestT = Infinity;
    for (const f of op.snapFaces) {
      const hit = raycaster.ray.intersectPlane(new THREE.Plane(f.p.n, -f.p.d), new THREE.Vector3());
      if (!hit) continue;
      const t = hit.distanceTo(raycaster.ray.origin);
      if (t >= bestT) continue;
      const q = f.p.to2D(hit);
      if (!inside(f.loops[0], q) || f.loops.slice(1).some((h) => inside(h, q))) continue;
      bestT = t;
      best = Object.assign(hit, { kind: 'face' });
    }
    return best;
  }

  /** Distance along the face normal under the mouse ray. */
  function updateOp(e, forced) {
    let d = forced;
    if (d === undefined) {
      setRay(e);
      const { origin: O, direction: D } = raycaster.ray;
      const N = op.normal;
      const w0 = op.anchor.clone().sub(O);
      const b = N.dot(D);
      const denom = 1 - b * b;
      const camDist = getCamera().position.distanceTo(op.anchor);
      if (denom < 1e-3) {
        // Looking straight along the normal: use vertical mouse movement instead.
        d = (op.startY - e.clientY) * 0.002 * camDist;
      } else {
        d = (b * D.dot(w0) - N.dot(w0)) / denom;
      }
      // Snap (unless it's off): to a corner or an edge under the mouse (the face goes level
      // with it), else to the level of other corners nearby. (No grid step: like SketchUp,
      // the pull is free; type a distance for an exact one.)
      op.snap = settings.snapping ? pullSnap(e) : null;
      if (op.snap) d = round6(N.dot(op.snap) - op.base);
      else if (settings.snapping) {
        const r = THREE.MathUtils.clamp(0.012 * camDist, 0.03, 0.4);
        let best = null;
        for (const l of op.levels) if (Math.abs(l - d) < r && (best == null || Math.abs(l - d) < Math.abs(best - d))) best = l;
        if (best != null) d = best;
      }
    }
    const m = Mesh.fromData(op.data);
    const fid = [...m.faces.keys()][op.faceIndex];
    if (Math.abs(d) >= 1e-3 && m.pushPull(fid, d)) {
      model.mesh = m;
      op.d = d;
    } else {
      model.mesh = Mesh.fromData(op.data);
      op.d = 0;
    }
    model.sync(false);
  }

  function endOp(keep) {
    if (!op) return;
    if (keep && Math.abs(op.d) >= 1e-3) {
      model.sync(true);
    } else {
      model.mesh = Mesh.fromData(op.data);
      model.dropCheckpoint();
      model.sync(false);
    }
    op = null;
    typed = '';
  }
  const commitOp = () => endOp(true);
  const cancelOp = () => endOp(false);

  // --- typed values ---
  /** Typed lengths in metres (typed in cm unless a unit is given: 2.5m, 25mm). */
  function parseTyped(pair) {
    const s = typed.trim().replace(/\s+(mm|cm|m)\b/gi, '$1'); // "2.5 m" → "2.5m"
    let parts = s.split(/[;x×*\s]+/i).filter(Boolean);
    if (pair && parts.length === 1 && s.includes(',')) parts = s.split(',');
    return parts.map(parseLength).filter(Number.isFinite);
  }

  function applyTyped() {
    // Offset: a distance, on the side the mouse is now (negative: the other side).
    if (tool === 'offset') {
      const nums = parseTyped(false);
      typed = '';
      if (!ofs || !nums.length) return;
      if (setOffset((ofs.d < 0 ? -1 : 1) * nums[0])) commitOffset();
      return;
    }
    // Rotate: an angle in degrees, the way it's turning now (negative: the other way).
    if (tool === 'rotate') {
      const v = parseFloat(typed.replace(',', '.'));
      typed = '';
      if (rot?.phase !== 'turn' || !Number.isFinite(v)) return;
      applyRotate((rot.angle < 0 ? -1 : 1) * THREE.MathUtils.degToRad(v));
      commitRotate();
      return;
    }
    // Circle: "12s" sets the side count and keeps drawing.
    const sides = tool === 'circle' && typed.trim().match(/^(\d+)\s*s$/i);
    if (sides) { typed = ''; setSides(parseInt(sides[1], 10)); return; }
    const nums = parseTyped(tool === 'rect');
    typed = '';
    if (!nums.length) return;
    const v = nums[0];
    if (tool === 'line' && chain.length && cursor) {
      const a = chain.at(-1);
      const dir = cursor.clone().sub(a);
      if (dir.length() < 1e-6) dir.copy(plane.u); else dir.normalize();
      addChainPoint(new THREE.Vector3(round6(a.x + dir.x * v), round6(a.y + dir.y * v), round6(a.z + dir.z * v)));
    } else if (tool === 'rect' && anchor) {
      const w = Math.abs(v), d = Math.abs(nums[1] ?? v);
      const A = plane.to2D(anchor), C = plane.to2D(cursor ?? anchor.clone().add(plane.u).add(plane.v));
      // Towards the cursor; with the cursor on the corner, towards the camera.
      const toCam = getCamera().position.clone().sub(anchor);
      const sx = Math.sign(C.x - A.x) || (toCam.dot(plane.u) < 0 ? -1 : 1);
      const sy = Math.sign(C.y - A.y) || (toCam.dot(plane.v) < 0 ? -1 : 1);
      const wasShift = shift; shift = false;
      completeShape(plane.from2D(A.x + sx * w, A.y + sy * d));
      shift = wasShift;
    } else if (tool === 'measure' && anchor && cursor) {
      // From an edge: the guide that far from it (towards the cursor); else that far towards the cursor.
      const from = anchor.edge ? edgeOffset(anchor.edge, cursor).foot : anchor;
      const dir = cursor.clone().sub(from);
      if (dir.lengthSq() > 1e-12) completeShape(from.clone().addScaledVector(dir.normalize(), Math.abs(v)));
    } else if (tool === 'circle' && anchor) {
      completeShape(anchor.clone().addScaledVector(plane.u, Math.abs(v)));
    } else if (tool === 'pushpull' && op) {
      updateOp(null, v);
      commitOp();
    } else if (tool === 'move' && mv && mv.delta.lengthSq() > 1e-12) {
      applyMove(mv.delta.clone().normalize().multiplyScalar(v));
      commitMove();
    }
  }

  // Capture phase, so typed digits / Backspace / Enter / Esc are handled here
  // before the app's shortcuts see them.
  window.addEventListener('keydown', (e) => {
    if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    const busy = drawing() || !!op || !!mv || rot?.phase === 'turn' || !!ofs;
    const consume = () => { e.preventDefault(); e.stopPropagation(); updatePreview(); };
    // Rotate tool: ↑ / → / ← lock the protractor to Y / X / Z (again: unlock). Not mid-turn.
    if (tool === 'rotate' && ['ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(e.key)) {
      if (rot?.phase !== 'turn') {
        const a = { ArrowUp: 'y', ArrowRight: 'x', ArrowLeft: 'z' }[e.key];
        rotAxis = rotAxis === a ? null : a;
        if (rot) rot.axis = rotAxis ? AXES[rotAxis].clone() : rot.hoverAxis.clone();
        if (lastPointer) updateCursor(lastPointer);
      }
      consume();
      return;
    }
    // Move tool: ↑ switches between moving along the floor and up / down.
    if (tool === 'move' && e.key === 'ArrowUp') {
      moveVertical = !moveVertical;
      if (moveVertical) moveAxis = null;
      if (mv && lastPointer) updateMove(lastPointer);
      consume();
      return;
    }
    // → / ←: lock the move to X / Z (again: unlock).
    if (tool === 'move' && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      const a = e.key === 'ArrowRight' ? 'x' : 'z';
      moveAxis = moveAxis === a ? null : a;
      if (moveAxis) moveVertical = false;
      if (mv && lastPointer) updateMove(lastPointer);
      consume();
      return;
    }
    if (!busy) {
      // Circle tool, before the first click: digits set the number of sides, live.
      // A pause ends the number, so typing again starts a new one.
      if (tool !== 'circle') return;
      if (/^[0-9]$/.test(e.key)) sidesTyped = (sidesTyped + e.key).slice(-3);
      else if (e.key === 'Backspace' && sidesTyped) sidesTyped = sidesTyped.slice(0, -1);
      else if ((e.key === 'Enter' || e.key === 'Escape') && sidesTyped) { endSidesInput(); consume(); return; }
      else return;
      const n = parseInt(sidesTyped, 10);
      if (n >= MIN_SIDES) setSides(n);
      clearTimeout(sidesTimer);
      sidesTimer = setTimeout(() => { endSidesInput(); updatePreview(); }, 1200);
      consume();
      return;
    }
    // Digits and separators; unit letters (m, c: 2.5m, 25mm, 250cm) once a number has started.
    const allowed = tool === 'circle' ? /^[0-9.,;x× s-]$/i : /^[0-9.,;x× -]$/i;
    // Digits typed with Shift held (keeping a direction locked) come as symbols: use the key.
    const key = e.shiftKey && /^Digit[0-9]$/.test(e.code) ? e.code.slice(5) : e.shiftKey && /^Numpad[0-9]$/.test(e.code) ? e.code.slice(6) : e.key;
    const unitKey = typed && /^[mc]$/i.test(key);
    if ((allowed.test(key) || unitKey) && !(key === ' ' && !typed)) { typed += key; consume(); return; }
    if (e.key === 'Backspace' && typed) { typed = typed.slice(0, -1); consume(); return; }
    if (e.key === 'Enter' && typed) { applyTyped(); consume(); return; }
    if (e.key === 'Escape' && typed) { typed = ''; consume(); }
  }, true);

  // --- move ---
  /**
   * Points that move with the selection (each once): selected faces / edges, groups, measurements;
   * with `attached`, also guides and measurements on what moves (not for a copy: they stay).
   */
  function moveTargets(attached = true) {
    const out = [], seen = new Set();
    const add = (p) => { if (p && !seen.has(p)) { seen.add(p); out.push({ p, orig: p.clone() }); } };
    const m = model.mesh;
    for (const f of model.selectedFaces) m.faces.get(f)?.loops.flat().forEach((v) => add(m.vertices.get(v)));
    for (const id of model.selectedEdges) { const e = m.edges.get(id); if (e) { add(m.vertices.get(e.a)); add(m.vertices.get(e.b)); } }
    for (const g of model.selectedGroups) for (const gm of model.groupMeshes(g)) for (const v of gm.vertices.values()) add(v); // with its subgroups
    for (const id of model.selectedMeasurements) { const it = model.measurements.find((x) => x.id === id); if (it) { add(it.a); add(it.b); } }
    out.guides = [];
    out.tex = texCarried(out);
    if (!attached) return out;

    // Guides and measurements attached to what moves come along: a guide whose source edge
    // moves keeps its offset; a measurement end on a moving corner / edge follows it.
    const moving = new Set(out.map((t) => t.p));
    const segs = [];
    for (const mesh of model.meshes) {
      for (const e of mesh.edges.values()) {
        const A = mesh.vertices.get(e.a), B = mesh.vertices.get(e.b);
        if (moving.has(A) && moving.has(B)) segs.push(new THREE.Line3(A, B));
      }
    }
    // Faces that move whole (every corner moves): points on them follow too.
    const faces = [];
    for (const mesh of model.meshes) {
      for (const [fid, f] of mesh.faces) {
        if (!f.loops.flat().every((v) => moving.has(mesh.vertices.get(v)))) continue;
        const plane = mesh.facePlane(fid);
        faces.push({ plane, loops: f.loops.map((l) => l.map((v) => plane.to2D(mesh.vertices.get(v)))) });
      }
    }
    const inPoly = (pt, poly) => {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i], b = poly[j];
        if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
      }
      return inside;
    };
    const tmp = new THREE.Vector3();
    const onMoving = (q) => [...moving].some((v) => v.distanceToSquared(q) < 1e-8)
      || segs.some((l) => l.closestPointToPoint(q, true, tmp).distanceToSquared(q) < 1e-8)
      || faces.some(({ plane, loops }) => {
        if (!plane.has(q)) return false;
        const pt = plane.to2D(q);
        return inPoly(pt, loops[0]) && !loops.slice(1).some((h) => inPoly(pt, h));
      });
    out.guides = []; // (their direction turns with a rotation)
    for (const g of model.guides) if (g.from && onMoving(g.from)) { add(g.p); add(g.from); out.guides.push({ g, d: g.d.clone() }); }
    for (const it of model.measurements) { if (onMoving(it.a)) add(it.a); if (onMoving(it.b)) add(it.b); }
    return out;
  }

  /**
   * Textured faces that move whole (every corner among `targets`): their texture is glued to
   * them, so it goes along (the texture is laid out in world coordinates; see carryTex).
   */
  function texCarried(targets) {
    const moving = new Set(targets.map((t) => t.p));
    const out = [];
    for (const mesh of model.meshes) {
      for (const [fid, f] of mesh.faces) {
        if (!f.material || !f.loops.flat().every((v) => moving.has(mesh.vertices.get(v)))) continue;
        const plane = mesh.facePlane(fid), p = mesh.vertices.get(f.loops[0][0]);
        out.push({ mesh, fid, tex: f.tex ?? null, u: plane.u.clone(), v: plane.v.clone(), p, orig: p.clone() });
      }
    }
    return out;
  }

  /**
   * After the corners of `targets` moved (by `turn`, a quaternion, if turned): shift / turn each
   * whole-moving face's texture so it sits on the face as before.
   */
  function carryTex(targets, turn = null) {
    for (const it of targets.tex ?? []) {
      const face = it.mesh.faces.get(it.fid);
      const mat = face && model.materialById(face.material);
      if (!mat) continue;
      const t0 = it.tex ?? { offset: [0, 0], rotation: 0 };
      const a = THREE.MathUtils.degToRad(mat.rotation + t0.rotation), cos = Math.cos(a), sin = Math.sin(a);
      // Where a corner was in the texture (before dividing by the size), and the texture's x direction.
      const s0 = it.orig.dot(it.u), r0 = it.orig.dot(it.v);
      const X = s0 * cos - r0 * sin - t0.offset[0], Y = s0 * sin + r0 * cos - t0.offset[1];
      const dir = it.u.clone().multiplyScalar(cos).addScaledVector(it.v, -sin);
      if (turn) dir.applyQuaternion(turn);
      // The same in the face's plane now.
      const plane = it.mesh.facePlane(it.fid);
      const a2 = Math.atan2(-dir.dot(plane.v), dir.dot(plane.u)), cos2 = Math.cos(a2), sin2 = Math.sin(a2);
      const s = it.p.dot(plane.u), r = it.p.dot(plane.v);
      let deg = THREE.MathUtils.radToDeg(a2) - mat.rotation;
      deg -= 360 * Math.round(deg / 360);
      if (Math.abs(deg) < 1e-7) deg = 0;
      const tex = cleanTex({ offset: [s * cos2 - r * sin2 - X, s * sin2 + r * cos2 - Y], rotation: deg, size: t0.size });
      if (tex) face.tex = tex; else delete face.tex;
    }
  }

  /** Nothing selected: Move takes what's under the cursor (as a click with Select would). */
  /** The [point, kind] nearest to the mouse on screen within `px`, or null. */
  function nearestOnScreen(e, list, px) {
    const cam = getCamera();
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const v = new THREE.Vector3();
    let best = null, bestD = px;
    for (const it of list) {
      v.copy(it[0]).project(cam);
      if (v.z < -1 || v.z > 1) continue;
      const d = Math.hypot((v.x + 1) / 2 * r.width - mx, (1 - v.y) / 2 * r.height - my);
      if (d < bestD) { bestD = d; best = it; }
    }
    return best;
  }

  /**
   * Move tool: the corners and edge midpoints of what would move (the selection, else what's
   * under the mouse: what a click would select).
   */
  function gripsOf(e) {
    let keys = [...model.selection];
    if (!keys.length) {
      setRay(e);
      const r = canvas.getBoundingClientRect();
      const mid = model.pickMeasurement(ndc, getCamera(), { x: r.width, y: r.height });
      if (mid != null) keys = [mid];
      else {
        const { edgeHit, faceHit } = pickAt(e);
        const m = model.mesh;
        if (faceHit?.group != null) keys = [`g${faceHit.group}`];
        else if (edgeHit) keys = m.curveEdges(edgeHit.edge).map((x) => `e${x}`);
        else if (faceHit) keys = [...m.surface(faceHit.face)].map((f) => `f${f}`);
      }
    }
    const corners = new Set(), mids = [];
    const edgesOf = (mesh, ids) => {
      for (const v of ids) corners.add(mesh.vertices.get(v));
      for (const ed of mesh.edges.values()) {
        if (ed.soft || ed.curve || !ids.has(ed.a) || !ids.has(ed.b)) continue;
        mids.push(mesh.vertices.get(ed.a).clone().add(mesh.vertices.get(ed.b)).multiplyScalar(0.5));
      }
    };
    const m = model.mesh, ids = new Set();
    for (const k of keys) {
      const id = +k.slice(1);
      if (k[0] === 'f') m.faces.get(id)?.loops.flat().forEach((v) => ids.add(v));
      else if (k[0] === 'e') { const ed = m.edges.get(id); if (ed) { ids.add(ed.a); ids.add(ed.b); } }
      else if (k[0] === 'g' && model.groups.has(id)) for (const gm of model.groupMeshes(id)) edgesOf(gm, new Set(gm.vertices.keys()));
      else if (k[0] === 'm') {
        const it = model.measurements.find((x) => x.id === id);
        if (it) { corners.add(it.a); corners.add(it.b); mids.push(it.a.clone().add(it.b).multiplyScalar(0.5)); }
      }
    }
    edgesOf(m, ids);
    // Only the ones in sight (not behind a face): those are the ones to grab.
    const cam = getCamera();
    const ray = new THREE.Raycaster();
    const seen = (q) => {
      ray.setFromCamera(q.clone().project(cam), cam);
      const hit = ray.intersectObjects(model.pickables, false)[0];
      return !hit || hit.distance >= ray.ray.origin.distanceTo(q) - 0.01;
    };
    return { keys, all: [...corners].filter(Boolean), corners: [...corners].filter((q) => q && seen(q)), mids: mids.filter(seen) };
  }

  function selectUnder(e) {
    setRay(e);
    const r = canvas.getBoundingClientRect();
    const mid = model.pickMeasurement(ndc, getCamera(), { x: r.width, y: r.height });
    if (mid != null) { model.select([mid]); return; }
    const { edgeHit, faceHit } = pickAt(e);
    const m = model.mesh;
    if (faceHit?.group != null) model.select([`g${faceHit.group}`]);
    else if (edgeHit) model.select(m.curveEdges(edgeHit.edge).map((x) => `e${x}`));
    else if (faceHit) model.select([...m.surface(faceHit.face)].map((f) => `f${f}`));
  }

  function startMove(e) {
    // Nothing selected: what the grips shown belong to (also when grabbing an outer corner,
    // just off the object), else what's under the mouse.
    if (!model.selection.size) {
      if (grips?.keys?.length && cursor && (cursor.kind === 'vertex' || cursor.kind === 'mid')) model.select(grips.keys);
      else selectUnder(e);
    }
    if (!model.selection.size || !cursor) return false;
    const targets = moveTargets();
    if (!targets.length) return false;
    model.checkpoint();
    const exclude = new Set(targets.map((t) => t.p));
    // Crossings of what stays put (worked out once: what moves doesn't count).
    const crossPts = crossings((A, B) => exclude.has(A) || exclude.has(B)).map((q) => q.clone());
    mv = { base: cursor.clone(), targets, exclude, crossPts, delta: new THREE.Vector3(), byPress: true, copy: null };
    if (moveCopy) setMoveCopy(true);
    return true;
  }

  /**
   * Copy mode on / off (also before grabbing). During a move the original goes back in place
   * and a copy (which becomes the selection) moves instead; off again, the copy goes away.
   */
  function setMoveCopy(on) {
    moveCopy = on;
    const cur = mv ?? (rot?.phase === 'turn' ? rot : null); // a move or a turn
    if (!cur || !!cur.copy === on) return;
    const keep = cur === mv ? mv.delta.clone() : rot.angle;
    for (const t of cur.targets) t.p.copy(t.orig);
    carryTex(cur.targets);
    for (const { g, d } of cur.guides ?? []) g.d.copy(d);
    if (on) {
      cur.originals = { keys: [...model.selection], targets: cur.targets, guides: cur.guides };
      cur.copy = model.duplicateSelection();
      cur.targets = moveTargets(false);
      cur.guides = [];
    } else {
      model.removeKeys(cur.copy);
      model.selection = new Set(cur.originals.keys);
      cur.targets = cur.originals.targets;
      cur.guides = cur.originals.guides;
      cur.copy = null;
    }
    cur.exclude = new Set(cur.targets.map((t) => t.p)); // the original can be snapped to while copying
    if (cur === mv) applyMove(keep); else applyRotate(keep);
  }

  function applyMove(delta) {
    mv.delta.copy(delta);
    for (const t of mv.targets) t.p.copy(t.orig).add(delta);
    carryTex(mv.targets);
    model.sync(false);
  }

  /** Where the moved point goes: along the floor plane (snapping there), or up / down. */
  function updateMove(e) {
    let target = null;
    if (moveVertical) {
      // A vertical plane through the base point, facing the camera; only the height counts.
      const look = getCamera().getWorldDirection(new THREE.Vector3());
      const n = new THREE.Vector3(look.x, 0, look.z);
      if (n.lengthSq() < 1e-6) n.set(0, 0, 1);
      const raw = rayToPlane(e, makePlane(n.normalize(), mv.base));
      const pt = screenSnap(e, mv.exclude); // a corner / measurement end: go to its height
      if (pt || raw) {
        let dy = (pt ?? raw).y - mv.base.y;
        if (!pt && settings.snap && settings.snapping) dy = Math.round(dy / settings.snap) * settings.snap;
        target = Object.assign(mv.base.clone(), { kind: 'axis', axis: 'y', snapped: pt ?? undefined });
        target.y += dy;
      }
      mv.axis = null;
    } else {
      // Along the floor; but looking nearly level (a front / side view), where the floor
      // can't be aimed at, along the upright axis plane facing the camera.
      const view = getCamera().getWorldDirection(new THREE.Vector3());
      const normalAxis = Math.abs(view.y) > 0.26 ? 'y' : Math.abs(view.x) > Math.abs(view.z) ? 'x' : 'z';
      const movePlane = makePlane(AXES[normalAxis], mv.base);
      const raw = rayToPlane(e, movePlane);
      // A corner / measurement end anywhere under the mouse (to where it lines up), else the plane.
      const pt = screenSnap(e, mv.exclude);
      if (pt) target = Object.assign(movePlane.project(pt), { kind: pt.kind, snapped: pt });
      else if (raw) target = snap(raw, movePlane, null, mv.exclude);
      // Locked to an axis (→ / ←: X / Z; or Shift: the one in the plane it was closest to when
      // pressed): straight along it, to where the mouse / the snapped point lines up. The Shift
      // lock stays after Shift is let go (to type a distance, to reach for a point), as with
      // Measure: until the mouse is waved well away from the line, Shift is pressed again, or
      // the move ends.
      if (mv.shiftLock && !shift && !typed && lockWavedAway(e, mv.base, AXES[mv.shiftLock.axis], mv.shiftLock.releasedAt)) mv.shiftLock = null;
      let axis = moveAxis;
      if (!axis && (shift || mv.shiftLock) && target) {
        const d = target.clone().sub(mv.base);
        mv.shiftLock ??= { axis: ['x', 'y', 'z'].filter((k) => k !== normalAxis).reduce((b, k) => (Math.abs(d[k]) > Math.abs(d[b]) ? k : b)) };
        axis = mv.shiftLock.axis;
      }
      mv.axis = axis;
      if (axis) {
        const locked = Object.assign(mv.base.clone(), { kind: 'axis', axis, snapped: target?.snapped });
        const t = pt ? pt[axis] - mv.base[axis] : alongLine(e, mv.base, AXES[axis]);
        if (t == null) return;
        locked[axis] += pt || !(settings.snapping && settings.snap) ? t : Math.round(t / settings.snap) * settings.snap;
        target = locked;
      }
    }
    // (Nothing absurd: no NaN, nowhere kilometres off.)
    if (!target || !['x', 'y', 'z'].every((k) => Number.isFinite(target[k]) && Math.abs(target[k] - mv.base[k]) < 1000)) return;
    cursor = target;
    applyMove(target.clone().sub(mv.base));
  }

  /** How far along the line (origin, unit dir) the mouse points: on the plane through the line facing the camera. */
  function alongLine(e, origin, dir) {
    setRay(e);
    const n = new THREE.Vector3().crossVectors(dir, raycaster.ray.direction).cross(dir);
    if (n.lengthSq() < 1e-10) return null; // looking straight along it
    const q = raycaster.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(n.normalize(), origin), new THREE.Vector3());
    if (!q) return null;
    const t = q.sub(origin).dot(dir);
    // Aiming almost along the line throws the point kilometres away: ignore that.
    return Number.isFinite(t) && Math.abs(t) < 1000 ? t : null;
  }

  function endMove(keep) {
    if (!mv) return;
    if (keep && mv.delta.lengthSq() > 1e-12) model.sync(true);
    else {
      for (const t of mv.targets) t.p.copy(t.orig);
      carryTex(mv.targets);
      if (mv.copy) { model.removeKeys(mv.copy); model.selection = new Set(mv.originals.keys); }
      model.dropCheckpoint();
      model.sync(false);
    }
    mv = null;
    moveAxis = null;
    moveCopy = false;
    typed = '';
  }
  const commitMove = () => endMove(true);
  const cancelMove = () => endMove(false);

  // --- rotate ---
  /** World size of one screen pixel at point q (for things drawn a fixed size on screen). */
  function worldPerPx(q) {
    const cam = getCamera(), h = canvas.clientHeight || 1;
    if (cam.isOrthographicCamera) return (cam.top - cam.bottom) / cam.zoom / h;
    const depth = q.clone().sub(cam.position).dot(cam.getWorldDirection(new THREE.Vector3()));
    return (2 * Math.max(depth, 0.01) * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2))) / h;
  }

  /**
   * The bounding box of what would turn (the selection, else what's under the mouse) with its
   * handles: on each side (`face`: 'x+', 'y-'...) one in the middle and four out from it, each
   * turning about the axis square to that side, through its middle. Only the side under the
   * mouse shows them. Null when there's nothing.
   */
  function rotBoxOf(e) {
    const g = gripsOf(e);
    if (!g.keys.length || !g.all.length) return null;
    const box = new THREE.Box3().setFromPoints(g.all);
    const size = box.getSize(new THREE.Vector3()), mid = box.getCenter(new THREE.Vector3());
    if (Math.max(size.x, size.y, size.z) < 1e-6) return null;
    const handles = [];
    for (const k of ['x', 'y', 'z']) {
      for (const sign of size[k] < 1e-6 ? [1] : [1, -1]) { // flat that way: one side
        const center = mid.clone();
        center[k] = sign > 0 ? box.max[k] : box.min[k];
        const face = k + (sign > 0 ? '+' : '-');
        // The middle one: turns about the same axis, the start direction picked after grabbing it.
        handles.push({ p: center.clone(), axis: AXES[k].clone(), center, ref: null, k, face });
        for (const o of ['x', 'y', 'z']) {
          if (o === k || size[o] < 1e-6) continue;
          for (const s of [1, -1]) {
            const p = center.clone();
            p[o] += s * size[o] * 0.35; // well out from the middle one, short of the edge
            handles.push({ p, axis: AXES[k].clone(), center, ref: AXES[o].clone().multiplyScalar(s), k, face });
          }
        }
      }
    }
    const c = (i) => new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
    const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]].flatMap(([a, b]) => [c(a), c(b)]);
    return { keys: g.keys, box, handles, edges, shown: [] };
  }

  /** The side of the box the mouse is over ('x+', 'y-'...), or null. */
  function boxFaceUnder(e, box) {
    setRay(e);
    const q = raycaster.ray.intersectBox(box, new THREE.Vector3());
    if (!q || box.containsPoint(raycaster.ray.origin)) return null;
    let best = null, bestD = Infinity;
    for (const k of ['x', 'y', 'z']) {
      for (const [sign, v] of [['+', box.max[k]], ['-', box.min[k]]]) {
        const d = Math.abs(q[k] - v);
        if (d < bestD) { bestD = d; best = k + sign; }
      }
    }
    // (A flat box has only its '+' side.)
    return best && box.max[best[0]] - box.min[best[0]] < 1e-6 ? `${best[0]}+` : best;
  }

  /** The protractor's axis for a surface: its normal (exactly an axis when it's one). */
  function surfaceAxis(n) {
    const k = axisKeyOf(n);
    return k ? AXES[k].clone() : n.clone().normalize();
  }

  /** On the turn plane p: a corner anywhere (projected), else where the mouse meets it; with `kind`. */
  function pointOnTurnPlane(e, p, exclude = null) {
    const pt = screenSnap(e, exclude);
    if (pt) return Object.assign(p.project(pt), { kind: pt.kind, snapped: pt });
    const raw = rayToPlane(e, p);
    return raw ? Object.assign(raw, { kind: 'free' }) : null;
  }

  function updateRotateCursor(e) {
    if (rot?.phase === 'turn') { updateRotate(e); return; }
    if (rot?.phase === 'ref') {
      // The start direction: a corner / midpoint / edge on the plane, else every 15°.
      const p = makePlane(rot.axis, rot.center);
      let q = pointOnTurnPlane(e, p);
      if (q && q.kind === 'free') {
        const raw = q;
        q = snap(raw, p, null);
        if (q.kind === 'grid' || q.kind === 'free') {
          const d = raw.clone().sub(rot.center);
          const len = d.length();
          if (settings.snapping && len > 1e-6) {
            const a = Math.round(Math.atan2(d.dot(p.v), d.dot(p.u)) / ANGLE_STEP) * ANGLE_STEP;
            q = Object.assign(rot.center.clone().addScaledVector(p.u, Math.cos(a) * len).addScaledVector(p.v, Math.sin(a) * len), { kind: 'free' });
          } else q = raw;
        }
      }
      cursor = q;
      return;
    }
    // Before starting: the box handles of what would turn (kept while reaching for one just off
    // the object), and the protractor on the surface under the mouse.
    const nearShown = () => rotBox?.shown.length && nearestOnScreen(e, rotBox.shown.map((h) => [h.p]), 24);
    const next = rotBoxOf(e);
    if (next || !nearShown()) {
      // The side under the mouse shows its handles; just off it (reaching for one): still that side.
      const face = next && boxFaceUnder(e, next.box);
      const was = rotBox?.shown[0]?.face;
      const side = face ?? (was && nearShown() ? was : null);
      rotBox = next;
      if (rotBox) rotBox.shown = rotBox.handles.filter((h) => h.face === side);
    }
    rotHandle = rotBox ? nearestOnScreen(e, rotBox.shown.map((h) => [h.p, h]), 12)?.[1] ?? null : null;
    hoverPlane = planeUnder(e);
    rotHoverAxis = rotAxis ? AXES[rotAxis].clone() : surfaceAxis(hoverPlane.n);
    const pt = screenSnap(e);
    if (pt) cursor = pt;
    else {
      const raw = rayToPlane(e, hoverPlane);
      cursor = raw ? snap(raw, hoverPlane, null) : null;
    }
  }

  /** Start turning what's selected (else `keys`: what the box belongs to). */
  function startTurn(keys) {
    if (!model.selection.size && keys?.length) model.select(keys);
    if (!model.selection.size) return false;
    const targets = moveTargets();
    if (!targets.length) return false;
    model.checkpoint();
    Object.assign(rot, { phase: 'turn', targets, guides: targets.guides, exclude: new Set(targets.map((t) => t.p)), angle: 0, copy: null });
    if (moveCopy) setMoveCopy(true);
    return true;
  }

  /** Rotate tool press; returns true when it took the press. */
  function rotatePress(e) {
    if (!rot) {
      if (rotHandle) {
        // A box handle: turn about its axis, starting from the handle.
        // The middle handle: the protractor placed there, axis fixed; then the start direction
        // (a click, or where a drag from it ends) and the angle, as usual.
        const h = rotHandle;
        rot = { phase: 'ref', center: h.center.clone(), axis: h.axis.clone(), hoverAxis: h.axis.clone(), byPress: true };
        if (!h.ref) {
          if (!model.selection.size) model.select(rotBox.keys);
          if (!model.selection.size) { rot = null; return false; }
          return true;
        }
        Object.assign(rot, { ref: h.ref.clone(), refPt: h.p.clone() });
        if (!startTurn(rotBox.keys)) { rot = null; return false; }
        return true;
      }
      if (!cursor) return false;
      // The centre. What turns is settled now (as with Move): a click on empty space does nothing.
      if (!model.selection.size) {
        if (rotBox?.keys.length) model.select(rotBox.keys);
        else selectUnder(e);
      }
      if (!model.selection.size) return false;
      rot = { phase: 'ref', center: cursor.clone(), axis: rotHoverAxis.clone(), hoverAxis: rotHoverAxis.clone(), byPress: true };
      return true;
    }
    if (rot.phase === 'ref') { setRef(); return true; }
    return false;
  }

  /** The start direction, from the cursor (2nd click, or the end of a drag from the centre). */
  function setRef() {
    if (!cursor) return;
    const p = makePlane(rot.axis, rot.center);
    const d = p.project(cursor).sub(rot.center);
    if (d.length() < 1e-4) return;
    rot.ref = d.normalize();
    rot.refPt = cursor.clone();
    rot.byPress = true;
    if (!startTurn()) cancelRotate();
  }

  function applyRotate(angle) {
    rot.angle = angle;
    const q = new THREE.Quaternion().setFromAxisAngle(rot.axis, angle);
    for (const t of rot.targets) t.p.copy(t.orig).sub(rot.center).applyQuaternion(q).add(rot.center);
    carryTex(rot.targets, q);
    for (const { g, d } of rot.guides) g.d.copy(d).applyQuaternion(q);
    model.sync(false);
  }

  /** The angle from the start direction to the mouse (to a corner: exactly; else in 15° steps). */
  function updateRotate(e) {
    const p = makePlane(rot.axis, rot.center);
    const q = pointOnTurnPlane(e, p, rot.exclude);
    if (!q) return;
    const d = q.clone().sub(rot.center);
    if (d.lengthSq() < 1e-10) return;
    let a = Math.atan2(new THREE.Vector3().crossVectors(rot.ref, d).dot(rot.axis), rot.ref.dot(d));
    if (q.kind === 'free' && settings.snapping) a = Math.round(a / ANGLE_STEP) * ANGLE_STEP;
    cursor = q;
    applyRotate(a);
  }

  function endRotate(keep) {
    if (!rot) return;
    if (rot.phase === 'turn') {
      if (keep && Math.abs(rot.angle) > 1e-9) model.sync(true);
      else {
        for (const t of rot.targets) t.p.copy(t.orig);
        carryTex(rot.targets);
        for (const { g, d } of rot.guides) g.d.copy(d);
        if (rot.copy) { model.removeKeys(rot.copy); model.selection = new Set(rot.originals.keys); }
        model.dropCheckpoint();
        model.sync(false);
      }
    }
    rot = null;
    rotAxis = null;
    moveCopy = false;
    typed = '';
  }
  const commitRotate = () => endRotate(true);
  const cancelRotate = () => endRotate(false);

  /** Place the protractor at q, around `axis`, its 0° tick along `zero` (if given). */
  function showProtractor(q, axis, zero = null) {
    protractor.position.copy(q);
    protractor.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis);
    if (zero) {
      const x = new THREE.Vector3(1, 0, 0).applyQuaternion(protractor.quaternion);
      const a = Math.atan2(new THREE.Vector3().crossVectors(x, zero).dot(axis), x.dot(zero));
      protractor.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, a));
    }
    protractor.scale.setScalar(55 * worldPerPx(q));
    const k = axisKeyOf(axis);
    protractor.material.color.set(k ? AXIS_COLORS[k] : BLUE);
    protractor.visible = true;
  }

  function previewRotate() {
    if (!rot && rotBox) {
      setPoints(rotBoxLines, rotBox.edges);
      rotBoxLines.visible = true;
      rotHandles.geometry.dispose();
      rotHandles.geometry = new THREE.BufferGeometry().setFromPoints(rotBox.shown.map((h) => h.p));
      rotHandles.visible = rotBox.shown.length > 0;
      if (rotHandle) {
        setPoints(rotHandleHi, [rotHandle.p]);
        rotHandleHi.visible = true;
        showProtractor(rotHandle.center, rotHandle.axis, rotHandle.ref);
      }
    }
    if (!rot) {
      if (!rotHandle && cursor) showProtractor(cursor, rotHoverAxis);
      return;
    }
    showProtractor(rot.center, rot.axis, rot.phase === 'turn' ? rot.ref : null);
    if (rot.phase === 'ref' && cursor) {
      setPoints(preview, [rot.center, cursor]);
      preview.visible = true;
    }
    if (rot.phase === 'turn') {
      // The start direction and the current one, from the centre (at least the protractor's size).
      const r = 55 * worldPerPx(rot.center);
      const now = rot.ref.clone().applyAxisAngle(rot.axis, rot.angle);
      const refEnd = rot.center.clone().addScaledVector(rot.ref, Math.max(r, rot.refPt.distanceTo(rot.center)));
      const nowEnd = rot.center.clone().addScaledVector(now, Math.max(r, cursor ? cursor.distanceTo(rot.center) : 0));
      setPoints(preview, [refEnd, rot.center, nowEnd]);
      preview.visible = true;
      if (cursor?.snapped) showSnapDot(cursor.snapped, cursor.snapped.kind);
      const deg = THREE.MathUtils.radToDeg(rot.angle);
      label.pos = nowEnd.clone().addScaledVector(UP, 0.15);
      label.text = typed ? `${typed}°▏` : `${rot.copy ? '+ ' : ''}${Math.abs(deg - Math.round(deg)) < 0.05 ? Math.round(deg) : deg.toFixed(1)}°`;
    }
  }

  // --- offset ---
  /** A loop (2D points) without repeated or in-line points, turned counter-clockwise. */
  function cleanLoop2D(pts) {
    let out = pts.filter((p, i) => Math.hypot(p.x - pts[(i + 1) % pts.length].x, p.y - pts[(i + 1) % pts.length].y) > 1e-7);
    out = out.filter((p, i) => {
      const a = out[(i - 1 + out.length) % out.length], b = out[(i + 1) % out.length];
      return Math.abs((p.x - a.x) * (b.y - p.y) - (p.y - a.y) * (b.x - p.x)) > 1e-10;
    });
    let area = 0;
    out.forEach((p, i) => { const q = out[(i + 1) % out.length]; area += p.x * q.y - q.x * p.y; });
    return area < 0 ? out.reverse() : out;
  }

  /** Do segments ab and cd cross (properly, not just touching at an end)? */
  function segsCross(a, b, c, d) {
    const o = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
    return ((d1 > 1e-12 && d2 < -1e-12) || (d1 < -1e-12 && d2 > 1e-12)) && ((d3 > 1e-12 && d4 < -1e-12) || (d3 < -1e-12 && d4 > 1e-12));
  }

  /**
   * A counter-clockwise loop moved `d` inwards (negative: outwards), corners mitred. Null when
   * that's too far: a side would turn around or the loop would cross itself.
   */
  function offsetLoop2D(pts, d) {
    const n = pts.length;
    const dirs = pts.map((p, i) => {
      const q = pts[(i + 1) % n], len = Math.hypot(q.x - p.x, q.y - p.y);
      return { ux: (q.x - p.x) / len, uy: (q.y - p.y) / len };
    });
    const out = pts.map((p, i) => {
      const a = dirs[(i - 1 + n) % n], b = dirs[i];
      // The two neighbouring sides, each moved along its inward (left) normal; where they meet.
      const ax = p.x - a.uy * d, ay = p.y + a.ux * d, bx = p.x - b.uy * d, by = p.y + b.ux * d;
      const cross = a.ux * b.uy - a.uy * b.ux;
      if (Math.abs(cross) < 1e-9) return { x: bx, y: by };
      const t = ((bx - ax) * b.uy - (by - ay) * b.ux) / cross;
      return { x: ax + a.ux * t, y: ay + a.uy * t };
    });
    for (let i = 0; i < n; i++) {
      const p = out[i], q = out[(i + 1) % n];
      if ((q.x - p.x) * dirs[i].ux + (q.y - p.y) * dirs[i].uy <= 1e-9) return null; // a side turned around
    }
    for (let i = 0; i < n; i++) {
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        if (segsCross(out[i], out[(i + 1) % n], out[j], out[(j + 1) % n])) return null;
      }
    }
    return out;
  }

  /**
   * The face's outline offset by d (inwards when positive: its holes grow too; outwards: the
   * outer loop only), as 3D loops; null when it doesn't work out at that distance.
   */
  function offsetFace(o, d) {
    if (Math.abs(d) < 1e-4) return null;
    const loops = [];
    const outer = offsetLoop2D(o.loops[0], d);
    if (!outer) return null;
    loops.push(outer);
    if (d > 0) {
      for (const h of o.loops.slice(1)) {
        const g = offsetLoop2D(h, -d);
        if (!g) return null;
        loops.push(g);
      }
    }
    // The new loops mustn't cross each other either.
    for (let a = 0; a < loops.length; a++) {
      for (let b = a + 1; b < loops.length; b++) {
        const A = loops[a], B = loops[b];
        for (let i = 0; i < A.length; i++) {
          for (let j = 0; j < B.length; j++) {
            if (segsCross(A[i], A[(i + 1) % A.length], B[j], B[(j + 1) % B.length])) return null;
          }
        }
      }
    }
    return loops.map((l) => l.map((q) => o.plane.from2D(q.x, q.y)));
  }

  /** Signed distance from 2D point q to the outer loop: positive inside. */
  function insideDistance(loop, q) {
    let best = Infinity, inside = false;
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const a = loop[j], b = loop[i];
      const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
      const t = len2 ? THREE.MathUtils.clamp(((q.x - a.x) * dx + (q.y - a.y) * dy) / len2, 0, 1) : 0;
      best = Math.min(best, Math.hypot(q.x - a.x - t * dx, q.y - a.y - t * dy));
      if ((a.y > q.y) !== (b.y > q.y) && q.x < (dx * (q.y - a.y)) / dy + a.x) inside = !inside;
    }
    return inside ? best : -best;
  }

  function startOffset(e, fid) {
    const m = model.mesh;
    const f = m.faces.get(fid);
    const plane = m.facePlane(fid);
    const loops = f.loops.map((l) => cleanLoop2D(l.map((v) => plane.to2D(m.vertices.get(v)))));
    if (loops[0].length < 3) return false;
    // A circle's offset is a circle too (one curve, picked as a whole).
    const curve = m.faceEdges(fid).every((id) => m.edges.get(id).curve);
    ofs = { fid, plane, loops, curve, d: 0, result: null, byPress: true, t0: performance.now(), x0: e.clientX, y0: e.clientY };
    updateOffset(e);
    return true;
  }

  /** The offset through the mouse (a corner under it: through that), kept at the last one that works. */
  function updateOffset(e) {
    const pt = screenSnap(e);
    const q = pt ? ofs.plane.project(pt) : rayToPlane(e, ofs.plane);
    if (!q) return;
    cursor = Object.assign(q, { kind: pt ? pt.kind : 'free' });
    setOffset(insideDistance(ofs.loops[0], ofs.plane.to2D(q)));
  }

  function setOffset(d) {
    const result = offsetFace(ofs, d);
    if (result) { ofs.d = d; ofs.result = result; }
    return !!result;
  }

  function commitOffset() {
    const o = ofs;
    ofs = null;
    typed = '';
    if (!o?.result) return;
    lastOffset = o.d;
    const m = model.mesh;
    const f = m.faces.get(o.fid);
    model.checkpoint();
    const before = new Set(m.faces.keys());
    for (const loop of o.result) m.addLoop(loop, o.plane, { color: f.color, normal: o.plane.n, curve: o.curve });
    // Outwards, the ring around the face is a new face: give it the face's material too. (Faces
    // split inside keep theirs.) It's the new face between the old outline and the new one.
    if (f.material && o.d < 0) {
      const ring = o.result[0].map((q) => o.plane.to2D(q));
      for (const [id, g] of m.faces) {
        if (before.has(id) || !o.plane.has(m.vertices.get(g.loops[0][0]))) continue;
        const t = m.faceTriangles(id)[0];
        if (!t) continue;
        const c = o.plane.to2D(t.pts[0].clone().add(t.pts[1]).add(t.pts[2]).divideScalar(3));
        if (insideDistance(ring, c) > 0 && insideDistance(o.loops[0], c) < 0) {
          g.material = f.material;
          if (f.tex) g.tex = { ...f.tex, offset: [...f.tex.offset] };
        }
      }
    }
    model.sync();
  }

  function cancelOffset() {
    ofs = null;
    typed = '';
  }

  // --- circle sides ---
  const sidesText = () => t('tool.sides', { n: settings.circleSides });
  function setSides(n) {
    const v = THREE.MathUtils.clamp(Math.round(n), MIN_SIDES, MAX_SIDES);
    if (v === settings.circleSides) return;
    settings.circleSides = v;
    sidesListeners.forEach((fn) => fn(v));
  }
  function endSidesInput() {
    clearTimeout(sidesTimer);
    sidesTyped = '';
  }

  // --- selection (Select tool) ---
  /** What a click at the pointer would select: { edgeHit } or { faceHit } (or neither). */
  function pickAt(e) {
    setRay(e);
    const r = canvas.getBoundingClientRect();
    const m = model.mesh;
    // Edges are thin: they're hit from this many px away (more for fingers).
    const touch = e.pointerType === 'touch' || matchMedia('(pointer: coarse)').matches;
    const reach = touch ? 22 : 12;
    const sure = touch ? 11 : 6; // this close, the edge always wins
    const size = { x: r.width, y: r.height };
    let edgeHit = model.pickEdge(raycaster, getCamera(), ndc, size, reach);
    let faceHit = model.pickFace(raycaster);
    if (edgeHit && faceHit?.group != null && edgeHit.px > sure) edgeHit = null; // a group in front
    if (edgeHit && faceHit && faceHit.group == null && edgeHit.px > sure) {
      // Further out on a face: the edge wins only if it's clearly closer than the face's
      // other edges, so thin faces (a wall top seen from afar) can still be clicked.
      const others = new Set(m.faceEdges(faceHit.face));
      others.delete(edgeHit.edge);
      const next = model.pickEdge(raycaster, getCamera(), ndc, size, Infinity, others);
      if (next && edgeHit.px > next.px * 0.5) edgeHit = null;
    }
    if (edgeHit) faceHit = null;
    return { edgeHit, faceHit };
  }

  function selectAt(e) {
    // A measurement (its line or label) comes first: it's drawn on top of everything.
    {
      setRay(e);
      const r = canvas.getBoundingClientRect();
      const key = model.pickMeasurement(ndc, getCamera(), { x: r.width, y: r.height });
      if (key != null) { model.select([key], e.ctrlKey || e.metaKey ? 'add' : e.shiftKey ? 'toggle' : 'replace'); return; }
      const gid = model.pickGuide(raycaster.ray, getCamera(), { x: r.width, y: r.height });
      // A guide, unless an edge is right there (guides often run along / across faces).
      if (gid != null && !model.pickEdge(raycaster, getCamera(), ndc, { x: r.width, y: r.height }, 6)) {
        model.select([`u${gid}`], e.ctrlKey || e.metaKey ? 'add' : e.shiftKey ? 'toggle' : 'replace');
        return;
      }
    }
    const { edgeHit, faceHit } = pickAt(e);
    const m = model.mesh;
    // A closed group: click selects all of it, double-click opens it for editing.
    if (faceHit?.group != null) {
      if (e.detail >= 2 && !e.ctrlKey && !e.metaKey && !e.shiftKey) { model.enterGroup(faceHit.group); return; }
      model.select([`g${faceHit.group}`], e.ctrlKey || e.metaKey ? 'add' : e.shiftKey ? 'toggle' : 'replace');
      return;
    }
    // Editing a group: a click on empty space (or on the faded rest) closes it.
    if (!edgeHit && !faceHit && model.activeGroup != null && !e.ctrlKey && !e.metaKey && !e.shiftKey) { model.exitGroup(); return; }
    if (e.altKey) {
      // Alt+click: loop (edge loop / face loop); Ctrl+Alt+click: edge ring. Shift adds.
      if (!edgeHit && !faceHit) return;
      let faces = [], edges = [];
      if (edgeHit) edges = e.ctrlKey || e.metaKey ? m.edgeRing(edgeHit.edge) : m.edgeLoop(edgeHit.edge);
      else faces = m.faceLoop(faceHit.face, m.nearestEdgeOfFace(faceHit.face, faceHit.point));
      model.select([...faces.map((f) => `f${f}`), ...edges.map((x) => `e${x}`)], e.shiftKey ? 'add' : 'replace');
      return;
    }
    const mode = e.ctrlKey || e.metaKey ? 'add' : e.shiftKey ? 'toggle' : 'replace';
    if (!edgeHit && !faceHit) { if (mode === 'replace') model.select([]); return; }
    let faces = new Set(), edges = new Set();
    if (edgeHit) m.curveEdges(edgeHit.edge).forEach((x) => edges.add(x)); // a circle's edge: the whole circle
    else faces = m.surface(faceHit.face); // a smooth surface (cylinder side) is picked as a whole
    if (e.detail === 2) {
      // Face → its edges; edge → its faces.
      if (edgeHit) for (const x of edges) for (const f of m.facesOfEdge(x)) m.surface(f).forEach((g) => faces.add(g));
      else for (const f of faces) m.faceEdges(f).forEach((x) => { if (!m.edges.get(x).soft) edges.add(x); });
    } else if (e.detail >= 3) {
      ({ faces, edges } = m.connected(faces, edges));
    }
    const keys = [...[...faces].map((f) => `f${f}`), ...[...edges].map((x) => `e${x}`)];
    model.select(keys, e.detail >= 2 && mode !== 'replace' ? 'add' : mode);
  }
  canvas.addEventListener('click', (e) => { if ((tool === 'select' || tool === 'orbit' || tool === 'pan') && !lastMoved) selectAt(e); });

  // --- selection box (Select tool) ---
  function boxRect(e) {
    const r = canvas.getBoundingClientRect();
    const x0 = Math.min(boxStart.x, e.clientX) - r.left, x1 = Math.max(boxStart.x, e.clientX) - r.left;
    const y0 = Math.min(boxStart.y, e.clientY) - r.top, y1 = Math.max(boxStart.y, e.clientY) - r.top;
    return { x0, y0, x1, y1, crossing: e.clientX < boxStart.x, size: { x: r.width, y: r.height } };
  }
  function showBox(e) {
    const b = boxRect(e);
    Object.assign(boxEl.style, { left: `${b.x0}px`, top: `${b.y0}px`, width: `${b.x1 - b.x0}px`, height: `${b.y1 - b.y0}px` });
    boxEl.classList.toggle('crossing', b.crossing);
    boxEl.hidden = false;
  }
  function finishBox(e) {
    const b = boxRect(e);
    boxEl.hidden = true;
    const keys = model.keysInBox(b, getCamera(), b.size, b.crossing);
    model.select(keys, e.ctrlKey || e.metaKey ? 'add' : e.shiftKey ? 'toggle' : 'replace');
  }

  // --- pointer events ---
  // Capture phase on the parent so we run before OrbitControls and can block it.
  canvas.parentElement.addEventListener('pointerdown', (e) => {
    if (e.target !== canvas) return;
    press = { x: e.clientX, y: e.clientY, button: e.button };
    updateCursor(e);
    if (e.button !== 0) return;
    // Select tool: a drag draws a selection box (touch keeps one-finger orbiting).
    if (tool === 'select' && e.pointerType !== 'touch' && !person.eye) boxStart = { x: e.clientX, y: e.clientY };
    if (tool === 'person' && cursor) {
      model.checkpoint({ extra: true }); // placing / moving the person is an undo step
      person.place(cursor.x, cursor.z, cursor.y);
      aiming = { x: cursor.x, z: cursor.z };
      model.sync(false); // refresh undo button state
    } else if ((tool === 'rect' || tool === 'circle' || tool === 'measure') && !anchor && cursor) {
      // (Measure from an edge or guide: the line comes along, the result will be a guide.)
      anchor = Object.assign(cursor.clone(), { kind: cursor.kind, edge: tool === 'measure' && (cursor.kind === 'edge' || cursor.kind === 'guide') ? cursor.edge : null });
      plane = hoverPlane;
      anchorPress = true;
    } else if (tool === 'pushpull' && !op) {
      setRay(e);
      const hit = model.pickFace(raycaster);
      if (hit && hit.group == null && model.mesh.canPushPull(hit.face)) { startOp(e, hit); e.stopPropagation(); }
    } else if (tool === 'move' && !mv) {
      if (startMove(e)) e.stopPropagation();
    } else if (tool === 'rotate') {
      if (rotatePress(e)) e.stopPropagation();
    } else if (tool === 'offset' && !ofs && hover != null && model.mesh.faces.has(hover)) {
      if (startOffset(e, hover)) e.stopPropagation();
    }
    updatePreview();
  }, true);

  window.addEventListener('pointermove', (e) => {
    lastPointer = e;
    // Orbiting / panning with a left-drag (Orbit, Pan tools) or middle-drag: a grabbing hand while it lasts.
    if (press && (press.button === 1 || (press.button === 0 && (tool === 'orbit' || tool === 'pan')))
      && Math.hypot(e.clientX - press.x, e.clientY - press.y) > CLICK_TOLERANCE_PX) canvas.style.cursor = 'grabbing';
    if (boxStart && Math.hypot(e.clientX - boxStart.x, e.clientY - boxStart.y) > CLICK_TOLERANCE_PX) showBox(e);
    if (!aiming && !op && !mv && !rot && !ofs && !drawing() && e.target !== canvas) return;
    updateCursor(e);
    if (aiming && cursor && Math.hypot(aiming.x - cursor.x, aiming.z - cursor.z) > 0.15) person.face(Math.atan2(cursor.z - aiming.z, cursor.x - aiming.x));
    updatePreview();
  });

  window.addEventListener('pointerup', (e) => {
    if (!press) return;
    const moved = Math.hypot(e.clientX - press.x, e.clientY - press.y) > CLICK_TOLERANCE_PX;
    lastMoved = moved;
    const button = press.button;
    press = null;
    canvas.style.cursor = toolCursor();
    if (boxStart) {
      if (!boxEl.hidden) finishBox(e);
      boxStart = null;
    }

    if (aiming) { aiming = null; person.save(); return; }
    if (button === 2 && !moved) {
      // Right-click: stop a line chain; cancel anything else in progress.
      if (op) cancelOp();
      else if (mv) cancelMove();
      else if (rot) cancelRotate();
      else if (ofs) cancelOffset();
      else if (tool === 'line') finishLine();
      else resetDraw();
      updatePreview();
      return;
    }
    if (button !== 0) return;

    if (tool === 'line' && !moved) {
      addChainPoint(cursor);
    } else if ((tool === 'rect' || tool === 'circle' || tool === 'measure') && anchor && (moved || !anchorPress)) {
      completeShape();
    } else if (tool === 'pushpull' && op) {
      if (op.byPress && !moved) op.byPress = false; // click without drag: keep following the mouse
      else commitOp();
    } else if (tool === 'move' && mv) {
      if (mv.byPress && !moved) mv.byPress = false; // click, move, click (or drag)
      else commitMove();
    } else if (tool === 'rotate' && rot) {
      // Centre: a drag from it sets the start direction where it ends. Turning: click-click or drag.
      if (rot.byPress && !moved) rot.byPress = false;
      else if (rot.phase === 'ref' && rot.byPress) setRef(e);
      else if (rot.phase === 'turn') commitRotate();
    } else if (tool === 'offset' && ofs) {
      if (ofs.byPress && !moved) ofs.byPress = false; // click, move, click (or drag)
      else {
        // A quick second click where the first was (a double-click): the last offset again.
        const again = !moved && lastOffset != null && performance.now() - ofs.t0 < 450 && Math.hypot(e.clientX - ofs.x0, e.clientY - ofs.y0) <= CLICK_TOLERANCE_PX;
        if (again && !setOffset(lastOffset)) cancelOffset();
        else commitOffset();
      }
    }
    anchorPress = false;
    updatePreview();
  });

  canvas.addEventListener('dblclick', () => { if (tool === 'line') { finishLine(); updatePreview(); } });

  const refreshFromLastPointer = () => {
    if (lastPointer && (lastPointer.target === canvas || drawing())) updateCursor(lastPointer);
    updatePreview();
  };
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Shift' || e.repeat) return;
    // Measure: Shift again while a lock is kept: drop it (and lock what it's on now, if anything).
    if (measureLock?.releasedAt) measureLock = null;
    if (mv?.shiftLock?.releasedAt) mv.shiftLock = null;
    shift = true;
    refreshFromLastPointer();
  });
  // Move tool: a tap on Ctrl (pressed and released alone, so not Ctrl+Z etc.) toggles copying.
  window.addEventListener('keydown', (e) => { if (e.key === 'Control') { if (!e.repeat) ctrlTap = true; } else ctrlTap = false; }, true);
  window.addEventListener('pointerdown', () => { ctrlTap = false; }, true);
  window.addEventListener('wheel', () => { ctrlTap = false; }, true);
  window.addEventListener('blur', () => { ctrlTap = false; });
  window.addEventListener('keyup', (e) => {
    if (e.key !== 'Control') return;
    const tap = ctrlTap;
    ctrlTap = false;
    if (!tap || (tool !== 'move' && tool !== 'rotate') || isTyping(e)) return;
    setMoveCopy(!moveCopy);
    updatePreview();
  });
  window.addEventListener('keyup', (e) => {
    if (e.key !== 'Shift') return;
    shift = false;
    if (measureLock) measureLock.releasedAt = performance.now(); // kept: see lockWavedAway
    if (mv?.shiftLock) mv.shiftLock.releasedAt = performance.now();
    refreshFromLastPointer();
  });

  model.onChange(() => {
    if (op || mv || rot || ofs) return;
    if (hover != null && !model.mesh.faces.has(hover)) hover = null;
    updatePreview();
  });

  // --- public API ---
  function cancel() {
    const busy = drawing() || !!op || !!mv || !!rot || !!ofs;
    cancelOffset();
    cancelOp();
    cancelMove();
    cancelRotate();
    resetDraw();
    updatePreview();
    return busy;
  }

  /** The tool's own cursor (while orbiting, a grabbing hand shows instead). */
  const toolCursor = () => ({ select: 'default', orbit: 'default', pan: 'default', pushpull: 'ns-resize', move: 'move' }[tool] ?? 'crosshair');

  function setTool(t) {
    cancel();
    moveCopy = false;
    tool = t;
    hover = null;
    rotBox = rotHandle = null;
    rotAxis = null;
    if (!['select', 'orbit', 'pan', 'move', 'rotate'].includes(t) && model.selection.size) model.select([]); // Move / Rotate work on the selection
    controls.mouseButtons.LEFT = t === 'orbit' ? THREE.MOUSE.ROTATE : t === 'pan' ? THREE.MOUSE.PAN : null; // Select drags a box instead
    canvas.style.cursor = toolCursor();
    toolListeners.forEach((fn) => fn(t));
    updatePreview();
  }

  return {
    /** Update the cursor / preview (after a setting such as snapping changes). */
    refresh: refreshFromLastPointer,
    /** Hide editing helpers (previews, highlights, cursor ring, label); returns a restore function. */
    hideHelpers() {
      const was = helpers.map((o) => o.visible);
      const labelPos = label.pos;
      helpers.forEach((o) => (o.visible = false));
      label.pos = null;
      return () => {
        helpers.forEach((o, i) => (o.visible = was[i]));
        label.pos = labelPos;
      };
    },
    label,
    setTool,
    get tool() { return tool; },
    onToolChange(fn) { toolListeners.add(fn); },
    /** Returns true if something was in progress and got cancelled. */
    cancel,
    /** Something in progress (drawing / pushing)? */
    get busy() { return drawing() || !!op || !!mv || !!rot || !!ofs; },
    /** Can the current input be finished without another point (a line chain)? */
    get canFinish() { return tool === 'line' && chain.length >= 2; },
    onStateChange(fn) { stateListeners.add(fn); },
    /** Circle side count changed by typing (fn gets the new count). */
    onSidesChange(fn) { sidesListeners.add(fn); },
    /** Apply a typed value (touch: the action bar's value field). */
    enterValue(text) {
      typed = String(text);
      applyTyped();
      updatePreview();
    },
    /** Enter: stop a line chain. */
    finish() {
      if (tool === 'line') finishLine();
      updatePreview();
    },
    undo() {
      if (op || mv || rot || ofs) return;
      // While drawing a line, undo takes back the last edge.
      if (chain.length > 1) { model.undo(); chain.pop(); }
      else if (drawing()) resetDraw();
      else model.undo();
      updatePreview();
    },
    redo() {
      if (op || mv || rot || ofs || drawing()) return;
      model.redo();
    },
  };
}
