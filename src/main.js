import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createGround } from './grid.js';
import { Walls, wallLength, DEFAULT_WALL_COLOR } from './walls.js';
import { createSky } from './sky.js';
import { createRenderPipeline } from './render.js';
import { createSceneSettings, pickValid, changedFrom } from './sceneSettings.js';
import { createTools } from './tools.js';
import { createPerson } from './person.js';
import { createProjectIO } from './io.js';
import { installLogCapture, runDiagnostics, summarize } from './diagnostics.js';

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
// The tilt limit is recomputed every frame so the camera can go right down to
// just above the ground (and past horizontal if the orbit point is raised by
// panning up), without ever moving anything on its own.
const MIN_CAMERA_Y = 0.1;
function updateTiltLimit() {
  const r = camera.position.distanceTo(controls.target);
  const cos = THREE.MathUtils.clamp((MIN_CAMERA_Y - controls.target.y) / r, -1, 1);
  controls.maxPolarAngle = Math.min(Math.acos(cos), Math.PI * 0.75);
}
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
  scene, renderer, pipeline, skyLight: sky, sun, skyDome, ground,
});

// --- model & tools ---
const NEW_WALL_DEFAULTS = { height: 2.7, thickness: 0.15, color: '#ffffff' };
const settings = { ...NEW_WALL_DEFAULTS, snap: 0.25 };
const walls = new Walls(scene);
const person = createPerson({ scene, camera: persp, controls, canvas, walls });
const tools = createTools({ getCamera: () => camera, canvas, controls, scene, walls, settings, person });
person.leftDragLooks = () => tools.tool === 'select';

// --- UI ---
const $ = (id) => document.getElementById(id);
const hints = {
  select: 'Click a wall to select · drag blue handles to move corners · Del to delete · Drag to orbit, right-drag to pan, wheel to zoom',
  wall: 'Click to place points · Shift locks 45° · click the start point, double-click, Enter or right-click to finish · Esc cancels · right-drag pans, middle-drag orbits',
  room: 'Click two opposite corners (or drag) to draw a rectangular room · Esc cancels · right-drag pans, middle-drag orbits',
  person: 'Click to place the person · drag while placing to set which way they face · E for eye view',
};
const eyeHint = 'Eye view · drag to look around · WASD / arrows to walk (Shift = faster) · wheel = FOV · E or Esc to exit';

