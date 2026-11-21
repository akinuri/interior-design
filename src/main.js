import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createGround } from './grid.js';
import { Model, DEFAULT_COLOR } from './model.js';
import { createSky } from './sky.js';
import { createRenderPipeline } from './render.js';
import { createSceneSettings, pickValid, changedFrom } from './sceneSettings.js';
import { createTools, MIN_SIDES, MAX_SIDES } from './tools.js';
import { createPerson } from './person.js';
import { createOrbitCenter } from './orbitCenter.js';
import { createProjectIO } from './io.js';
import { installLogCapture, runDiagnostics, summarize } from './diagnostics.js';
import { initTooltips, setTip } from './tooltips.js';
import { t, getLang, setLang, LANGUAGES, onLangChange, applyTranslations } from './i18n.js';

// --- scene ---
const canvas = document.getElementById('c');
installLogCapture(canvas); // before anything can warn, for the diagnostics report
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap; // supports adjustable softness (shadow.radius)
// Without tone mapping, sun + sky on upward faces overshoot 1.0 and clip;
// Neutral tone mapping rolls highlights off while leaving mid-tones true.
renderer.toneMapping = THREE.NeutralToneMapping;

const scene = new THREE.Scene(); // background, fog, light levels: see sceneSettings.js

// Two cameras: perspective (normal, and always for eye view) and parallel
// (orthographic). `camera` is whichever is active.
const persp = new THREE.PerspectiveCamera(50, 1, 0.05, 3000);
persp.position.set(8, 9, 12);
// Negative near plane so nothing is clipped when the orbit distance is small.
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -2000, 4000);
let camera = persp;

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
// No tilt limit: the camera can orbit all the way round, including below the ground.
controls.minDistance = 1;
controls.maxDistance = 300;
// Right = pan everywhere; middle (or Shift+right) = orbit, so drawing tools can still orbit.
controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };

const sky = new THREE.HemisphereLight(0xffffff, 0xb8b2a8);
scene.add(sky);
const sun = new THREE.DirectionalLight(0xfff3e2); // slightly warm daylight
// The shadow covers a 40 m square that follows the orbit point (see placeSun),
// at high resolution so edges stay clean.
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -20, right: 20, top: 20, bottom: -20, near: 1, far: 120 });
sun.shadow.bias = -0.0003;
sun.shadow.normalBias = 0.02;
sun.userData.direction = new THREE.Vector3(0, 1, 0); // set by the scene settings
scene.add(sun, sun.target);
// Camera light ("View shading"): shines from the camera along the view direction,
// so faces turned toward the viewer are brighter than faces seen at an angle
// (like SketchUp's default shading). No shadows. Follows the camera every frame.
const headLight = new THREE.DirectionalLight(0xffffff);
scene.add(headLight, headLight.target);
const viewDir = new THREE.Vector3();
function placeHeadLight() {
  camera.getWorldDirection(viewDir);
  headLight.position.copy(camera.position);
  headLight.target.position.copy(camera.position).add(viewDir);
}
function placeSun() {
  const focus = person.eye ? camera.position : controls.target;
  // Snap to whole shadow-map texels so shadow edges don't shimmer while moving.
  const texel = 40 / 4096;
  const fx = Math.round(focus.x / texel) * texel;
  const fz = Math.round(focus.z / texel) * texel;
  sun.target.position.set(fx, 0, fz);
  sun.position.set(fx, 0, fz).addScaledVector(sun.userData.direction, 60);
}

const ground = createGround();
scene.add(ground.object);

const skyDome = createSky();
scene.add(skyDome.object);

const pipeline = createRenderPipeline({ renderer, scene, camera: persp });

const environment = createSceneSettings({
  containers: { scene: document.getElementById('scene-fields'), render: document.getElementById('render-fields') },
  resetButtons: { scene: document.getElementById('scene-reset'), render: document.getElementById('render-reset') },
  scene, renderer, pipeline, skyLight: sky, sun, headLight, skyDome, ground,
});

// --- model & tools ---
// Drawing settings (Drawing card), remembered and saved in designs when changed.
const NEW_SHAPE_DEFAULTS = { color: DEFAULT_COLOR, circleSides: 48 };
const DRAWING_KEY = 'interior-design.drawing.v1';
const settings = { ...NEW_SHAPE_DEFAULTS, snap: 0.25 };
try { Object.assign(settings, pickValid(NEW_SHAPE_DEFAULTS, JSON.parse(localStorage.getItem(DRAWING_KEY) ?? '{}'))); } catch { /* ignore */ }
const clampSides = (n) => THREE.MathUtils.clamp(Math.round(n), MIN_SIDES, MAX_SIDES);
settings.circleSides = clampSides(settings.circleSides);
function saveDrawing() {
  try { localStorage.setItem(DRAWING_KEY, JSON.stringify(changedFrom(NEW_SHAPE_DEFAULTS, settings) ?? {})); } catch { /* ignore */ }
}
const model = new Model(scene);
const person = createPerson({ scene, camera: persp, controls, canvas, model });
const tools = createTools({ getCamera: () => camera, canvas, controls, scene, model, settings, person });
person.leftDragLooks = () => tools.tool === 'select';

