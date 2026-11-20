import * as THREE from 'three';
import { pushPull, facePolygon, faceNormal, profileOf } from './model.js';

/*
 * Tools
 *  - select:   click a shape or line to select it (left-drag still orbits).
 *  - line:     click points; clicking the first point again closes the loop into a face.
 *              Enter / double-click / right-click finishes an open chain as lines.
 *  - rect:     two opposite corners (click-click or drag). Shift = square.
 *  - circle:   centre, then radius (click-click or drag).
 *  - pushpull: grab a face and move it along its direction (drag, or click-move-click).
 *  - person:   place the person; drag while placing to set the facing direction.
 *
 * Shapes are drawn on the ground or on the top face under the cursor.
 * While drawing / pushing, typing a value + Enter sets it exactly:
 *   line = length · rect = width;depth (or width,depth) · circle = radius · push/pull = distance.
 */

const CLICK_TOLERANCE_PX = 5;
const BLUE = 0x2a6df4;
const ORANGE = 0xf28c28;

const dist = (p, q) => Math.hypot(p.x - q.x, p.z - q.z);
const round6 = (v) => Math.round(v * 1e6) / 1e6;
const fmt = (m) => `${m.toFixed(2)} m`;

export function createTools({ getCamera, canvas, controls, scene, model, settings, person }) {
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  let tool = 'select';
  let plane = null; // y of the drawing plane while a shape is in progress
  let chain = []; // line tool: points {x,y,z}
  let anchor = null; // rect corner / circle centre {x,y,z}
  let anchorPress = false; // anchor was set by the current press (so release = drag end, not 2nd click)
  let op = null; // push/pull in progress
  let hover = null; // push/pull: face under the cursor { shape, face }
  let cursor = null; // snapped point {x,y,z,kind}
  let typed = ''; // typed value (measurements box)
  let press = null; // { x, y, button } of the current mouse press
  let aiming = null; // person tool: placed point; drag sets facing
  let shift = false;
  let lastPointer = null;
  const toolListeners = new Set();

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
  const markerMat = new THREE.MeshBasicMaterial({ color: BLUE, depthTest: false, transparent: true });
  const marker = new THREE.Mesh(new THREE.RingGeometry(0.07, 0.12, 32).rotateX(-Math.PI / 2), markerMat);
  marker.renderOrder = 11;
  const helpers = [preview, fill, hiFill, hiLine, marker];
  for (const h of helpers) { h.visible = false; h.raycast = () => {}; scene.add(h); }

  const setPoints = (obj, pts) => { obj.geometry.dispose(); obj.geometry = new THREE.BufferGeometry().setFromPoints(pts); };

  /** Triangulated fill for a planar polygon (horizontal, or a vertical quad). */
  function fillGeometry(pts) {
    if (pts.length === 4 && Math.abs(pts[0].y - pts[2].y) > 1e-6) {
      const [a, b, c, d] = pts;
      return new THREE.BufferGeometry().setFromPoints([a, b, c, a, c, d]);
    }
    const tris = THREE.ShapeUtils.triangulateShape(pts.map((p) => new THREE.Vector2(p.x, p.z)), []);
    return new THREE.BufferGeometry().setFromPoints(tris.flat().map((i) => pts[i]));
  }

  // --- picking & snapping ---
  function setRay(e) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, getCamera());
  }

  function rayToPlane(e, y) {
    setRay(e);
    const hit = raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), new THREE.Vector3());
    return hit ? { x: hit.x, y, z: hit.z } : null;
  }

  /** Drawing plane under the cursor: a top face, else the ground. */
  function planeUnder(e) {
    setRay(e);
    const hit = model.pick(raycaster);
    return hit && hit.face.type === 'top' ? hit.shape.base + hit.shape.height : 0;
  }

  function snap(raw, from) {
    const cam = getCamera();
    // Snap radius grows with distance so it feels the same at any zoom.
    const r = THREE.MathUtils.clamp(0.012 * cam.position.distanceTo(new THREE.Vector3(raw.x, raw.y, raw.z)), 0.05, 0.6);
    let best = null;
    let bestD = r;
    const candidates = [...model.verticesAt(raw.y), ...chain, ...(anchor ? [anchor] : [])];
    for (const p of candidates) {
      const d = dist(p, raw);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (best) return { x: best.x, y: raw.y, z: best.z, kind: 'vertex' };
    const step = settings.snap;
    if (from && shift && tool === 'line') {
      const ang = Math.round(Math.atan2(raw.z - from.z, raw.x - from.x) / (Math.PI / 4)) * (Math.PI / 4);
      let len = dist(raw, from);
      if (step) len = Math.round(len / step) * step;
      return { x: round6(from.x + Math.cos(ang) * len), y: raw.y, z: round6(from.z + Math.sin(ang) * len), kind: 'angle' };
    }
    if (!step) return { ...raw, kind: 'free' };
    return { x: round6(Math.round(raw.x / step) * step), y: raw.y, z: round6(Math.round(raw.z / step) * step), kind: 'grid' };
  }

  const drawing = () => chain.length > 0 || !!anchor;
  const isDrawTool = () => tool === 'line' || tool === 'rect' || tool === 'circle';

  function updateCursor(e) {
    cursor = null;
    if (tool === 'person') {
      const raw = rayToPlane(e, 0);
      if (raw) cursor = { ...raw, kind: 'free' };
    } else if (isDrawTool()) {
      const y = plane ?? planeUnder(e);
      const raw = rayToPlane(e, y);
      if (raw) cursor = snap(raw, tool === 'line' ? chain.at(-1) : null);
    } else if (tool === 'pushpull') {
      if (op) updateOp(e);
      else {
        setRay(e);
        const hit = model.pick(raycaster);
        hover = hit ? { shape: hit.shape, face: hit.face } : null;
      }
    }
  }

  // --- shapes from the current input ---
  function rectCorners(a, c) {
    let dx = c.x - a.x, dz = c.z - a.z;
    if (shift) { const s = Math.max(Math.abs(dx), Math.abs(dz)); dx = Math.sign(dx || 1) * s; dz = Math.sign(dz || 1) * s; }
    return [{ x: a.x, z: a.z }, { x: a.x + dx, z: a.z }, { x: a.x + dx, z: a.z + dz }, { x: a.x, z: a.z + dz }];
  }

  // --- preview ---
  function setLabel(pos, text) {
    label.pos = pos;
    label.text = typed ? `${typed}▏` : text;
  }

  function updatePreview() {
    for (const h of helpers) h.visible = false;
    label.pos = null;

    if (cursor && (isDrawTool() || tool === 'person')) {
      marker.position.set(cursor.x, cursor.y + 0.01, cursor.z);
      markerMat.color.set(cursor.kind === 'vertex' ? ORANGE : BLUE);
      marker.visible = true;
    }

    if (tool === 'line' && chain.length) {
      const pts = [...chain, ...(cursor ? [cursor] : [])].map((p) => new THREE.Vector3(p.x, p.y + 0.003, p.z));
      setPoints(preview, pts);
      preview.visible = true;
      const a = chain.at(-1);
      if (cursor) setLabel(new THREE.Vector3((a.x + cursor.x) / 2, a.y + 0.25, (a.z + cursor.z) / 2), fmt(dist(a, cursor)));
    }

    if (tool === 'rect' && anchor && cursor) {
      const c = rectCorners(anchor, cursor).map((p) => new THREE.Vector3(p.x, plane + 0.003, p.z));
      setPoints(preview, [...c, c[0]]);
      fill.geometry.dispose();
      fill.geometry = fillGeometry(c);
      preview.visible = fill.visible = true;
      const w = Math.abs(c[1].x - c[0].x), d = Math.abs(c[3].z - c[0].z);
      setLabel(new THREE.Vector3((c[0].x + c[2].x) / 2, plane + 0.25, (c[0].z + c[2].z) / 2), `${w.toFixed(2)} × ${d.toFixed(2)} m`);
    }

    if (tool === 'circle' && anchor && cursor) {
      const radius = dist(anchor, cursor);
      if (radius > 1e-4) {
        const ring = profileOf({ kind: 'circle', center: anchor, radius }).map((p) => new THREE.Vector3(p.x, plane + 0.003, p.z));
        setPoints(preview, [...ring, ring[0]]);
        fill.geometry.dispose();
        fill.geometry = fillGeometry(ring);
        preview.visible = fill.visible = true;
      }
      setLabel(new THREE.Vector3((anchor.x + cursor.x) / 2, plane + 0.25, (anchor.z + cursor.z) / 2), `R ${fmt(radius)}`);
    }

    if (tool === 'pushpull') {
      const target = op ? { shape: model.byId(op.id), face: op.face } : hover;
      if (target?.shape) {
        highlightFace(target.shape, target.face);
        if (op) {
          const n = op.normal;
          setLabel(op.anchor.clone().addScaledVector(n, op.d).add(new THREE.Vector3(0, 0.25, 0)), fmt(op.d));
        }
      }
    }
  }

  function highlightFace(shape, face) {
    const poly = facePolygon(shape, face);
    if (poly) {
      hiFill.geometry.dispose();
      hiFill.geometry = fillGeometry(poly);
      const seg = poly.flatMap((p, i) => [p, poly[(i + 1) % poly.length]]);
      setPoints(hiLine, seg);
      hiFill.visible = hiLine.visible = true;
    } else {
      // A circle's round side: outline both rims.
      const P = profileOf(shape);
      const y0 = shape.base, y1 = shape.base + shape.height;
      const seg = [];
      for (const y of [y0, y1]) {
        P.forEach((p, i) => { const q = P[(i + 1) % P.length]; seg.push(new THREE.Vector3(p.x, y, p.z), new THREE.Vector3(q.x, y, q.z)); });
      }
      setPoints(hiLine, seg);
      hiLine.visible = true;
    }
  }

  // --- drawing actions ---
  function resetDraw() {
    chain = [];
    anchor = null;
    anchorPress = false;
    plane = null;
    typed = '';
  }

  function addChainPoint(p) {
    if (!p) return;
    if (!chain.length) { plane = p.y; chain.push({ x: p.x, y: p.y, z: p.z }); return; }
    if (dist(chain.at(-1), p) < 0.005) return;
    // Back on the first point: close the loop into a face.
    if (chain.length >= 3 && dist(p, chain[0]) < 1e-4) {
      model.addShape({ kind: 'poly', points: chain, base: plane, height: 0, color: settings.color });
      resetDraw();
      return;
    }
    chain.push({ x: p.x, y: p.y, z: p.z });
  }

  /** Finish an open line chain (keeps the segments drawn so far). */
  function finishLine() {
    if (chain.length >= 2) model.addLine(chain);
    resetDraw();
  }

  function completeShape(c = cursor) {
    if (!anchor || !c) return;
    if (tool === 'rect') {
      const pts = rectCorners(anchor, c);
      if (Math.abs(pts[1].x - pts[0].x) > 0.01 && Math.abs(pts[3].z - pts[0].z) > 0.01) {
        model.addShape({ kind: 'poly', points: pts, base: plane, height: 0, color: settings.color });
      }
    } else if (tool === 'circle') {
      const radius = dist(anchor, c);
      if (radius > 0.01) model.addShape({ kind: 'circle', center: { x: anchor.x, z: anchor.z }, radius, base: plane, height: 0, color: settings.color });
    }
    resetDraw();
  }

  // --- push / pull ---
  function startOp(e, hit) {
    model.checkpoint();
    op = {
      id: hit.shape.id,
      face: hit.face,
      orig: structuredClone(hit.shape),
      normal: faceNormal(hit.shape, hit.face),
      anchor: hit.point.clone(),
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
      if (denom < 1e-3) {
        // Looking straight along the normal: use vertical mouse movement instead.
        d = (op.startY - e.clientY) * 0.002 * getCamera().position.distanceTo(op.anchor);
      } else {
        d = (b * D.dot(w0) - N.dot(w0)) / denom;
      }
      const step = settings.snap;
      if (step) d = Math.round(d / step) * step;
    }
    const next = pushPull(op.orig, op.face, d);
    if (next) {
      model.setShape(op.id, next);
      model.sync(false);
      op.d = d;
    }
  }

  function commitOp() {
    if (!op) return;
    if (Math.abs(op.d) < 1e-6) {
      model.setShape(op.id, op.orig);
      model.dropCheckpoint();
      model.sync(false);
    } else {
      model.sync(true);
    }
    op = null;
    typed = '';
  }

  function cancelOp() {
    if (!op) return;
    model.setShape(op.id, op.orig);
    model.dropCheckpoint();
    model.sync(false);
    op = null;
    typed = '';
  }

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
      let dx = cursor.x - a.x, dz = cursor.z - a.z;
      const l = Math.hypot(dx, dz);
      if (l < 1e-6) { dx = 1; dz = 0; } else { dx /= l; dz /= l; }
      const p = { x: round6(a.x + dx * v), y: a.y, z: round6(a.z + dz * v) };
      addChainPoint(p);
    } else if (tool === 'rect' && anchor) {
      const w = Math.abs(v), d = Math.abs(nums[1] ?? v);
      const sx = Math.sign((cursor?.x ?? anchor.x + 1) - anchor.x) || 1;
      const sz = Math.sign((cursor?.z ?? anchor.z + 1) - anchor.z) || 1;
      const wasShift = shift; shift = false;
      completeShape({ x: anchor.x + sx * w, y: plane, z: anchor.z + sz * d });
      shift = wasShift;
    } else if (tool === 'circle' && anchor) {
      completeShape({ x: anchor.x + Math.abs(v), y: plane, z: anchor.z });
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
      anchor = { x: cursor.x, y: cursor.y, z: cursor.z };
      plane = cursor.y;
      anchorPress = true;
    } else if (tool === 'pushpull' && !op) {
      setRay(e);
      const hit = model.pick(raycaster);
      if (hit) { startOp(e, hit); e.stopPropagation(); }
    }
    updatePreview();
  }, true);

  window.addEventListener('pointermove', (e) => {
    lastPointer = e;
    if (!aiming && !op && !drawing() && e.target !== canvas) return;
    updateCursor(e);
    if (aiming && cursor && dist(aiming, cursor) > 0.15) person.face(Math.atan2(cursor.z - aiming.z, cursor.x - aiming.x));
    updatePreview();
  });

  window.addEventListener('pointerup', (e) => {
    if (!press) return;
    const moved = Math.hypot(e.clientX - press.x, e.clientY - press.y) > CLICK_TOLERANCE_PX;
    const button = press.button;
    press = null;

    if (aiming) { aiming = null; person.save(); return; }
    if (button === 2 && !moved) {
      // Right-click: finish a line chain; cancel anything else in progress.
      if (op) cancelOp();
      else if (tool === 'line') finishLine();
      else resetDraw();
      updatePreview();
      return;
    }
    if (button !== 0) return;

    if (tool === 'select' && !moved) {
      setRay(e);
      const hit = model.pick(raycaster);
      model.select(hit ? hit.shape.id : model.pickLine(raycaster)?.id ?? null);
    } else if (tool === 'line' && !moved) {
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

  model.onChange(() => { if (!op) updatePreview(); });

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
    if (t !== 'select') model.select(null);
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
    /** Enter: finish an open line chain. */
    finish() {
      if (tool === 'line') finishLine();
      updatePreview();
    },
    undo() {
      if (op) return;
      // While drawing a line, undo takes back the last point.
      if (chain.length > 1) chain.pop();
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