const toolButtons = document.querySelectorAll('[data-tool]');
toolButtons.forEach((b) => b.addEventListener('click', () => tools.setTool(b.dataset.tool)));
function refreshHint() {
  $('hint').textContent = person.eye ? eyeHint : hints[tools.tool];
}
tools.onToolChange((t) => {
  toolButtons.forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  refreshHint();
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
$('person-remove').addEventListener('click', () => person.remove());
person.onChange(() => {
  $('eye').classList.toggle('active', person.eye);
  $('person-remove').disabled = !person.placed;
  if (document.activeElement !== $('person-height')) $('person-height').value = String(person.height);
  showSpeed();
  refreshHint();
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
const io = createProjectIO({ getScene, setScene, notify });
$('file-open').addEventListener('click', () => { tools.cancel(); io.open(); });
$('file-save').addEventListener('click', () => io.save());

$('undo').addEventListener('click', () => tools.undo());
$('redo').addEventListener('click', () => tools.redo());
$('clear').addEventListener('click', () => { tools.cancel(); walls.clear(); });

const num = (input, fallback) => {
  const v = parseFloat(input.value);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
$('set-height').addEventListener('change', (e) => (settings.height = num(e.target, settings.height)));
$('set-thickness').addEventListener('change', (e) => (settings.thickness = num(e.target, settings.thickness)));

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

$('sel-height').addEventListener('change', (e) => {
  const w = walls.selected;
  if (w) walls.update(w.id, { height: num(e.target, w.height) });
});
$('sel-thickness').addEventListener('change', (e) => {
  const w = walls.selected;
  if (w) walls.update(w.id, { thickness: num(e.target, w.thickness) });
});
$('sel-delete').addEventListener('click', () => walls.selected && walls.remove(walls.selectedId));

$('set-color').addEventListener('input', (e) => (settings.color = e.target.value));

// Wall colour: preview live while the picker is open, commit one undo step on close.
let colorBefore = null;
$('sel-color').addEventListener('input', (e) => {
  const w = walls.selected;
  if (!w) return;
  colorBefore ??= w.color ?? DEFAULT_WALL_COLOR;
  w.color = e.target.value;
  walls.sync(false);
});
$('sel-color').addEventListener('change', (e) => {
  const w = walls.selected;
  if (!w || colorBefore == null) return;
  w.color = colorBefore; // restore so the undo snapshot holds the old colour
  colorBefore = null;
  walls.update(w.id, { color: e.target.value });
});

function refreshUI() {
  const w = walls.selected;
  $('sel-panel').hidden = !w;
  if (w) {
    $('sel-length').textContent = `${wallLength(w).toFixed(2)} m`;
    if (document.activeElement !== $('sel-height')) $('sel-height').value = w.height;
    if (document.activeElement !== $('sel-thickness')) $('sel-thickness').value = w.thickness;
    if (colorBefore == null) $('sel-color').value = w.color ?? DEFAULT_WALL_COLOR;
  }
  $('undo').disabled = !walls.undoStack.length;
  $('redo').disabled = !walls.redoStack.length;
}
walls.onChange(refreshUI);

// --- camera views ---
let topView = false;
let fly = null;
function flyTo(position, target) {
  fly = { p0: camera.position.clone(), p1: position, t0: controls.target.clone(), t1: target, t: 0 };
}
function toggleTopView() {
  person.exitEye();
  topView = !topView;
  const target = controls.target.clone();
  const d = Math.max(camera.position.distanceTo(target), 8);
  const offset = topView ? new THREE.Vector3(0, d, 0.001) : new THREE.Vector3(1, 1.1, 1.4).normalize().multiplyScalar(d);
  flyTo(target.clone().add(offset), target);
  $('view').textContent = topView ? '3D view' : 'Top view';
}
$('view').addEventListener('click', toggleTopView);

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
 * The scene as file data. Walls and the camera are always included; every
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
    walls: walls.list.map(({ a, b, thickness, height, color }) => ({ a, b, thickness, height, color })),
    // A person that isn't placed has nothing worth saving except changed height / speed.
    person: changedFrom(person.defaults, p.placed ? p : { ...person.defaults, height: p.height, speed: p.speed }),
    environment: environment.getChanged(),
    grid: changedFrom(GRID_DEFAULTS, grid),
    newWalls: changedFrom(NEW_WALL_DEFAULTS, settings),
    view: {
      fov: persp.fov !== DEFAULT_FOV ? persp.fov : undefined,
      parallel: parallel || undefined,
      camera: { position: orbit.position.toArray(), target: orbit.target.toArray() },
    },
  };
}

/** Replace the entire scene with `data`; anything missing gets its default. */
function setScene(data) {
  tools.cancel();
  tools.setTool('select');
  person.setState(data.person); // also leaves eye view
  const count = walls.replaceAll(data.walls);
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

  Object.assign(settings, pickValid(NEW_WALL_DEFAULTS, data.newWalls));
  $('set-height').value = String(settings.height);
  $('set-thickness').value = String(settings.thickness);
  $('set-color').value = settings.color;

  const fov = data.view?.fov;
  setFov(Number.isFinite(fov) ? THREE.MathUtils.clamp(fov, 20, 100) : DEFAULT_FOV);
  const vec3 = (v, fallback) => (Array.isArray(v) && v.length === 3 && v.every(Number.isFinite) ? v : fallback);
  setParallel(false);
  persp.position.fromArray(vec3(data.view?.camera?.position, DEFAULT_CAMERA.position));
  controls.target.fromArray(vec3(data.view?.camera?.target, DEFAULT_CAMERA.target));
  controls.update();
  setParallel(data.view?.parallel === true);
  topView = false;
  $('view').textContent = 'Top view';
  return count;
}

// --- keyboard ---
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  const k = e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? tools.redo() : tools.undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); tools.redo(); return; }
  if (mod && k === 's') { e.preventDefault(); io.save(); return; }
  if (mod && k === 'o') { e.preventDefault(); tools.cancel(); io.open(); return; }
  if (mod) return;
  if (person.isMoveKey(k)) return; // WASD / arrows walk in eye view
  if (k === 'v') tools.setTool('select');
  else if (k === 'w') tools.setTool('wall');
  else if (k === 'r') tools.setTool('room');
  else if (k === 'p') tools.setTool('person');
  else if (k === 'e') { if (!person.eye) setParallel(false); person.toggleEye(); }
  else if (k === 't') toggleTopView();
  else if (k === 'o') setParallel(camera !== ortho);
  else if (k === 'enter') tools.finish();
  else if (k === 'escape') {
    if (tools.cancel()) return;
    if (person.eye) person.exitEye();
    else walls.select(null);
  }
  else if ((k === 'delete' || k === 'backspace') && walls.selected) walls.remove(walls.selectedId);
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
      fly.t = Math.min(1, fly.t + dt / 0.6);
      const k = 1 - Math.pow(1 - fly.t, 3);
      camera.position.lerpVectors(fly.p0, fly.p1, k);
      controls.target.lerpVectors(fly.t0, fly.t1, k);
      if (fly.t === 1) fly = null;
    }
    updateTiltLimit();
    controls.update();
  }
  person.update(dt);
  skyDome.update(camera);
  placeSun();
  skyDome.updateEnvironment(renderer, scene);
  ground.update(camera);
  updateMeasureLabel();
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
        walls: walls.list.length,
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
    out.textContent = `Diagnostics failed: ${e?.message ?? e}`;
    $('diag-actions').hidden = false;
  } finally {
    diagRunning = false;
  }
}
fpsEl.addEventListener('click', startDiagnostics);
$('diag-close').addEventListener('click', () => { $('diag').hidden = true; });
$('diag-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(JSON.stringify(lastReport, null, 2)); notify('Report copied'); }
  catch { notify('Copy failed; use Download instead', true); }
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

tools.setTool('select');
refreshUI();
