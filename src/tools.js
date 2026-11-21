import * as THREE from 'three';
import { Mesh, GROUND, triangulate } from './mesh.js';
import { CIRCLE_SEGMENTS } from './model.js';

/*
 * Tools
 *  - select:   click a face or edge; double-click adds its neighbours (face → its edges,
 *              edge → its faces); triple-click selects everything connected.
 *              Ctrl = add, Shift = add / remove. Left-drag still orbits.
 *  - line:     click points; each click adds an edge. Closing a loop makes a face;
 *              a line across a face splits it. Enter / double-click / right-click / Esc stops.
 *  - rect:     two opposite corners (click-click or drag). Shift = square.
 *  - circle:   centre, then radius (click-click or drag).
 *  - pushpull: grab a face and move it along its normal (drag, or click-move-click).
 *  - person:   place the person; drag while placing to set the facing direction.
 *
 * Drawing happens on the face under the cursor (any direction: floors, walls, tops),
 * or on the ground. While drawing / pushing, typing a value + Enter sets it exactly:
 *   line = length · rect = width;depth (or width,depth) · circle = radius · push/pull = distance.
 */

const CLICK_TOLERANCE_PX = 5;
const BLUE = 0x2a6df4;
const SNAP_COLORS = { vertex: 0xf28c28, mid: 0x18a6b8, edge: 0xd6336c };
const UP = new THREE.Vector3(0, 1, 0);