// --- UI ---
// No browser context menu anywhere (right-click pans / finishes drawing),
// except in text and number fields, where copy / paste is still useful.
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('input[type="text"], input[type="number"], textarea')) e.preventDefault();
});
const $ = (id) => document.getElementById(id);

const toolButtons = document.querySelectorAll('[data-tool]');
toolButtons.forEach((b) => b.addEventListener('click', () => tools.setTool(b.dataset.tool)));
tools.onToolChange((t) => {
  toolButtons.forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
});

// --- person / eye view ---
$('person-height').value = String(person.height);
$('person-height').addEventListener('change', (e) => person.setHeight(num(e.target, person.height)));
function showSpeed() {
  $('person-speed').value = String(person.speed);
  $('person-speed-value').textContent = `${person.speed.toFixed(1)} m/s`;
}
showSpeed();
$('person-speed').addEventListener('input', (e) => { person.setSpeed(parseFloat(e.target.value)); showSpeed(); });
$('person-speed').addEventListener('dblclick', () => { person.setSpeed(1.4); showSpeed(); });
$('eye').addEventListener('click', () => person.toggleEye());
$('person-remove').addEventListener('click', () => {
  if (!person.placed) return;
  model.checkpoint({ extra: true });
  person.remove();
  model.sync(false); // refresh undo button state
});
person.onChange(() => {
  // The Person tool would re-place the person on every click in eye view
  // (where left-drag should look around), so switch to Select.
  if (person.eye && tools.tool === 'person') tools.setTool('select');
  $('eye').classList.toggle('active', person.eye);
  $('person-remove').disabled = !person.placed;
  if (document.activeElement !== $('person-height')) $('person-height').value = String(person.height);
  showSpeed();
});
$('person-remove').disabled = !person.placed;
// In eye view the wheel changes FOV (there's nothing to zoom towards).
canvas.addEventListener('wheel', (e) => {
  if (!person.eye) return;
  e.preventDefault();
  setFov(THREE.MathUtils.clamp(Math.round(persp.fov + Math.sign(e.deltaY) * 3), 20, 100));
}, { passive: false });

// --- files ---
let toastTimer = 0;
function notify(message, isError = false) {
  const t = $('toast');
  t.textContent = message;
  t.classList.toggle('error', isError);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 5000 : 2500);
}
const io = createProjectIO({ getScene, setScene, notify, count: () => model.count });
$('file-open').addEventListener('click', () => { tools.cancel(); io.open(); });
$('file-save').addEventListener('click', () => io.save());

// Screenshot: render one clean frame (no editing helpers) and save it as PNG.
function takeScreenshot() {
  const selected = [...model.selection];
  if (selected.length) model.select([]); // no selection highlight
  const restoreTools = tools.hideHelpers();
  const restorePerson = person.hideHelpers();
  const restoreOrbit = orbitCenter.hide();
  pipeline.render(camera);
  // Read the canvas now, in the same task as the render (the drawing buffer isn't preserved).
  canvas.toBlob((blob) => {
    if (!blob) { notify(t('msg.screenshotFailed'), true); return; }
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: `scene_${new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-')}.png`,
    });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    notify(t('msg.screenshotSaved', { w: canvas.width, h: canvas.height }));
  }, 'image/png');
  restoreTools();
  restorePerson();
  restoreOrbit();
  if (selected.length) model.select(selected);
}
$('screenshot').addEventListener('click', takeScreenshot);

// --- help popup ---
function openHelp() {
  person.exitEye();
  $('help').showModal();
}
$('help-btn').addEventListener('click', openHelp);
$('help-close').addEventListener('click', () => $('help').close());
// A click on the dimmed backdrop (outside the box) closes it.
$('help').addEventListener('click', (e) => { if (e.target === $('help')) $('help').close(); });

$('undo').addEventListener('click', () => tools.undo());
$('redo').addEventListener('click', () => tools.redo());
// Clear = reset all scene objects (shapes, lines and the person) as one undo step.
function clearScene() {
  tools.cancel();
  if (model.isEmpty && !person.placed) return;
  person.exitEye();
  model.clear({ extra: true });
  person.remove();
}
$('clear').addEventListener('click', clearScene);
// Undo / redo of person edits: the model's history carries the person's state.
model.extraState = { get: () => person.getState(), set: (s) => person.setState(s) };

