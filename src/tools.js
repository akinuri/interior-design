import * as THREE from 'three';
import { BOX_GEO, layoutWall, wallLength } from './walls.js';

const CLICK_TOLERANCE_PX = 5;
const ENDPOINT_SNAP_M = 0.3;

const dist = (p, q) => Math.hypot(p.x - q.x, p.z - q.z);
const round6 = (v) => Math.round(v * 1e6) / 1e6;
const fmt = (m) => `${m.toFixed(2)} m`;

/**
 * Tools:
 *  - select: click a wall to select it, drag the endpoint handles to reshape
 *            (connected walls follow).
 *  - wall:   click-click-click to draw a chain of walls.
 *  - room:   two corners (click-click or drag) make a rectangle of 4 walls.
 */
export function createTools({ getCamera, canvas, controls, scene, walls, settings, person }) {
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  let tool = 'select';
  let chain = []; // points of the wall chain being drawn
  let roomStart = null;
  let roomStartedThisPress = false;
  let cursor = null; // snapped ground point under the pointer
  let press = null; // { x, y, button } of the current mouse press
  let drag = null; // endpoint drag in select mode
  let aiming = null; // person tool: placed point, drag sets facing
  let shift = false;
  let lastPointer = null;
  const toolListeners = new Set();

  // Measurement label anchor in world space (read by main loop).
  const label = { pos: null, text: '' };

  // --- visuals ---
  const ghostMat = new THREE.MeshBasicMaterial({ color: 0x2a6df4, transparent: true, opacity: 0.35, depthWrite: false });
  const ghosts = Array.from({ length: 4 }, () => {
    const m = new THREE.Mesh(BOX_GEO, ghostMat);
    m.visible = false;
    m.renderOrder = 2;
    scene.add(m);
    return m;
  });

  const markerMat = new THREE.MeshBasicMaterial({ color: 0x2a6df4, depthTest: false, transparent: true });
  const marker = new THREE.Mesh(new THREE.RingGeometry(0.07, 0.12, 32).rotateX(-Math.PI / 2), markerMat);
  marker.renderOrder = 10;
  marker.visible = false;
  scene.add(marker);

  const handleMat = new THREE.MeshBasicMaterial({ color: 0x2a6df4, depthTest: false, transparent: true });
  const handles = [0, 1].map((i) => {
    const h = new THREE.Mesh(new THREE.SphereGeometry(0.11, 20, 12), handleMat);
    h.renderOrder = 11;
    h.visible = false;
    h.userData.end = i === 0 ? 'a' : 'b';
    scene.add(h);
    return h;
  });

  // --- picking & snapping ---
  function setRay(e) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, getCamera());
  }

  function groundPoint(e) {
    setRay(e);
    const hit = raycaster.ray.intersectPlane(groundPlane, new THREE.Vector3());
    return hit ? { x: hit.x, z: hit.z } : null;
  }

  function snap(raw, from, exclude) {
    // 1. existing wall endpoints / chain points
    let best = null;
    let bestD = ENDPOINT_SNAP_M;
    for (const p of walls.endpoints().concat(chain)) {
      if (exclude?.(p)) continue;
      const d = dist(p, raw);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (best) return { x: best.x, z: best.z, kind: 'endpoint' };

    const step = settings.snap;
    // 2. Shift: lock direction to 45° steps from the previous point
    if (from && shift) {
      const ang = Math.round(Math.atan2(raw.z - from.z, raw.x - from.x) / (Math.PI / 4)) * (Math.PI / 4);
      let len = dist(raw, from);
      if (step) len = Math.round(len / step) * step;
      return { x: round6(from.x + Math.cos(ang) * len), z: round6(from.z + Math.sin(ang) * len), kind: 'angle' };
    }
    // 3. grid
    if (!step) return { ...raw, kind: 'free' };
    return { x: round6(Math.round(raw.x / step) * step), z: round6(Math.round(raw.z / step) * step), kind: 'grid' };
  }

  function updateCursor(e) {
    const raw = groundPoint(e);
    if (!raw) { cursor = null; return; }
    if (tool === 'person') {
      cursor = { ...raw, kind: 'free' };
    } else if (drag) {
      cursor = snap(raw, null, (p) => drag.refs.some((r) => r.wall[r.key] === p));
    } else {
      cursor = snap(raw, tool === 'wall' ? chain.at(-1) : null);
    }
  }

  // --- preview ---
  function placeGhost(mesh, a, b) {
    layoutWall(mesh, { a, b, thickness: settings.thickness, height: settings.height });
    mesh.visible = dist(a, b) > 0.001;
  }

  function setLabel(x, z, y, text) {
    label.pos = new THREE.Vector3(x, y + 0.25, z);
    label.text = text;
  }

  function updatePreview() {
    ghosts.forEach((g) => (g.visible = false));
    handles.forEach((h) => (h.visible = false));
    label.pos = null;

    marker.visible = !!cursor && (tool !== 'select' || !!drag);
    if (cursor) {
      marker.position.set(cursor.x, 0.01, cursor.z);
      markerMat.color.set(cursor.kind === 'endpoint' ? 0xf28c28 : 0x2a6df4);
    }

    if (tool === 'wall' && chain.length && cursor) {
      const a = chain.at(-1);
      placeGhost(ghosts[0], a, cursor);
      setLabel((a.x + cursor.x) / 2, (a.z + cursor.z) / 2, settings.height, fmt(dist(a, cursor)));
    }

    if (tool === 'room' && roomStart && cursor) {
      const c = rectCorners(roomStart, cursor);
      for (let i = 0; i < 4; i++) placeGhost(ghosts[i], c[i], c[(i + 1) % 4]);
      const w = Math.abs(cursor.x - roomStart.x);
      const d = Math.abs(cursor.z - roomStart.z);
      setLabel((roomStart.x + cursor.x) / 2, (roomStart.z + cursor.z) / 2, settings.height, `${w.toFixed(2)} × ${d.toFixed(2)} m`);
    }

    const sel = walls.selected;
    if (tool === 'select' && sel) {
      handles[0].position.set(sel.a.x, sel.height, sel.a.z);
      handles[1].position.set(sel.b.x, sel.height, sel.b.z);
      handles.forEach((h) => (h.visible = true));
      setLabel((sel.a.x + sel.b.x) / 2, (sel.a.z + sel.b.z) / 2, sel.height, fmt(wallLength(sel)));
    }
  }

  function rectCorners(p, q) {
    return [
      { x: p.x, z: p.z },
      { x: q.x, z: p.z },
      { x: q.x, z: q.z },
      { x: p.x, z: q.z },
    ];
  }

  // --- actions ---
  function addChainPoint() {
    if (!cursor) return;
    const p = { x: cursor.x, z: cursor.z };
    if (!chain.length) { chain.push(p); return; }
    const last = chain.at(-1);
    if (dist(last, p) < 0.01) return;
    walls.add(last, p, settings);
    chain.push(p);
    // Clicking back on the first point closes the loop and ends the chain.
    if (chain.length > 2 && dist(p, chain[0]) < 0.001) chain = [];
  }

  function finishRoom() {
    if (!roomStart || !cursor) return;
    if (Math.abs(cursor.x - roomStart.x) < 0.05 || Math.abs(cursor.z - roomStart.z) < 0.05) {
      roomStart = null;
      return;
    }
    const c = rectCorners(roomStart, cursor);
    walls.addMany(c.map((p, i) => [p, c[(i + 1) % 4]]), settings);
    roomStart = null;
  }

  function finish() {
    chain = [];
    roomStart = null;
    updatePreview();
  }

  function pickWall(e) {
    setRay(e);
    const hit = raycaster.intersectObjects(walls.group.children, false)[0];
    walls.select(hit ? hit.object.userData.id : null);
  }

  function tryStartDrag(e) {
    const sel = walls.selected;
    if (!sel) return false;
    setRay(e);
    const hit = raycaster.intersectObjects(handles, false)[0];
    if (!hit) return false;
    const orig = { ...sel[hit.object.userData.end] };
    // Every wall endpoint sitting on this corner moves together.
    const refs = [];
    for (const w of walls.list) {
      for (const key of ['a', 'b']) if (dist(w[key], orig) < 1e-4) refs.push({ wall: w, key });
    }
    walls.checkpoint();
    drag = { refs, moved: false, controlsWereEnabled: controls.enabled };
    controls.enabled = false;
    e.stopPropagation(); // keep camera controls (orbit / eye look) out of it
    return true;
  }

  function endDrag() {
    if (drag.moved) {
      walls.pruneDegenerate();
      walls.sync();
    } else {
      walls.dropCheckpoint();
    }
    controls.enabled = drag.controlsWereEnabled;
    drag = null;
  }

  // --- events ---
  // Capture phase on the parent so we run before OrbitControls and can block it.
  canvas.parentElement.addEventListener('pointerdown', (e) => {
    if (e.target !== canvas) return;
    press = { x: e.clientX, y: e.clientY, button: e.button };
    updateCursor(e);
    if (e.button !== 0) return;
    if (tool === 'select') {
      tryStartDrag(e);
    } else if (tool === 'person' && cursor) {
      person.place(cursor.x, cursor.z);
      aiming = { x: cursor.x, z: cursor.z };
    } else if (tool === 'room' && !roomStart && cursor) {
      roomStart = { x: cursor.x, z: cursor.z };
      roomStartedThisPress = true;
    }
    updatePreview();
  }, true);

  window.addEventListener('pointermove', (e) => {
    lastPointer = e;
    if (!drag && !aiming && e.target !== canvas) return;
    updateCursor(e);
    if (aiming && cursor && dist(aiming, cursor) > 0.15) {
      person.face(Math.atan2(cursor.z - aiming.z, cursor.x - aiming.x));
    }
    if (drag && cursor) {
      for (const r of drag.refs) {
        r.wall[r.key].x = cursor.x;
        r.wall[r.key].z = cursor.z;
      }
      drag.moved = true;
      walls.sync(false);
    }
    updatePreview();
  });

  window.addEventListener('pointerup', (e) => {
    if (!press) return;
    const moved = Math.hypot(e.clientX - press.x, e.clientY - press.y) > CLICK_TOLERANCE_PX;
    const button = press.button;
    press = null;

    if (drag) { endDrag(); updatePreview(); return; }
    if (aiming) { aiming = null; person.save(); return; }
    if (button === 2 && !moved) { finish(); return; }
    if (button !== 0) return;

    if (tool === 'select' && !moved) pickWall(e);
    else if (tool === 'wall' && !moved) addChainPoint();
    else if (tool === 'room' && roomStart && (moved || !roomStartedThisPress)) finishRoom();
    roomStartedThisPress = false;
    updatePreview();
  });

  canvas.addEventListener('dblclick', () => { if (tool === 'wall') finish(); });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  const refreshFromLastPointer = () => {
    if (lastPointer && lastPointer.target === canvas) updateCursor(lastPointer);
    updatePreview();
  };
  window.addEventListener('keydown', (e) => { if (e.key === 'Shift') { shift = true; refreshFromLastPointer(); } });
  window.addEventListener('keyup', (e) => { if (e.key === 'Shift') { shift = false; refreshFromLastPointer(); } });

  walls.onChange(() => { if (!drag) updatePreview(); });

  // --- public API ---
  function setTool(t) {
    finish();
    tool = t;
    if (t !== 'select') walls.select(null);
    controls.mouseButtons.LEFT = t === 'select' ? THREE.MOUSE.ROTATE : null;
    canvas.style.cursor = t === 'select' ? 'default' : 'crosshair';
    toolListeners.forEach((fn) => fn(t));
    updatePreview();
  }

  return {
    label,
    setTool,
    get tool() { return tool; },
    onToolChange(fn) { toolListeners.add(fn); },
    /** Returns true if something was in progress and got cancelled. */
    cancel() {
      const busy = chain.length > 0 || !!roomStart;
      finish();
      return busy;
    },
    finish,
    undo() {
      if (drag) return;
      if (walls.undo() && chain.length > 1) chain.pop();
      else if (chain.length === 1) chain = [];
      updatePreview();
    },
    redo() {
      if (drag) return;
      chain = [];
      walls.redo();
    },
  };
}
