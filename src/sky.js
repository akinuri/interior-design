import * as THREE from 'three';

// Gradient sky dome (zenith -> horizon) with a soft sun glow. Follows the camera
// so it always surrounds the view.
export function createSky() {
  const uniforms = {
    uTop: { value: new THREE.Color() },
    uHorizon: { value: new THREE.Color() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
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
      varying vec3 vDir;
      void main() {
        vec3 dir = normalize(vDir);
        float h = max(dir.y, 0.0);
        vec3 col = mix(uHorizon, uTop, pow(h, 0.55));
        float s = max(dot(dir, uSunDir), 0.0);
        col += vec3(1.0, 0.92, 0.78) * (pow(s, 600.0) * 1.2 + pow(s, 12.0) * 0.12);
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