const num = (input, fallback) => {
  const v = parseFloat(input.value);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

// --- orbit centre marker (persisted) ---
const ORBIT_KEY = 'interior-design.orbitCenter.v1';
const orbitCenter = createOrbitCenter(scene);
function setOrbitCenter(on) {
  orbitCenter.enabled = on;
  $('view-orbit').checked = on;
  try { localStorage.setItem(ORBIT_KEY, on ? '1' : '0'); } catch { /* ignore */ }
}
{
  let saved = null;
  try { saved = localStorage.getItem(ORBIT_KEY); } catch { /* ignore */ }
  setOrbitCenter(saved !== '0');
}
$('view-orbit').addEventListener('change', (e) => setOrbitCenter(e.target.checked));

// --- field of view (persisted) ---
const FOV_KEY = 'interior-design.fov.v1';
function setFov(deg) {
  persp.fov = deg;
  persp.updateProjectionMatrix();
  $('view-fov').value = String(deg);
  $('view-fov-value').textContent = `${deg}°`;
  try { localStorage.setItem(FOV_KEY, String(deg)); } catch { /* ignore */ }
}
let savedFov = 50;
try { savedFov = parseFloat(localStorage.getItem(FOV_KEY)) || 50; } catch { /* ignore */ }
setFov(savedFov);
$('view-fov').addEventListener('input', (e) => setFov(parseFloat(e.target.value)));
$('view-fov').addEventListener('dblclick', () => setFov(50));

// --- grid settings (persisted) ---
const GRID_KEY = 'interior-design.grid.v1';
const GRID_DEFAULTS = { visible: true, cell: 0.25, majorEvery: 4, opacity: 1, snap: 'cell' };
const grid = { ...GRID_DEFAULTS };
try { Object.assign(grid, JSON.parse(localStorage.getItem(GRID_KEY) ?? '{}')); } catch { /* ignore */ }

function applyGrid() {
  ground.setOptions(grid);
  settings.snap = grid.snap === 'off' ? 0 : grid.snap === 'half' ? grid.cell / 2 : grid.cell;
  try { localStorage.setItem(GRID_KEY, JSON.stringify(grid)); } catch { /* ignore */ }
}

function syncGridInputs() {
  $('grid-visible').checked = grid.visible;
  $('grid-cell').value = String(grid.cell);
  $('grid-major').value = String(grid.majorEvery);
  $('grid-opacity').value = String(grid.opacity);
  $('grid-snap').value = grid.snap;
}
syncGridInputs();

$('grid-visible').addEventListener('change', (e) => { grid.visible = e.target.checked; applyGrid(); });
$('grid-cell').addEventListener('change', (e) => { grid.cell = parseFloat(e.target.value); applyGrid(); });
$('grid-major').addEventListener('change', (e) => { grid.majorEvery = parseInt(e.target.value, 10); applyGrid(); });
$('grid-opacity').addEventListener('input', (e) => { grid.opacity = parseFloat(e.target.value); applyGrid(); });
$('grid-snap').addEventListener('change', (e) => { grid.snap = e.target.value; applyGrid(); });
applyGrid();
// G toggles the grid
window.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() !== 'g' || e.ctrlKey || e.metaKey || e.target.matches('input, select, textarea')) return;
  grid.visible = !grid.visible;
  $('grid-visible').checked = grid.visible;
  applyGrid();
});

// --- selection card ---
$('sel-delete').addEventListener('click', () => model.deleteSelection());
$('sel-reverse').addEventListener('click', () => model.reverseSelection());
$('sel-close').addEventListener('click', () => model.select([]));

$('set-color').value = settings.color;
$('set-color').addEventListener('input', (e) => { settings.color = e.target.value; saveDrawing(); });
tools.onSidesChange(saveDrawing); // circle sides: typed with the Circle tool, shown at the cursor

// Face colour: preview live while the picker is open, commit one undo step on close.
let pickingColor = false;
$('sel-color').addEventListener('input', (e) => {
  if (!model.selectedFaces.length) return;
  pickingColor = true;
  model.previewColor(e.target.value);
});
$('sel-color').addEventListener('change', (e) => {
  if (!pickingColor) return;
  pickingColor = false;
  model.commitColor(e.target.value);
});

// Selection helpers (Loop / Ring / Grow / Shrink).
document.querySelectorAll('[data-select]').forEach((b) => b.addEventListener('click', () => model.selectHelper(b.dataset.select)));

// Smooth slider: live while dragging, one undo step on release.
let smoothing = false;
const showSmooth = (deg) => { $('sel-smooth-value').textContent = deg > 0 ? `< ${deg}°` : t('f.smooth.off'); };
$('sel-smooth').addEventListener('input', (e) => {
  smoothing = true;
  const deg = parseInt(e.target.value, 10);
  showSmooth(deg);
  model.previewSmoothing(deg);
});
$('sel-smooth').addEventListener('change', (e) => {
  if (!smoothing) return;
  smoothing = false;
  model.commitSmoothing(parseInt(e.target.value, 10));
});

