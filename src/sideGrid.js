import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

/**
 * A vertical grid behind the model for the side views (front / back / left / right) in
 * parallel projection, like graph paper for reading heights and widths. Lines follow the
 * world grid (same cell size and major spacing); fine lines fade out when they get too
 * dense on screen.
 */
export function createSideGrid(scene, gridColor) {
  const SIZE = 400; // m across; recentred on the view as it pans
  const minorMat = new THREE.LineBasicMaterial({ color: gridColor, transparent: true, opacity: 0.35, depthWrite: false, fog: false });
  const majorMat = new THREE.LineBasicMaterial({ color: gridColor, transparent: true, opacity: 0.7, depthWrite: false, fog: false });
  const group = new THREE.Group();
  group.visible = false;
  group.renderOrder = -1;
  scene.add(group);
  let minor = null, major = null, built = '';

  // Axes through the world origin, coloured like the ground grid's: X red, Z blue, and Y (up)
  // green. Thick screen-space lines (plain WebGL lines are 1 px and get lost in the grid).
  const axisLine = (color) => {
    // Transparent + a later render order: drawn after the grid lines, so they don't cover it.
    const l = new Line2(new LineGeometry().setPositions([0, 0, 0, 1, 0, 0]), new LineMaterial({ color, linewidth: 2.5, transparent: true, depthWrite: false }));
    l.renderOrder = 3;
    l.raycast = () => {};
    l.userData.noAO = true;
    l.visible = false;
    scene.add(l);
    return l;
  };
  const xAxis = axisLine('#e0453f');
  const zAxis = axisLine('#3a6fe8');
  const yAxis = axisLine('#36a84a');
  const setLine = (l, a, b) => { l.geometry.dispose(); l.geometry = new LineGeometry().setPositions([a.x, a.y, a.z, b.x, b.y, b.z]); };

  /** Line grid in the XY plane (normal +Z), lines every `step` m. */
  function lines(step, mat) {
    const n = Math.round(SIZE / step / 2);
    const pts = [];
    for (let i = -n; i <= n; i++) {
      const v = i * step;
      pts.push(-n * step, v, 0, n * step, v, 0, v, -n * step, 0, v, n * step, 0);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const l = new THREE.LineSegments(g, mat);
    l.raycast = () => {};
    return l;
  }

  function build(cell, majorEvery) {
    const key = `${cell}|${majorEvery}`;
    if (key === built) return;
    built = key;
    for (const l of [minor, major]) if (l) { l.geometry.dispose(); group.remove(l); }
    minor = lines(cell, minorMat);
    major = lines(cell * majorEvery, majorMat);
    group.add(minor, major);
  }

  return {
    /**
     * Show it for `camera` looking along `dir` (unit, from the target towards the camera)
     * at `target`, or hide it (`show` false). `behind`: how far behind the target to put
     * it (past the model). `pxPerMeter`: screen scale, for fading the fine lines.
     */
    update({ show, dir, target, behind, cell, majorEvery, opacity, pxPerMeter }) {
      group.visible = show;
      xAxis.visible = zAxis.visible = yAxis.visible = false;
      if (!show) return;
      build(cell, majorEvery);
      minorMat.color.copy(gridColor); // follows the Grid lines colour setting
      majorMat.color.copy(gridColor);
      // Face the camera: the grid's +Z along `dir`, its Y up.
      group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(
        new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), dir).normalize(),
        new THREE.Vector3(0, 1, 0),
        dir,
      ));
      // Behind the model, and snapped so the lines stay on the world grid while panning.
      const step = cell * majorEvery;
      const p = target.clone().addScaledVector(dir, -behind);
      const snap = (v) => Math.round(v / step) * step;
      p.y = snap(p.y);
      if (Math.abs(dir.x) > 0.5) p.z = snap(p.z); else p.x = snap(p.x);
      group.position.copy(p);
      // Fade lines that would be closer than a few pixels apart.
      const fade = (px) => THREE.MathUtils.clamp((px - 4) / 8, 0, 1);
      minorMat.opacity = 0.35 * opacity * fade(cell * pxPerMeter);
      majorMat.opacity = 0.7 * opacity * fade(step * pxPerMeter);
      // Axes on the grid's plane: the horizontal one seen from this side (along the ground)
      // and the vertical one, through the origin.
      const along = Math.abs(dir.x) > 0.5 ? 'z' : 'x'; // the horizontal world axis on screen
      const depth = along === 'z' ? p.x : p.z;
      const at = (x, y, z) => (along === 'z' ? new THREE.Vector3(depth, y, z) : new THREE.Vector3(x, y, depth));
      const h = along === 'z' ? zAxis : xAxis;
      const half = SIZE / 2;
      const c = along === 'z' ? target.z : target.x;
      setLine(h, at(c - half, 0, c - half), at(c + half, 0, c + half));
      setLine(yAxis, at(0, target.y - half, 0), at(0, target.y + half, 0));
      h.visible = yAxis.visible = true;
      minor.visible = minorMat.opacity > 0.01;
      major.visible = majorMat.opacity > 0.01;
    },
  };
}
