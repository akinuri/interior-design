import * as THREE from 'three';

/**
 * Linear colour that comes out as `target` (linear) after Neutral tone mapping
 * at `exposure`, so a chosen background shows exactly as picked. Neutral keeps
 * mid-tones but darkens very dark colours (its "toe"): for min channel x < 0.08
 * it outputs c − x + 6.25·x²; otherwise c − 0.04 (below its highlight range).
 */
function inverseNeutral(target, exposure) {
  const m = Math.min(target.r, target.g, target.b);
  const x = m < 0.04 ? Math.sqrt(m / 6.25) : null; // toe: solve 6.25·x² = m
  const lift = x === null ? 0.04 : x - m;
  return new THREE.Color(target.r + lift, target.g + lift, target.b + lift).multiplyScalar(1 / exposure);
}

// Gradient sky dome (zenith -> horizon) with a soft sun glow. Follows the camera
// so it always surrounds the view.
export function createSky() {
  const uniforms = {
    uTop: { value: new THREE.Color() },
    uHorizon: { value: new THREE.Color() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uGlow: { value: 1 }, // sun glow strength (0 for a plain background)
  };

  const mat = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position; // sphere is centred on the camera
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uTop;
      uniform vec3 uHorizon;
      uniform vec3 uSunDir;
      uniform float uGlow;
      varying vec3 vDir;
      void main() {
        vec3 dir = normalize(vDir);
        float h = max(dir.y, 0.0);
        vec3 col = mix(uHorizon, uTop, pow(h, 0.55));
        float s = max(dot(dir, uSunDir), 0.0);
        col += vec3(1.0, 0.92, 0.78) * (pow(s, 600.0) * 1.2 + pow(s, 12.0) * 0.12) * uGlow;
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }
    `,
  });

  const dome = new THREE.Mesh(new THREE.SphereGeometry(2500, 32, 16), mat);
  dome.frustumCulled = false;
  dome.renderOrder = -2; // drawn first; floor and everything else go on top

  // Environment lighting: a small copy of the sky with the ground beneath it,
  // baked into an environment map. Surfaces then get soft, directional light
  // from the whole sky plus bounce light from the ground.
  // Its sky is a softened copy (top colour pulled toward the horizon) so shade
  // is gently cool rather than strongly blue.
  const envMat = mat.clone();
  const envUniforms = envMat.uniforms;
  envUniforms.uSunDir = uniforms.uSunDir; // shared
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), envMat));
  const envGround = new THREE.Mesh(
    new THREE.CircleGeometry(100, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial()
  );
  envGround.position.y = -1;
  envScene.add(envGround);
  let pmrem = null;
  let envTarget = null;
  let envDirty = true;

  return {
    object: dome,
    setColors(top, horizon, ground) {
      uniforms.uTop.value.set(top);
      uniforms.uHorizon.value.set(horizon);
      envUniforms.uHorizon.value.set(horizon);
      envUniforms.uTop.value.set(top).lerp(envUniforms.uHorizon.value, 0.6);
      if (ground) envGround.material.color.set(ground);
      envDirty = true;
    },
    /**
     * Plain background: one colour, no sun glow. Compensated for tone mapping so it
     * appears exactly as `color`; the lighting it gives uses the plain colour.
     */
    setPlain(color, exposure = 1) {
      this.setColors(color, color, null);
      const shown = inverseNeutral(new THREE.Color(color), exposure);
      uniforms.uTop.value.copy(shown);
      uniforms.uHorizon.value.copy(shown);
      uniforms.uGlow.value = 0;
      envUniforms.uGlow.value = 0;
    },
    setGlow(on) {
      uniforms.uGlow.value = on ? 1 : 0;
      envUniforms.uGlow.value = on ? 1 : 0;
      envDirty = true;
    },
    setSunDirection(dir) {
      uniforms.uSunDir.value.copy(dir).normalize();
      envDirty = true;
    },
    update(camera) { dome.position.copy(camera.position); },
    /** Re-bake the environment map if the sky changed (at most once per frame). */
    updateEnvironment(renderer, scene) {
      if (!envDirty) return;
      envDirty = false;
      pmrem ??= new THREE.PMREMGenerator(renderer);
      envTarget?.dispose();
      envTarget = pmrem.fromScene(envScene, 0, 0.1, 500);
      scene.environment = envTarget.texture;
    },
  };
}