/** Selection summary: area of one face, length of one edge, else counts. */
function selectionSummary(faces, edges) {
  const m = model.mesh;
  if (faces.length === 1 && !edges.length) return ['f.area', `${m.faceArea(faces[0]).toFixed(2)} m\u00b2`];
  // One edge, or the edges of one curve (a circle): its length.
  const curve = m.edges.get(edges[0])?.curve;
  const oneCurve = edges.length > 1 && curve && edges.every((e) => m.edges.get(e).curve === curve) && edges.length === m.curveEdges(edges[0]).length;
  if (!faces.length && (edges.length === 1 || oneCurve)) {
    return ['f.length', `${edges.reduce((s, e) => s + m.edgeLength(e), 0).toFixed(2)} m`];
  }
  const part = (n, one, many) => (n ? [t(n === 1 ? one : many, { n })] : []);
  return ['f.selected', [...part(faces.length, 'sel.face', 'sel.faces'), ...part(edges.length, 'sel.edge', 'sel.edges')].join(', ')];
}

function refreshUI() {
  const faces = model.selectedFaces, edges = model.selectedEdges;
  $('sel-panel').hidden = !faces.length && !edges.length;
  if (faces.length || edges.length) {
    const [key, text] = selectionSummary(faces, edges);
    $('sel-size-label').dataset.i18n = key;
    $('sel-size-label').textContent = t(key);
    $('sel-size').textContent = text;
    $('sel-row-color').hidden = $('sel-reverse').hidden = !faces.length;
    for (const b of document.querySelectorAll('[data-select="loop"], [data-select="ring"]')) b.disabled = !edges.length;
    const canSmooth = model.smoothingEdges().length > 0;
    $('sel-row-smooth').hidden = $('sel-smooth').hidden = !canSmooth;
    if (canSmooth && !smoothing) {
      const deg = model.smoothingAngle();
      $('sel-smooth').value = String(deg);
      showSmooth(deg);
    }
    if (faces.length && !pickingColor) $('sel-color').value = model.mesh.faces.get(faces[0]).color ?? DEFAULT_COLOR;
  }
  $('undo').disabled = !model.undoStack.length;
  $('redo').disabled = !model.redoStack.length;
}
model.onChange(refreshUI);

// --- camera views ---
let fly = null;
/**
 * Animate the orbit camera; `zoom` (optional) also eases the parallel camera's zoom.
 * `duration` in seconds; `easeInOut` starts gently too (for longer moves).
 */
function flyTo(position, target, zoom, { duration = 0.6, easeInOut = false } = {}) {
  fly = { p0: camera.position.clone(), p1: position, t0: controls.target.clone(), t1: target, t: 0, duration, easeInOut };
  if (zoom !== undefined && camera === ortho) Object.assign(fly, { z0: ortho.zoom, z1: zoom });
}
// Standard views: the camera looks at the orbit centre from this side (same distance).
// A tiny sideways nudge on top / bottom keeps the orbit controls' "up" well defined.
const STD_VIEWS = {
  top: new THREE.Vector3(0, 1, 0.0005),
  bottom: new THREE.Vector3(0, -1, 0.0005),
  left: new THREE.Vector3(-1, 0, 0),
  right: new THREE.Vector3(1, 0, 0),
  front: new THREE.Vector3(0, 0, 1),
  back: new THREE.Vector3(0, 0, -1),
};
let stdView = null; // the standard view we're in (null = free view)
let viewBefore = null; // where to go back to when the active view's button is clicked again
const viewButtons = document.querySelectorAll('[data-view]');
function markStdView(name) {
  stdView = name;
  viewButtons.forEach((b) => b.classList.toggle('active', b.dataset.view === name));
}
function setStdView(name) {
  person.exitEye();
  const target = controls.target.clone();
  if (stdView === name && viewBefore) {
    // Same button again: back to the free view we came from.
    flyTo(viewBefore.position, viewBefore.target);
    viewBefore = null;
    markStdView(null);
    return;
  }
  if (!stdView) viewBefore = { position: camera.position.clone(), target };
  const d = Math.max(camera.position.distanceTo(target), 8);
  flyTo(target.clone().addScaledVector(STD_VIEWS[name].clone().normalize(), d), target);
  markStdView(name);
}
viewButtons.forEach((b) => b.addEventListener('click', () => setStdView(b.dataset.view)));
// Orbiting away from a standard view leaves it (panning / zooming keep it).
controls.addEventListener('end', () => {
  if (!stdView || fly) return;
  const dir = camera.position.clone().sub(controls.target).normalize();
  if (dir.dot(STD_VIEWS[stdView].clone().normalize()) < 0.9999) { markStdView(null); viewBefore = null; }
});

/**
 * Camera framing that fits `pts` seen from direction `dir` (unit, from the target towards
 * the camera): the points' outline fills the view with a thin margin and sits centred
 * (the target moves sideways / up-down to centre it). Returns { target, dist, fitHeight }
 * (fitHeight: the world height a parallel view should show).
 */