const round6 = (v) => Math.round(v * 1e6) / 1e6;
const fmt = (m) => `${m.toFixed(2)} m`;

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
  let hover = null; // push/pull: face id under the cursor
  let cursor = null; // snapped point: THREE.Vector3 with .kind
  let typed = ''; // typed value (measurements box)
  let press = null; // { x, y, button } of the current mouse press
  let lastMoved = false; // the last press was a drag (so its click isn't a selection)
  let aiming = null; // person tool: placed point; drag sets facing
  let shift = false;
  let lastPointer = null;
  const toolListeners = new Set();
  const stateListeners = new Set(); // busy / can-finish changes (touch action bar)

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
  const helpers = [preview, fill, hiFill, hiLine, marker];
  for (const h of helpers) { h.visible = false; h.raycast = () => {}; scene.add(h); }

  const setPoints = (obj, pts) => { obj.geometry.dispose(); obj.geometry = new THREE.BufferGeometry().setFromPoints(pts); };

  /** Slightly in front of the plane (more on the ground, where faces are lifted). */
  const liftOf = (p) => (Math.abs(p.n.y) > 0.999 && Math.abs(p.d) < 1e-4 ? 0.013 : 0.003);

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
    return hit ? model.mesh.facePlane(hit.face) : GROUND;
  }

  function snap(raw, p, from) {
    const cam = getCamera();
    // Snap radius grows with distance so it feels the same at any zoom.
    const r = THREE.MathUtils.clamp(0.012 * cam.position.distanceTo(raw), 0.05, 0.6);
    const m = model.mesh;
    const at = (q, kind) => Object.assign(p.project(q), { kind });

    // Corners (and the points of the shape being drawn).
    let best = null, bestD = r;
    for (const v of [...m.vertices.values(), ...chain, ...(anchor ? [anchor] : [])]) {
      if (!p.has(v, 1e-3)) continue;
      const d = v.distanceTo(raw);
      if (d < bestD) { bestD = d; best = v; }
    }
    if (best) return at(best, 'vertex');
    // Midpoints, then anywhere on an edge.
    const inPlane = [];
    for (const e of m.edges.values()) {
      if (e.soft) continue;
      const A = m.vertices.get(e.a), B = m.vertices.get(e.b);
      if (p.has(A, 1e-3) && p.has(B, 1e-3)) inPlane.push([A, B]);
    }
    bestD = r * 0.8;
    for (const [A, B] of inPlane) {
      const mid = A.clone().add(B).multiplyScalar(0.5);
      const d = mid.distanceTo(raw);
      if (d < bestD) { bestD = d; best = mid; }
    }
    if (best) return at(best, 'mid');
    bestD = r * 0.6;
    for (const [A, B] of inPlane) {
      const q = new THREE.Line3(A, B).closestPointToPoint(raw, true, new THREE.Vector3());
      const d = q.distanceTo(raw);
      if (d < bestD) { bestD = d; best = q; }
    }
    if (best) return at(best, 'edge');

    const step = settings.snap;
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
  const isDrawTool = () => tool === 'line' || tool === 'rect' || tool === 'circle';

  function updateCursor(e) {
    cursor = null;
    if (tool === 'person') {
      const raw = rayToPlane(e, GROUND);
      if (raw) cursor = Object.assign(raw, { kind: 'free' });
    } else if (isDrawTool()) {
      hoverPlane = plane ?? planeUnder(e);
      const raw = rayToPlane(e, hoverPlane);
      if (raw) cursor = snap(raw, hoverPlane, tool === 'line' ? chain.at(-1) : null);
    } else if (tool === 'pushpull') {
      if (op) updateOp(e);
      else {
        setRay(e);
        const hit = model.pickFace(raycaster);
        hover = hit && model.mesh.canPushPull(hit.face) ? hit.face : null;
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
    for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
      const a = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
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

    if (cursor && (isDrawTool() || tool === 'person')) {
      const n = tool === 'person' ? UP : p.n;
      marker.position.copy(cursor).addScaledVector(n, 0.01);
      marker.quaternion.setFromUnitVectors(UP, n);
      markerMat.color.set(SNAP_COLORS[cursor.kind] ?? BLUE);
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
      setLabel(labelAt(c[0].clone().add(c[2]).multiplyScalar(0.5)), `${w.toFixed(2)} × ${d.toFixed(2)} m`);
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
      setLabel(labelAt(anchor.clone().add(cursor).multiplyScalar(0.5)), `R ${fmt(radius)}`);
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
    }
    resetDraw();
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
  function parseTyped(pair) {
    const s = typed.trim();
    let parts = s.split(/[;x×*\s]+/i).filter(Boolean);
    if (pair && parts.length === 1 && s.includes(',')) parts = s.split(',');
    return parts.map((p) => parseFloat(p.replace(',', '.'))).filter(Number.isFinite);
  }

  function applyTyped() {
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
    } else if (tool === 'circle' && anchor) {
      completeShape(anchor.clone().addScaledVector(plane.u, Math.abs(v)));
    } else if (tool === 'pushpull' && op) {
      updateOp(null, v);
      commitOp();
    }
  }

  // Capture phase, so typed digits / Backspace / Enter / Esc are handled here
  // before the app's shortcuts see them.
  window.addEventListener('keydown', (e) => {
    if (e.target.matches?.('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
    const busy = drawing() || !!op;
    if (!busy) return;
    const consume = () => { e.preventDefault(); e.stopPropagation(); updatePreview(); };
    if (/^[0-9.,;x× -]$/i.test(e.key) && !(e.key === ' ' && !typed)) { typed += e.key; consume(); return; }
    if (e.key === 'Backspace' && typed) { typed = typed.slice(0, -1); consume(); return; }
    if (e.key === 'Enter' && typed) { applyTyped(); consume(); return; }
    if (e.key === 'Escape' && typed) { typed = ''; consume(); }
  }, true);

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
    if (edgeHit && faceHit && edgeHit.px > sure) {
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
    const { edgeHit, faceHit } = pickAt(e);
    const m = model.mesh;
    const mode = e.ctrlKey || e.metaKey ? 'add' : e.shiftKey ? 'toggle' : 'replace';
    if (!edgeHit && !faceHit) { if (mode === 'replace') model.select([]); return; }
    let faces = new Set(), edges = new Set();
    if (edgeHit) edges.add(edgeHit.edge);
    else faces = m.surface(faceHit.face); // a smooth surface (cylinder side) is picked as a whole
    if (e.detail === 2) {
      // Face → its edges; edge → its faces.
      if (edgeHit) m.facesOfEdge(edgeHit.edge).forEach((f) => faces.add(f));
      else for (const f of faces) m.faceEdges(f).forEach((x) => { if (!m.edges.get(x).soft) edges.add(x); });
    } else if (e.detail >= 3) {
      ({ faces, edges } = m.connected(faces, edges));
    }
    const keys = [...[...faces].map((f) => `f${f}`), ...[...edges].map((x) => `e${x}`)];
    model.select(keys, e.detail >= 2 && mode !== 'replace' ? 'add' : mode);
  }
  canvas.addEventListener('click', (e) => { if (tool === 'select' && !lastMoved) selectAt(e); });

  // --- pointer events ---
  // Capture phase on the parent so we run before OrbitControls and can block it.
  canvas.parentElement.addEventListener('pointerdown', (e) => {
    if (e.target !== canvas) return;
    press = { x: e.clientX, y: e.clientY, button: e.button };
    updateCursor(e);
    if (e.button !== 0) return;
    if (tool === 'person' && cursor) {
      model.checkpoint({ extra: true }); // placing / moving the person is an undo step
      person.place(cursor.x, cursor.z);
      aiming = { x: cursor.x, z: cursor.z };
      model.sync(false); // refresh undo button state
    } else if ((tool === 'rect' || tool === 'circle') && !anchor && cursor) {
      anchor = cursor.clone();
      plane = hoverPlane;
      anchorPress = true;
    } else if (tool === 'pushpull' && !op) {
      setRay(e);
      const hit = model.pickFace(raycaster);
      if (hit && model.mesh.canPushPull(hit.face)) { startOp(e, hit); e.stopPropagation(); }
    }
    updatePreview();
  }, true);

  window.addEventListener('pointermove', (e) => {
    lastPointer = e;
    if (!aiming && !op && !drawing() && e.target !== canvas) return;
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

    if (aiming) { aiming = null; person.save(); return; }
    if (button === 2 && !moved) {
      // Right-click: stop a line chain; cancel anything else in progress.
      if (op) cancelOp();
      else if (tool === 'line') finishLine();
      else resetDraw();
      updatePreview();
      return;
    }
    if (button !== 0) return;

    if (tool === 'line' && !moved) {
      addChainPoint(cursor);
    } else if ((tool === 'rect' || tool === 'circle') && anchor && (moved || !anchorPress)) {
      completeShape();
    } else if (tool === 'pushpull' && op) {
      if (op.byPress && !moved) op.byPress = false; // click without drag: keep following the mouse
      else commitOp();
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
    if (op) return;
    if (hover != null && !model.mesh.faces.has(hover)) hover = null;
    updatePreview();
  });

  // --- public API ---
  function cancel() {
    const busy = drawing() || !!op;
    cancelOp();
    resetDraw();
    updatePreview();
    return busy;
  }

  function setTool(t) {
    cancel();
    tool = t;
    hover = null;
    if (t !== 'select' && model.selection.size) model.select([]);
    controls.mouseButtons.LEFT = t === 'select' ? THREE.MOUSE.ROTATE : null;
    canvas.style.cursor = t === 'select' ? 'default' : t === 'pushpull' ? 'ns-resize' : 'crosshair';
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
    get busy() { return drawing() || !!op; },
    /** Can the current input be finished without another point (a line chain)? */
    get canFinish() { return tool === 'line' && chain.length >= 2; },
    onStateChange(fn) { stateListeners.add(fn); },
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
      if (op) return;
      // While drawing a line, undo takes back the last edge.
      if (chain.length > 1) { model.undo(); chain.pop(); }
      else if (drawing()) resetDraw();
      else model.undo();
      updatePreview();
    },
    redo() {
      if (op || drawing()) return;
      model.redo();
    },
  };
}
