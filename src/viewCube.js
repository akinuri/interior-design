import * as THREE from 'three';

/*
 * The view cube: a small labelled cube in a corner that turns with the camera. Clicking a face
 * looks from that side; an edge or a corner, from between those sides. Dragging it orbits.
 * (It replaces a row of view buttons.) Drawn by its own small renderer, only when it changes.
 */

const FACES = ['right', 'left', 'top', 'bottom', 'front', 'back']; // BoxGeometry's order: +x −x +y −y +z −z
const EDGE = 0.2; // how far in from the cube's edges an edge / corner is picked
const BLUE = 0x2a6df4;

/** A face's picture: its name on a light tile. */
function faceTexture(text) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#f4f2ee';
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#4a4d53';
  g.font = '700 30px system-ui, -apple-system, "Segoe UI", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  // Long words get a smaller size so they fit.
  const w = g.measureText(text).width;
  if (w > 116) g.font = `700 ${Math.floor((30 * 116) / w)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  g.fillText(text, 64, 66);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * `container`: the element to draw in. `labels()`: { top, bottom, left, right, front, back }
 * (the faces' names). `onPick(dir)`: a face / edge / corner was clicked (dir: a Vector3 with
 * components −1 / 0 / 1, pointing from the centre to it). `onOrbit(dx, dy)`: dragged (px).
 */
export function createViewCube({ container, labels, onPick, onOrbit }) {
  const canvas = document.createElement('canvas');
  container.append(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const scene = new THREE.Scene();
  // A slight perspective (a narrow lens from further away): flat projection looked odd on a cube.
  const FOV = 22, DIST = 4.6;
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 20);
  scene.add(camera);
  // Soft light from the viewer's upper left, so the sides read as a solid.
  scene.add(new THREE.AmbientLight(0xffffff, 2.2));
  const light = new THREE.DirectionalLight(0xffffff, 1.2);
  light.position.set(-1, 1.5, 2);
  camera.add(light);

  const materials = FACES.map(() => new THREE.MeshLambertMaterial({ color: 0xffffff }));
  const cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), materials);
  scene.add(cube);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(cube.geometry),
    new THREE.LineBasicMaterial({ color: 0x6b6e75, transparent: true, opacity: 0.7 }));
  scene.add(edges);
  // The face / edge / corner under the mouse, lit blue.
  const hover = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({
    color: BLUE, transparent: true, opacity: 0.35, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }));
  hover.visible = false;
  scene.add(hover);

  let dirty = true;
  let active = null; // the face of the standard view we're in
  function setLabels() {
    const names = labels();
    FACES.forEach((f, i) => { materials[i].map?.dispose(); materials[i].map = faceTexture(names[f].toUpperCase()); materials[i].needsUpdate = true; });
    dirty = true;
  }
  setLabels();

  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    renderer.setSize(w, h, false);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    dirty = true;
  }
  resize();
  new ResizeObserver(resize).observe(container);

  // --- picking ---
  const ray = new THREE.Raycaster();
  /** The face / edge / corner at the mouse: a direction with components −1 / 0 / 1, or null. */
  function pick(e) {
    const r = canvas.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    const hit = ray.intersectObject(cube)[0];
    if (!hit) return null;
    const p = hit.point;
    return new THREE.Vector3(...['x', 'y', 'z'].map((k) => (Math.abs(p[k]) > 0.5 - EDGE ? Math.sign(p[k]) : 0)));
  }
  let hovered = null;
  function setHover(d) {
    if ((d && hovered && d.equals(hovered)) || (!d && !hovered)) return;
    hovered = d;
    hover.visible = !!d;
    if (d) {
      // A thin slab along the cube's surface over that part (a face's middle, an edge, a corner).
      for (const k of ['x', 'y', 'z']) {
        hover.scale[k] = d[k] ? EDGE : 1 - 2 * EDGE;
        hover.position[k] = d[k] * (0.5 - EDGE / 2);
      }
    }
    dirty = true;
  }

  let press = null; // { x, y, dragging }
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    press = { x: e.clientX, y: e.clientY, dragging: false };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (press) {
      const dx = e.clientX - press.x, dy = e.clientY - press.y;
      if (!press.dragging && Math.hypot(dx, dy) > 3) { press.dragging = true; setHover(null); }
      if (press.dragging) { onOrbit(dx, dy); press.x = e.clientX; press.y = e.clientY; }
      return;
    }
    setHover(pick(e));
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!press) return;
    const wasDrag = press.dragging;
    press = null;
    if (wasDrag) return;
    const d = pick(e);
    if (d) onPick(d);
  });
  canvas.addEventListener('pointerleave', () => { if (!press) setHover(null); });
  canvas.addEventListener('contextmenu', () => setHover(null)); // (its menu opens: nothing to pick)

  const lastQ = new THREE.Quaternion();
  return {
    /** Turn with the main camera (draws only when something changed). */
    update(mainCamera) {
      if (!dirty && lastQ.equals(mainCamera.quaternion)) return;
      lastQ.copy(mainCamera.quaternion);
      camera.quaternion.copy(mainCamera.quaternion);
      // (DIST fits the cube whatever way it's turned: its corners reach √3 / 2 from the centre.)
      camera.position.set(0, 0, DIST).applyQuaternion(mainCamera.quaternion);
      renderer.render(scene, camera);
      dirty = false;
    },
    /** Mark the face of the standard view we're in (null: none). */
    setActive(name) {
      if (name === active) return;
      active = name;
      FACES.forEach((f, i) => materials[i].emissive.set(f === name ? 0x1d4fb8 : 0x000000).multiplyScalar(f === name ? 0.25 : 1));
      dirty = true;
    },
    setLabels,
  };
}