function fitView(pts, center, dir) {
  const FILL = 0.86; // the outline fills this much of the view (a thin margin around it)
  const vHalf = THREE.MathUtils.degToRad(persp.fov) / 2;
  const tanV = Math.tan(vHalf) * FILL, tanH = Math.tan(vHalf) * persp.aspect * FILL;
  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), dir).normalize();
  const up = new THREE.Vector3().crossVectors(dir, right);
  const target = center.clone();
  let dist = 0;
  // A few rounds: fit the distance, then shift the target to centre the outline.
  for (let round = 0; round < 8; round++) {
    const cam = pts.map((q) => { const c = q.clone().sub(target); return { x: c.dot(right), y: c.dot(up), z: c.dot(dir) }; });
    dist = Math.max(...cam.map((c) => Math.max(c.z + Math.abs(c.x) / tanH, c.z + Math.abs(c.y) / tanV)));
    // Outline on screen (in units of the half view), then move its middle to the centre.
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const c of cam) {
      const depth = Math.max(dist - c.z, 1e-3);
      const sx = c.x / (depth * tanH), sy = c.y / (depth * tanV);
      x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
    }
    target.addScaledVector(right, ((x0 + x1) / 2) * tanH * dist).addScaledVector(up, ((y0 + y1) / 2) * tanV * dist);
  }
  const cam = pts.map((q) => { const c = q.clone().sub(target); return { x: c.dot(right), y: c.dot(up), z: c.dot(dir) }; });
  dist = Math.max(...cam.map((c) => Math.max(c.z + Math.abs(c.x) / tanH, c.z + Math.abs(c.y) / tanV)));
  // Parallel view: no perspective, so centre on the outline's extent directly.
  const xs = cam.map((c) => c.x), ys = cam.map((c) => c.y);
  const [xMin, xMax, yMin, yMax] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const parallelTarget = target.clone().addScaledVector(right, (xMin + xMax) / 2).addScaledVector(up, (yMin + yMax) / 2);
  const fitHeight = Math.max(yMax - yMin, (xMax - xMin) / persp.aspect) / FILL;
  return { target, dist, fitHeight, parallelTarget };
}

/**
 * Home: default 3D angle, framing everything in the scene (shapes, lines + person).
 * An empty scene goes back to the starting view of the origin.
 */
function homeView() {
  person.exitEye();
  markStdView(null);
  viewBefore = null;

  // Everything to frame: the geometry's points and the person.
  const pts = [...model.mesh.vertices.values()].map((v) => v.clone());
  const p = person.getState();
  if (p.placed) pts.push(new THREE.Vector3(p.x, 0, p.z), new THREE.Vector3(p.x, p.height, p.z));
  const box = new THREE.Box3().setFromPoints(pts);

  const dir = new THREE.Vector3().fromArray(DEFAULT_CAMERA.position).normalize();
  let target, dist, fitHeight;
  if (box.isEmpty()) {
    target = new THREE.Vector3().fromArray(DEFAULT_CAMERA.target);
    dist = new THREE.Vector3().fromArray(DEFAULT_CAMERA.position).length();
    fitHeight = visibleHeightAt(dist);
  } else {
    // Tiny scenes are framed as at least 2 m across.
    const size = box.getSize(new THREE.Vector3());
    if (Math.max(size.x, size.y, size.z) < 2) {
      box.expandByVector(new THREE.Vector3(2, 2, 2).sub(size).max(new THREE.Vector3()).multiplyScalar(0.5));
      for (let i = 0; i < 8; i++) pts.push(new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));
    }
    const center = box.getCenter(new THREE.Vector3());
    let parallelTarget;
    ({ target, dist, fitHeight, parallelTarget } = fitView(pts, center, dir));
    if (camera === ortho) target = parallelTarget;
    // Centring moved the target sideways, possibly into empty space or below the ground.
    // Keep the camera (and so the framing) and slide the target along the line of sight
    // to eye height (so the side views look at the scene at eye level), but no higher
    // than the scene itself; else the point nearest the scene's middle.
    const eye = target.clone().addScaledVector(dir, dist);
    const look = dir.clone().negate();
    let along = center.clone().sub(eye).dot(look);
    if (look.y < -1e-6) {
      const level = THREE.MathUtils.clamp(person.height * 0.93, 0, Math.max(box.max.y, 0));
      along = (eye.y - level) / -look.y;
    }
    target = eye.clone().addScaledVector(look, Math.max(along, 0.5));
    dist = eye.distanceTo(target);
  }
  const zoom = camera === ortho ? orthoViewHeight / fitHeight : undefined;
  flyTo(target.clone().addScaledVector(dir, dist), target.clone(), zoom, { duration: 1.0, easeInOut: true });
}
$('home').addEventListener('click', homeView);

