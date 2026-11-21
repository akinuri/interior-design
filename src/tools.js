import * as THREE from 'three';
import { Mesh, GROUND, triangulate, makePlane } from './mesh.js';
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
 *              (or drag). Along the floor; ↑ toggles up / down; Shift locks to X or Z.
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
const SNAP_COLORS = { vertex: 0xf28c28, mid: 0x18a6b8, edge: 0xd6336c, guide: 0xd6336c };
const UP = new THREE.Vector3(0, 1, 0);
const AXES = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
// Axis colours, like the ground / side grid axes: X red, Y green, Z blue.
const AXIS_COLORS = { x: 0xe0453f, y: 0x36a84a, z: 0x3a6fe8 };

const round6 = (v) => Math.round(v * 1e6) / 1e6;
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
  let hover = null; // push/pull: face id under the cursor
  let cursor = null; // snapped point: THREE.Vector3 with .kind
  let typed = ''; // typed value (measurements box)
  let press = null; // { x, y, button } of the current mouse press
  let lastMoved = false; // the last press was a drag (so its click isn't a selection)
  let aiming = null; // person tool: placed point; drag sets facing
  let boxStart = null; // Select tool: where a selection box drag started { x, y } (client px)
  let shift = false;
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
  const helpers = [preview, fill, hiFill, hiLine, marker, guidePreview];

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
  function snap(raw, p, from, exclude = null) {
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

    // Corners: points of the geometry and of the shape being drawn, plus guide crossings.
    const points = [...meshes.flatMap((m) => [...m.vertices.values()]), ...chain, ...(anchor ? [anchor] : [])]
      .filter((v) => p.has(v, 1e-3) && !exclude?.has(v));
    for (let i = 0; i < guides.length; i++) {
      const g = guides[i];
      for (const o of [...guides.slice(i + 1), ...segs]) {
        const x = crossing2D(p, g, o);
        if (x) points.push(x);
      }
    }
    let best = null, bestD = r;
    for (const v of points) {
      const d = v.distanceTo(raw);
      if (d < bestD) { bestD = d; best = v; }
    }
    if (best) return at(best, 'vertex');
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
    if (from && (tool === 'line' || tool === 'measure') && !shift) {
      const d = raw.clone().sub(from);
      const len = d.length();
      if (len > 1e-6) {
        for (const [axis, dir] of [['x', AXES.x], ['y', AXES.y], ['z', AXES.z]]) {
          const along = d.dot(dir);
          if (Math.abs(along) / len < Math.cos(THREE.MathUtils.degToRad(4))) continue;
          if (tool === 'line' && Math.abs(dir.dot(p.n)) > 1e-6) continue; // a line stays on its plane
          const l = step ? Math.round(along / step) * step : along;
          return Object.assign(from.clone().addScaledVector(dir, round6(l)), { kind: 'axis', axis });
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

  /** Where guide line `g` crosses line / segment `o` on plane `p` (Vector3), or null. */
  function crossing2D(p, g, o) {
    const a = p.to2D(g.A), b = p.to2D(g.B), c = p.to2D(o.A), d = p.to2D(o.B);
    const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y;
    const den = rx * sy - ry * sx;
    if (Math.abs(den) < 1e-12) return null;
    const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den; // along o
    if (!o.guide && (u < -1e-9 || u > 1 + 1e-9)) return null;
    return o.A.clone().lerp(o.B, u);
  }

  const drawing = () => chain.length > 0 || !!anchor;
  const isDrawTool = () => tool === 'line' || tool === 'rect' || tool === 'circle' || tool === 'measure';

  function updateCursor(e) {
    cursor = null;
    if (tool === 'person') {
      const raw = rayToPlane(e, GROUND);
      if (raw) cursor = Object.assign(raw, { kind: 'free' });
    } else if (isDrawTool()) {
      // (Measure: the plane under the cursor each time, so points can be on different faces.)
      hoverPlane = (tool === 'measure' ? null : plane) ?? planeUnder(e);
      const raw = rayToPlane(e, hoverPlane);
      if (raw) cursor = snap(raw, hoverPlane, tool === 'line' ? chain.at(-1) : tool === 'measure' ? anchor : null);
      if (cursor && tool === 'measure' && anchor && shift) {
        // Shift: straight along the main axis (X, Y or Z) it's closest to.
        const d = cursor.clone().sub(anchor);
        const axis = ['x', 'y', 'z'].reduce((best, k) => (Math.abs(d[k]) > Math.abs(d[best]) ? k : best), 'x');
        cursor = Object.assign(anchor.clone(), { kind: 'angle' });
        cursor[axis] += d[axis];
      }
    } else if (tool === 'move') {
      if (mv) updateMove(e);
      else {
        // The point to move from: snapped like drawing, on the surface under the cursor.
        hoverPlane = planeUnder(e);
        const raw = rayToPlane(e, hoverPlane);
        if (raw) cursor = snap(raw, hoverPlane, null);
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

  function updatePreview() {
    for (const h of helpers) h.visible = false;
    label.pos = null;
    const p = plane ?? hoverPlane;
    const lift = p.n.clone().multiplyScalar(liftOf(p));
    const up = (q) => q.clone().add(lift);
    const labelAt = (q) => q.clone().add(lift).addScaledVector(UP, 0.25);

    if (cursor && (isDrawTool() || tool === 'person' || tool === 'move')) {
      const n = tool === 'person' ? UP : p.n;
      marker.position.copy(cursor).addScaledVector(n, 0.01);
      marker.quaternion.setFromUnitVectors(UP, n);
      markerMat.color.set(cursor.kind === 'axis' ? AXIS_COLORS[cursor.axis] : SNAP_COLORS[cursor.kind] ?? BLUE);
      marker.visible = true;
    }

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
      label.text = typed ? `${typed}▏` : `${moveVertical ? '↕ ' : ''}${fmt(mv.delta.length())}`;
    }

    // Preview lines take the axis colour when the cursor runs along one.
    previewMat.color.set(cursor?.kind === 'axis' ? AXIS_COLORS[cursor.axis] : BLUE);
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
        label.pos = anchor.clone().add(cursor).multiplyScalar(0.5);
        label.text = typed ? `${typed}▏` : fmt(anchor.distanceTo(cursor));
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
      else if (hover != null && model.mesh.faces.has(hover)) highlightFace(hover);
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
  function resetDraw() {
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
      } else model.addMeasurement(anchor, c);
    }
    resetDraw();
  }

  /** Is the point on something that already marks the place (corner, midpoint, edge, guide)? */
  const marksPlace = (c) => ['vertex', 'mid', 'edge', 'guide'].includes(c?.kind);

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
    op = {
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
      // Snap to the level of other corners first, then to the grid step.
      const r = THREE.MathUtils.clamp(0.012 * camDist, 0.03, 0.4);
      let best = null;
      for (const l of op.levels) if (Math.abs(l - d) < r && (best == null || Math.abs(l - d) < Math.abs(best - d))) best = l;
      if (best != null) d = best;
      else if (settings.snap) d = Math.round(d / settings.snap) * settings.snap;
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
    const busy = drawing() || !!op || !!mv;
    const consume = () => { e.preventDefault(); e.stopPropagation(); updatePreview(); };
    // Move tool: ↑ switches between moving along the floor and up / down.
    if (tool === 'move' && e.key === 'ArrowUp') {
      moveVertical = !moveVertical;
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
    const unitKey = typed && /^[mc]$/i.test(e.key);
    if ((allowed.test(e.key) || unitKey) && !(e.key === ' ' && !typed)) { typed += e.key; consume(); return; }
    if (e.key === 'Backspace' && typed) { typed = typed.slice(0, -1); consume(); return; }
    if (e.key === 'Enter' && typed) { applyTyped(); consume(); return; }
    if (e.key === 'Escape' && typed) { typed = ''; consume(); }
  }, true);

  // --- move ---
  /** Points that move with the selection (each once): selected faces / edges, groups, measurements. */
  function moveTargets() {
    const out = [], seen = new Set();
    const add = (p) => { if (p && !seen.has(p)) { seen.add(p); out.push({ p, orig: p.clone() }); } };
    const m = model.mesh;
    for (const f of model.selectedFaces) m.faces.get(f)?.loops.flat().forEach((v) => add(m.vertices.get(v)));
    for (const id of model.selectedEdges) { const e = m.edges.get(id); if (e) { add(m.vertices.get(e.a)); add(m.vertices.get(e.b)); } }
    for (const g of model.selectedGroups) for (const v of model.groups.get(g).mesh.vertices.values()) add(v);
    for (const id of model.selectedMeasurements) { const it = model.measurements.find((x) => x.id === id); if (it) { add(it.a); add(it.b); } }

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
    for (const g of model.guides) if (g.from && onMoving(g.from)) { add(g.p); add(g.from); }
    for (const it of model.measurements) { if (onMoving(it.a)) add(it.a); if (onMoving(it.b)) add(it.b); }
    return out;
  }

  /** Nothing selected: Move takes what's under the cursor (as a click with Select would). */
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
    if (!model.selection.size) selectUnder(e);
    if (!model.selection.size || !cursor) return false;
    const targets = moveTargets();
    if (!targets.length) return false;
    model.checkpoint();
    mv = { base: cursor.clone(), targets, exclude: new Set(targets.map((t) => t.p)), delta: new THREE.Vector3(), byPress: true };
    return true;
  }

  function applyMove(delta) {
    mv.delta.copy(delta);
    for (const t of mv.targets) t.p.copy(t.orig).add(delta);
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
      if (raw) {
        let dy = raw.y - mv.base.y;
        if (settings.snap) dy = Math.round(dy / settings.snap) * settings.snap;
        target = Object.assign(mv.base.clone(), { kind: 'angle' });
        target.y += dy;
      }
    } else {
      const floor = makePlane(UP, mv.base);
      const raw = rayToPlane(e, floor);
      if (raw) target = snap(raw, floor, null, mv.exclude);
      if (target && shift) {
        // Shift: straight along X or Z, whichever it's closer to.
        const d = target.clone().sub(mv.base);
        const axis = Math.abs(d.x) >= Math.abs(d.z) ? 'x' : 'z';
        const locked = Object.assign(mv.base.clone(), { kind: 'angle' });
        locked[axis] += d[axis];
        target = locked;
      }
    }
    if (!target) return;
    cursor = target;
    applyMove(target.clone().sub(mv.base));
  }

  function endMove(keep) {
    if (!mv) return;
    if (keep && mv.delta.lengthSq() > 1e-12) model.sync(true);
    else {
      for (const t of mv.targets) t.p.copy(t.orig);
      model.dropCheckpoint();
      model.sync(false);
    }
    mv = null;
    typed = '';
  }
  const commitMove = () => endMove(true);
  const cancelMove = () => endMove(false);

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
      person.place(cursor.x, cursor.z);
      aiming = { x: cursor.x, z: cursor.z };
      model.sync(false); // refresh undo button state
    } else if ((tool === 'rect' || tool === 'circle' || tool === 'measure') && !anchor && cursor) {
      // (Measure from an edge or guide: the line comes along, the result will be a guide.)
      anchor = Object.assign(cursor.clone(), { edge: tool === 'measure' && (cursor.kind === 'edge' || cursor.kind === 'guide') ? cursor.edge : null });
      plane = hoverPlane;
      anchorPress = true;
    } else if (tool === 'pushpull' && !op) {
      setRay(e);
      const hit = model.pickFace(raycaster);
      if (hit && hit.group == null && model.mesh.canPushPull(hit.face)) { startOp(e, hit); e.stopPropagation(); }
    } else if (tool === 'move' && !mv) {
      if (startMove(e)) e.stopPropagation();
    }
    updatePreview();
  }, true);

  window.addEventListener('pointermove', (e) => {
    lastPointer = e;
    // Orbiting / panning with a left-drag (Orbit, Pan tools) or middle-drag: a grabbing hand while it lasts.
    if (press && (press.button === 1 || (press.button === 0 && (tool === 'orbit' || tool === 'pan')))
      && Math.hypot(e.clientX - press.x, e.clientY - press.y) > CLICK_TOLERANCE_PX) canvas.style.cursor = 'grabbing';
    if (boxStart && Math.hypot(e.clientX - boxStart.x, e.clientY - boxStart.y) > CLICK_TOLERANCE_PX) showBox(e);
    if (!aiming && !op && !mv && !drawing() && e.target !== canvas) return;
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
    }
    anchorPress = false;
    updatePreview();
  });

  canvas.addEventListener('dblclick', () => { if (tool === 'line') { finishLine(); updatePreview(); } });

  const refreshFromLastPointer = () => {
    if (lastPointer && (lastPointer.target === canvas || drawing())) updateCursor(lastPointer);
    updatePreview();
  };
  window.addEventListener('keydown', (e) => { if (e.key === 'Shift') { shift = true; refreshFromLastPointer(); } });
  window.addEventListener('keyup', (e) => { if (e.key === 'Shift') { shift = false; refreshFromLastPointer(); } });

  model.onChange(() => {
    if (op || mv) return;
    if (hover != null && !model.mesh.faces.has(hover)) hover = null;
    updatePreview();
  });

  // --- public API ---
  function cancel() {
    const busy = drawing() || !!op || !!mv;
    cancelOp();
    cancelMove();
    resetDraw();
    updatePreview();
    return busy;
  }

  /** The tool's own cursor (while orbiting, a grabbing hand shows instead). */
  const toolCursor = () => ({ select: 'default', orbit: 'default', pan: 'default', pushpull: 'ns-resize', move: 'move' }[tool] ?? 'crosshair');

  function setTool(t) {
    cancel();
    tool = t;
    hover = null;
    if (!['select', 'orbit', 'pan', 'move'].includes(t) && model.selection.size) model.select([]); // Move works on the selection
    controls.mouseButtons.LEFT = t === 'orbit' ? THREE.MOUSE.ROTATE : t === 'pan' ? THREE.MOUSE.PAN : null; // Select drags a box instead
    canvas.style.cursor = toolCursor();
    toolListeners.forEach((fn) => fn(t));
    updatePreview();
  }

  return {
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
    get busy() { return drawing() || !!op || !!mv; },
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
      if (op || mv) return;
      // While drawing a line, undo takes back the last edge.
      if (chain.length > 1) { model.undo(); chain.pop(); }
      else if (drawing()) resetDraw();
      else model.undo();
      updatePreview();
    },
    redo() {
      if (op || mv || drawing()) return;
      model.redo();
    },
  };
}
