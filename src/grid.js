import * as THREE from 'three';

// Patchy, non-repeating light/dark variation on top of the floor's base
// colour, from world-space noise. Fine detail fades with distance
// to avoid shimmering.
function addGroundVariation(material) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGroundPos;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvGroundPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */ `#include <common>
        varying vec3 vGroundPos;
        float gHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float gNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(gHash(i), gHash(i + vec2(1, 0)), u.x),
                     mix(gHash(i + vec2(0, 1)), gHash(i + vec2(1, 1)), u.x), u.y);
        }
        float gFbm(vec2 p) {
          float v = 0.0, a = 0.5;
          for (int i = 0; i < 4; i++) { v += a * gNoise(p); p *= 2.03; a *= 0.5; }
          return v;
        }`)
      .replace('#include <color_fragment>', /* glsl */ `#include <color_fragment>
        {
          vec2 gp = vGroundPos.xz;
          float far = clamp(length(vGroundPos - cameraPosition) / 35.0, 0.0, 1.0);
          float large = gFbm(gp * 0.07);
          float fine = mix(gFbm(gp * 1.1), 0.5, far);
          // Subtle, colour-neutral mottling like weathered concrete / paving.
          diffuseColor.rgb *= mix(0.9, 1.05, large * 0.6 + fine * 0.4);
        }`);
  };
}

// A large ground plane plus a shader-drawn grid that stays crisp at any zoom
// and fades out with distance, so it reads as "infinite".
export function createGround() {
  const group = new THREE.Group();

  // No depth write: nothing sits below the floor, and it keeps the huge plane
  // from z-fighting with the grid at shallow viewing angles.
  const floorMat = new THREE.MeshStandardMaterial({ color: 0xb3afa7, roughness: 1, depthWrite: false });
  addGroundVariation(floorMat);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2), floorMat);
  floor.renderOrder = -1;
  floor.receiveShadow = true;
  group.add(floor);

  // The ground seen from below: a light, see-through layer (so it's clearly there,
  // but the model above stays visible through it).
  const underMat = new THREE.MeshBasicMaterial({
    color: 0xb3afa7, side: THREE.BackSide, transparent: true, opacity: 0.35, depthWrite: false,
  });
  const under = new THREE.Mesh(floor.geometry, underMat);
  group.add(under);

  const gridMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide, // grid and axes also visible from below the ground
    // The grid is one huge plane; its depth is imprecise, so push it back a little:
    // anything lying on the ground (flat faces, shape bottoms) must win over it.
    polygonOffset: true,
    polygonOffsetFactor: 4,
    polygonOffsetUnits: 4,
    uniforms: {
      uFadeDist: { value: 60 },
      uMinor: { value: 0.25 },
      uMajor: { value: 1 },
      uOpacity: { value: 1 },
      uColor: { value: new THREE.Color(0x54595f) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uFadeDist;
      uniform float uMinor;
      uniform float uMajor;
      uniform float uOpacity;
      uniform vec3 uColor;
      varying vec3 vWorld;

      float gridLine(vec2 p, float size, float width) {
        vec2 c = p / size;
        vec2 g = abs(fract(c - 0.5) - 0.5) / fwidth(c);
        return 1.0 - min(min(g.x, g.y) / width, 1.0);
      }

      void main() {
        vec2 p = vWorld.xz;
        float dist = length(cameraPosition - vWorld);
        float fade = 1.0 - smoothstep(uFadeDist * 0.2, uFadeDist, dist);
        // Minor lines fade out sooner (scaled to their spacing) so they don't turn to mush.
        float minorFade = 1.0 - smoothstep(uMinor * 24.0, uMinor * 90.0, dist);

        float a = max(gridLine(p, uMinor, 1.0) * 0.18 * minorFade, gridLine(p, uMajor, 1.2) * 0.42);
        vec3 col = uColor;

        vec2 fw = fwidth(p);
        float xAxis = 1.0 - min(abs(p.y) / fw.y / 1.5, 1.0);
        float zAxis = 1.0 - min(abs(p.x) / fw.x / 1.5, 1.0);
        col = mix(col, vec3(0.85, 0.32, 0.32), xAxis);
        col = mix(col, vec3(0.3, 0.45, 0.9), zAxis);
        a = max(a, max(xAxis, zAxis) * 0.75);

        a *= fade * uOpacity;
        if (a < 0.01) discard;
        gl_FragColor = vec4(col, a);
        #include <colorspace_fragment>
      }
    `,
  });

  const grid = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2), gridMat);
  grid.position.y = 0.001;
  grid.renderOrder = 1;
  group.add(grid);

  let fadeDistance = 40;

  return {
    object: group,
    floorMaterial: floor.material,
    underMaterial: underMat,
    gridColor: gridMat.uniforms.uColor.value,
    /** Show / hide the ground plane (the grid has its own toggle). */
    setFloorVisible(v) { floor.visible = under.visible = v; },
    /** Distance (m) at which the grid has fully faded, when the camera is low. */
    setFadeDistance(d) { fadeDistance = d; },
    // Fade further away when the camera is higher up.
    update(camera) {
      gridMat.uniforms.uFadeDist.value = Math.max(fadeDistance, camera.position.y * 8);
    },
    /** @param {{ visible: boolean, cell: number, majorEvery: number, opacity: number }} o */
    setOptions(o) {
      grid.visible = o.visible;
      gridMat.uniforms.uMinor.value = o.cell;
      gridMat.uniforms.uMajor.value = o.cell * o.majorEvery;
      gridMat.uniforms.uOpacity.value = o.opacity;
    },
  };
}