// --- parallel (orthographic) projection ---
// The parallel camera's visible height is matched to what the perspective
// camera shows at the orbit target, so toggling keeps the framing.
let orthoViewHeight = 10; // world height visible at zoom 1
function updateOrthoFrustum() {
  const h = orthoViewHeight / 2;
  Object.assign(ortho, { left: -h * persp.aspect, right: h * persp.aspect, top: h, bottom: -h });
  ortho.updateProjectionMatrix();
}
const visibleHeightAt = (dist) => 2 * dist * Math.tan(THREE.MathUtils.degToRad(persp.fov) / 2);

/** Where the perspective camera would be to show what the parallel camera shows now. */
function perspEquivalentPosition() {
  const dist = (orthoViewHeight / ortho.zoom) / (2 * Math.tan(THREE.MathUtils.degToRad(persp.fov) / 2));
  const dir = ortho.position.clone().sub(controls.target).normalize();
  return controls.target.clone().addScaledVector(dir, dist);
}

function setParallel(on) {
  if (on === (camera === ortho)) return;
  if (on) {
    person.exitEye(); // eye view is always perspective
    orthoViewHeight = visibleHeightAt(persp.position.distanceTo(controls.target));
    ortho.position.copy(persp.position);
    ortho.quaternion.copy(persp.quaternion);
    ortho.zoom = 1;
    updateOrthoFrustum();
    camera = ortho;
  } else {
    persp.position.copy(perspEquivalentPosition());
    persp.quaternion.copy(ortho.quaternion);
    camera = persp;
  }
  fly = null;
  controls.object = camera;
  controls.update();
  $('parallel').classList.toggle('active', on);
}
$('parallel').addEventListener('click', () => setParallel(camera !== ortho));
$('eye').addEventListener('click', () => { if (!person.eye) setParallel(false); }, true); // before toggling eye view

// --- whole scene as data (design files) ---
const DEFAULT_CAMERA = { position: [8, 9, 12], target: [0, 0, 0] };
const DEFAULT_FOV = 50;

/**
 * The scene as file data. Shapes, lines and the camera are always included; every
 * setting is included only if it differs from its default (opening a file
 * resets everything to defaults first, so omitted = default).
 */
function getScene() {
  const p = person.getState();
  // The camera is stored as a perspective orbit view (in eye view: the one to return to;
  // in parallel view: the equivalent framing) plus a `parallel` flag.
  const parallel = camera === ortho;
  const orbit = parallel ? { position: perspEquivalentPosition(), target: controls.target } : person.orbitView();
  return {
    ...model.toData(), // geometry
    // A person that isn't placed has nothing worth saving except changed height / speed.
    person: changedFrom(person.defaults, p.placed ? p : { ...person.defaults, height: p.height, speed: p.speed }),
    environment: environment.getChanged(),
    grid: changedFrom(GRID_DEFAULTS, grid),
    newShapes: changedFrom(NEW_SHAPE_DEFAULTS, settings),
    view: {
      fov: persp.fov !== DEFAULT_FOV ? persp.fov : undefined,
      parallel: parallel || undefined,
      orbitCenter: orbitCenter.enabled ? undefined : false,
      camera: { position: orbit.position.toArray(), target: orbit.target.toArray() },
    },
  };
}

/** Replace the entire scene with `data`; anything missing gets its default. */
function setScene(data) {
  tools.cancel();
  tools.setTool('select');
  person.setState(data.person); // also leaves eye view
  const count = model.replaceAll(data); // also converts shapes / walls from older files
  environment.set(data.environment);

  Object.assign(grid, pickValid(GRID_DEFAULTS, data.grid));
  // Dropdown-backed values must be one of the offered options.
  const allowed = (id) => [...$(id).options].map((o) => o.value);
  if (!allowed('grid-cell').includes(String(grid.cell))) grid.cell = GRID_DEFAULTS.cell;
  if (!allowed('grid-major').includes(String(grid.majorEvery))) grid.majorEvery = GRID_DEFAULTS.majorEvery;
  if (!allowed('grid-snap').includes(grid.snap)) grid.snap = GRID_DEFAULTS.snap;
  grid.opacity = THREE.MathUtils.clamp(grid.opacity, 0.1, 1);
  syncGridInputs();
  applyGrid();

  Object.assign(settings, pickValid(NEW_SHAPE_DEFAULTS, data.newShapes ?? data.newWalls)); // older files: wall colour
  settings.circleSides = clampSides(settings.circleSides);
  $('set-color').value = settings.color;
  saveDrawing();

  const fov = data.view?.fov;
  setFov(Number.isFinite(fov) ? THREE.MathUtils.clamp(fov, 20, 100) : DEFAULT_FOV);
  const vec3 = (v, fallback) => (Array.isArray(v) && v.length === 3 && v.every(Number.isFinite) ? v : fallback);
  setParallel(false);
  persp.position.fromArray(vec3(data.view?.camera?.position, DEFAULT_CAMERA.position));
  controls.target.fromArray(vec3(data.view?.camera?.target, DEFAULT_CAMERA.target));
  controls.update();
  setParallel(data.view?.parallel === true);
  setOrbitCenter(data.view?.orbitCenter !== false);
  markStdView(null);
  viewBefore = null;
  return count;
}

