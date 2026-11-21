import * as THREE from 'three';
import { formatLength } from './units.js';

/*
 * Measurements (Measure tool): lines between two points with a length label, kept in the
 * scene (and saved with the design). Drawn on top of everything so they stay readable;
 * labels keep the same size on screen. They render into the canvas, so they show in
 * screenshots too.
 */

const DARK = '#2b2d31';
const BLUE = '#2a6df4';
const LABEL_FONT_PX = 11; // on screen

/**
 * A label texture: text in `color` on a light, slightly see-through pill (quiet, so labels
 * don't shout over the model). Returns { texture, w, h } (w / h in CSS px).
 */
function labelTexture(text, color) {
  const scale = 2; // sharp on high-DPI screens
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  const font = `500 ${LABEL_FONT_PX * scale}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  g.font = font;
  const padX = 5 * scale, padY = 2 * scale;
  const w = Math.ceil(g.measureText(text).width + padX * 2);
  const h = Math.ceil(LABEL_FONT_PX * scale * 1.25 + padY * 2);
  c.width = w;
  c.height = h;
  g.font = font;
  g.fillStyle = 'rgba(255, 255, 255, 0.78)';
  g.strokeStyle = color === BLUE ? BLUE : 'rgba(43, 45, 49, 0.18)';
  g.lineWidth = scale;
  g.beginPath();
  g.roundRect(scale / 2, scale / 2, w - scale, h - scale, (h - scale) / 2);
  g.fill();
  g.stroke();
  g.fillStyle = color;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, w / 2, h / 2 + scale);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, w: w / scale, h: h / scale };
}

export function createMeasureView(scene) {
  const group = new THREE.Group();
  scene.add(group);
  let items = []; // { id, a, b, label, w, h }

  const lineMat = (color) => new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: color === BLUE ? 1 : 0.6, fog: false });
  const dotMat = (color) => new THREE.PointsMaterial({ color, size: 5, sizeAttenuation: false, depthTest: false, transparent: true, opacity: color === BLUE ? 1 : 0.7, fog: false });
  const mats = { [DARK]: { line: lineMat(DARK), dot: dotMat(DARK) }, [BLUE]: { line: lineMat(BLUE), dot: dotMat(BLUE) } };

  function clear() {
    for (const obj of [...group.children]) {
      obj.geometry?.dispose();
      if (obj.isSprite) { obj.material.map.dispose(); obj.material.dispose(); }
      group.remove(obj);
    }
    items = [];
  }

  return {
    /** Show `list` ([{ id, a, b }], points in metres); ids in `selected` show in blue. */
    set(list, selected) {
      clear();
      for (const m of list) {
        const color = selected.has(m.id) ? BLUE : DARK;
        const geo = new THREE.BufferGeometry().setFromPoints([m.a, m.b]);
        const line = new THREE.Line(geo, mats[color].line);
        const dots = new THREE.Points(geo.clone(), mats[color].dot);
        const { texture, w, h } = labelTexture(formatLength(m.a.distanceTo(m.b)), color);
        const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, depthWrite: false, transparent: true, fog: false }));
        label.position.copy(m.a).add(m.b).multiplyScalar(0.5);
        for (const o of [line, dots, label]) { o.renderOrder = 15; o.userData.noAO = true; o.raycast = () => {}; group.add(o); }
        items.push({ id: m.id, a: m.a, b: m.b, label, w, h });
      }
    },

    /** Keep labels the same size on screen (call every frame). */
    update(camera, viewportHeight) {
      for (const it of items) {
        const p = it.label.position;
        const perPx = camera.isPerspectiveCamera
          ? (2 * camera.position.distanceTo(p) * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / viewportHeight
          : (camera.top - camera.bottom) / camera.zoom / viewportHeight;
        it.label.scale.set(it.w * perPx, it.h * perPx, 1);
      }
    },

    /** The measurement under the mouse (its line within `px`, or its label), or null. */
    pick(ndc, camera, size, px = 8) {
      const toScreen = (p) => { const v = p.clone().project(camera); return { x: (v.x + 1) / 2 * size.x, y: (1 - v.y) / 2 * size.y, z: v.z }; };
      const mouse = { x: (ndc.x + 1) / 2 * size.x, y: (1 - ndc.y) / 2 * size.y };
      let best = null, bestD = px;
      for (const it of items) {
        const a = toScreen(it.a), b = toScreen(it.b), c = toScreen(it.label.position);
        if (a.z > 1 || b.z > 1) continue;
        // On the label?
        if (Math.abs(mouse.x - c.x) <= it.w / 2 && Math.abs(mouse.y - c.y) <= it.h / 2) return it.id;
        const dx = b.x - a.x, dy = b.y - a.y;
        const t = THREE.MathUtils.clamp(((mouse.x - a.x) * dx + (mouse.y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1);
        const d = Math.hypot(mouse.x - (a.x + t * dx), mouse.y - (a.y + t * dy));
        if (d < bestD) { bestD = d; best = it.id; }
      }
      return best;
    },
  };
}
