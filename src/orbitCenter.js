import * as THREE from 'three';

/**
 * A marker at the point the view orbits around (OrbitControls' target), which moves
 * when panning. Drawn on top of everything at a fixed size on screen. When the point
 * floats above / below the ground, a dashed line drops to a small ring on the ground,
 * so where it is in space is easy to read.
 */
export function createOrbitCenter(scene) {
  const SIZE_PX = 22;
  const BLUE = '#1f5fe0';

  // Marker: blue ring + dot with a white halo (shows on dark and light backgrounds).
  const res = 64;
  const c = document.createElement('canvas');
  c.width = c.height = res;
  const g = c.getContext('2d');
  const circle = (r, fill, width) => {
    g.beginPath();
    g.arc(res / 2, res / 2, r, 0, Math.PI * 2);
    if (width) { g.lineWidth = width; g.strokeStyle = fill; g.stroke(); } else { g.fillStyle = fill; g.fill(); }
  };
  circle(23, '#ffffff', 11);
  circle(23, BLUE, 5.5);
  circle(8.5, '#ffffff');
  circle(5.5, BLUE);
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  const marker = new THREE.Sprite(new THREE.SpriteMaterial({ map, depthTest: false, depthWrite: false, transparent: true, opacity: 0.45, fog: false }));

  // Drop line and ground ring.
  const dropMat = new THREE.LineDashedMaterial({ color: BLUE, dashSize: 1, gapSize: 1, depthTest: false, transparent: true, opacity: 0.35, fog: false });
  const drop = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), dropMat);
  const foot = new THREE.Mesh(
    new THREE.RingGeometry(0.32, 0.5, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: BLUE, depthTest: false, transparent: true, opacity: 0.25, side: THREE.DoubleSide, fog: false }),
  );

  const group = new THREE.Group();
  group.add(drop, foot, marker);
  group.traverse((o) => { o.renderOrder = 20; o.userData.noAO = true; o.raycast = () => {}; });
  group.visible = false;
  scene.add(group);

  let enabled = true;
  let hidden = false;

  return {
    get enabled() { return enabled; },
    set enabled(v) { enabled = v; },
    /** Place it at `target`, sized for the camera; `show` = false hides it (e.g. in eye view). */
    update(camera, target, viewportHeight, show) {
      group.visible = enabled && show && !hidden;
      if (!group.visible) return;
      const worldPerPx = (p) => (camera.isPerspectiveCamera
        ? (2 * camera.position.distanceTo(p) * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / viewportHeight
        : (camera.top - camera.bottom) / camera.zoom / viewportHeight);
      const px = worldPerPx(target);
      marker.position.copy(target);
      marker.scale.setScalar(SIZE_PX * px);

      const ground = new THREE.Vector3(target.x, 0, target.z);
      const floating = Math.abs(target.y) > 0.02;
      drop.visible = foot.visible = floating;
      if (!floating) return;
      drop.geometry.setFromPoints([target, ground]);
      drop.computeLineDistances();
      dropMat.dashSize = dropMat.gapSize = 5 * px;
      foot.position.copy(ground);
      foot.scale.setScalar(SIZE_PX * worldPerPx(ground)); // ring: about the size of the marker
    },
    /** Hide for a moment (screenshots); returns a restore function. */
    hide() {
      const was = group.visible;
      hidden = true;
      group.visible = false;
      return () => { hidden = false; group.visible = was; };
    },
  };
}