// --- keyboard ---
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  if ($('help').open) return; // help popup handles its own keys (Esc closes it)
  if (e.key === '?') { e.preventDefault(); openHelp(); return; }
  const k = e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? tools.redo() : tools.undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); tools.redo(); return; }
  if (mod && k === 's') { e.preventDefault(); io.save(); return; }
  if (mod && k === 'o') { e.preventDefault(); tools.cancel(); io.open(); return; }
  if (mod && k === 'a') { e.preventDefault(); tools.setTool('select'); model.selectAll(); return; }
  if (mod) return;
  if (person.isMoveKey(k)) return; // WASD / arrows walk in eye view
  if (k === 'v') tools.setTool('select');
  else if (k === 'l') tools.setTool('line');
  else if (k === 'r') tools.setTool('rect');
  else if (k === 'c') tools.setTool('circle');
  else if (k === 'p') tools.setTool('pushpull');
  else if (k === 'u') tools.setTool('person');
  else if (k === 'e') { if (!person.eye) setParallel(false); person.toggleEye(); }
  else if (k === 't') setStdView('top');
  else if (k === 'h') homeView();
  else if (k === 'o') setParallel(camera !== ortho);
  else if (k === 'enter') tools.finish();
  else if (k === 'escape') {
    if (tools.cancel()) return;
    if (person.eye) person.exitEye();
    else model.select([]);
  }
  else if (k === 'delete' || k === 'backspace') model.deleteSelection();
});

// --- render loop ---
const measure = $('measure');
const viewport = $('viewport');
function resize() {
  const { clientWidth: w, clientHeight: h } = viewport;
  renderer.setSize(w, h, false);
  pipeline.setSize(w, h);
  persp.aspect = w / h;
  persp.updateProjectionMatrix();
  updateOrthoFrustum();
}
new ResizeObserver(resize).observe(viewport);
resize();

function updateMeasureLabel() {
  const { pos, text } = tools.label;
  if (!pos) { measure.hidden = true; return; }
  const v = pos.clone().project(camera);
  if (v.z > 1) { measure.hidden = true; return; }
  measure.hidden = false;
  measure.textContent = text;
  const x = ((v.x + 1) / 2) * viewport.clientWidth;
  const y = ((1 - v.y) / 2) * viewport.clientHeight;
  measure.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
}

// FPS readout, averaged over half-second windows.
const fpsEl = $('fps');
const fpsWindow = { frames: 0, time: 0 };
function updateFps(dt) {
  fpsWindow.frames++;
  fpsWindow.time += dt;
  if (fpsWindow.time < 0.5) return;
  const fps = fpsWindow.frames / fpsWindow.time;
  fpsEl.textContent = `${Math.round(fps)} fps · ${(1000 / fps).toFixed(1)} ms`;
  fpsEl.classList.toggle('slow', fps < 30);
  fpsWindow.frames = 0;
  fpsWindow.time = 0;
}

const clock = new THREE.Clock();
function frame() {
  const dt = clock.getDelta();
  updateFps(dt);
  if (person.eye) {
    fly = null;
  } else {
    if (fly) {
      fly.t = Math.min(1, fly.t + dt / fly.duration);
      const k = fly.easeInOut
        ? (fly.t < 0.5 ? 4 * fly.t ** 3 : 1 - (-2 * fly.t + 2) ** 3 / 2) // ease-in-out cubic
        : 1 - Math.pow(1 - fly.t, 3); // ease-out cubic
      camera.position.lerpVectors(fly.p0, fly.p1, k);
      controls.target.lerpVectors(fly.t0, fly.t1, k);
      if (fly.z1 !== undefined) {
        ortho.zoom = THREE.MathUtils.lerp(fly.z0, fly.z1, k);
        ortho.updateProjectionMatrix();
      }
      if (fly.t === 1) fly = null;
    }
    controls.update();
  }
  person.update(dt);
  skyDome.update(camera);
  placeSun();
  placeHeadLight();
  skyDome.updateEnvironment(renderer, scene);
  ground.update(camera);
  updateMeasureLabel();
  orbitCenter.update(camera, controls.target, viewport.clientHeight, !person.eye);
  pipeline.render(camera);
}
renderer.setAnimationLoop(frame);

// --- diagnostics: click the FPS readout, or open the page with ?diag ---
let diagRunning = false;
let lastReport = null;
async function startDiagnostics() {
  if (diagRunning) return;
  diagRunning = true;
  const panel = $('diag');
  panel.hidden = false;
  $('diag-actions').hidden = true;
  const out = $('diag-output');
  try {
    lastReport = await runDiagnostics({
      renderer, scene, canvas, sun, pipeline,
      getCamera: () => camera,
      pauseLoop: () => renderer.setAnimationLoop(null),
      resumeLoop: () => { clock.getDelta(); renderer.setAnimationLoop(frame); },
      getAppState: () => ({
        objects: model.count,
        cameraMode: person.eye ? 'eye' : camera === ortho ? 'parallel' : 'perspective',
        fov: persp.fov,
        grid: { ...grid },
        sceneSettingsChanged: environment.getChanged() ?? {},
      }),
      onProgress: (text) => { out.textContent = text; },
    });
    out.textContent = summarize(lastReport);
    $('diag-actions').hidden = false;
  } catch (e) {
    out.textContent = t('msg.diagFailed', { msg: e?.message ?? e });
    $('diag-actions').hidden = false;
  } finally {
    diagRunning = false;
  }
}
fpsEl.addEventListener('click', startDiagnostics);
$('diag-close').addEventListener('click', () => { $('diag').hidden = true; });
$('diag-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(JSON.stringify(lastReport, null, 2)); notify(t('msg.reportCopied')); }
  catch { notify(t('msg.copyFailed'), true); }
});
$('diag-download').addEventListener('click', () => {
  if (!lastReport) return;
  const gpu = (lastReport.webgl.unmaskedRenderer ?? 'gpu').replace(/^ANGLE \(/, '').split(/[,(]/)[0].trim().replace(/[^a-z0-9]+/gi, '-').slice(0, 40);
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([JSON.stringify(lastReport, null, 2)], { type: 'application/json' })),
    download: `diagnostics_${gpu}_${lastReport.takenAt.slice(0, 16).replace(/[T:]/g, '-')}.json`,
  });
  document.body.append(a);
  a.click();
  a.remove();
});
if (new URLSearchParams(location.search).has('diag')) setTimeout(startDiagnostics, 1500);

// Remember which right-side cards are open (per browser).
const CARDS_KEY = 'interior-design.cards.v2'; // v2: new defaults (only New walls open)
let cardState = {};
try { cardState = JSON.parse(localStorage.getItem(CARDS_KEY) ?? '{}'); } catch { /* ignore */ }
const allCards = [...document.querySelectorAll('details.card[data-card]')];
for (const card of allCards) {
  // Ctrl/Cmd+click or middle-click a header: open or close every card,
  // following the clicked one.
  const summary = card.querySelector('summary');
  const toggleAll = () => {
    const open = !card.open;
    for (const c of allCards) c.open = open;
  };
  summary.addEventListener('click', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    toggleAll();
  });
  summary.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); }); // no autoscroll
  summary.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    toggleAll();
  });
  if (typeof cardState[card.dataset.card] === 'boolean') card.open = cardState[card.dataset.card];
  card.addEventListener('toggle', () => {
    cardState[card.dataset.card] = card.open;
    try { localStorage.setItem(CARDS_KEY, JSON.stringify(cardState)); } catch { /* ignore */ }
  });
}

// Scroll shadows on the right panel: show top / bottom shadow when there is
// more content to scroll to in that direction.
{
  const panel = document.querySelector('.panel:not(.selection)');
  const update = () => {
    const max = panel.scrollHeight - panel.clientHeight;
    panel.classList.toggle('more-above', panel.scrollTop > 1);
    panel.classList.toggle('more-below', panel.scrollTop < max - 1);
  };
  panel.addEventListener('scroll', update, { passive: true });
  // Content height changes when cards open/close (animated) or the window resizes.
  const ro = new ResizeObserver(update);
  ro.observe(panel);
  for (const card of panel.querySelectorAll('.card')) ro.observe(card);
  update();
}

// --- phones: settings panel toggle ---
$('panel-btn').addEventListener('click', () => {
  const open = document.body.classList.toggle('panel-open');
  $('panel-btn').classList.toggle('active', open);
});

// --- touch: action bar while drawing / pushing (finish, cancel, exact value) ---
function refreshDrawActions() {
  const busy = tools.busy;
  if ($('draw-actions').hidden === !busy && $('act-done').disabled === !tools.canFinish) return;
  $('draw-actions').hidden = !busy;
  $('act-done').disabled = !tools.canFinish;
  if (!busy) $('act-value').value = '';
}
tools.onStateChange(refreshDrawActions);
$('act-done').addEventListener('click', () => tools.finish());
$('act-cancel').addEventListener('click', () => tools.cancel());
$('act-value').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const v = e.target.value.trim();
  e.target.value = '';
  if (v) tools.enterValue(v);
  e.target.blur(); // close the on-screen keyboard
});

// --- language ---
function showLang() { $('lang-btn').textContent = getLang().toUpperCase(); }
$('lang-btn').addEventListener('click', () => {
  const codes = Object.keys(LANGUAGES);
  setLang(codes[(codes.indexOf(getLang()) + 1) % codes.length]); // cycle EN → TR → …
});
onLangChange(showLang);
applyTranslations(); // static markup + generated controls, before tooltips take over the titles
showLang();

tools.setTool('select');
refreshUI();
initTooltips(); // after all UI (including generated settings controls) exists
