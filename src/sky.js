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

  return {
    object: dome,
    setColors(top, horizon) {
      uniforms.uTop.value.set(top);
      uniforms.uHorizon.value.set(horizon);
    },
    setSunDirection(dir) { uniforms.uSunDir.value.copy(dir).normalize(); },
    update(camera) { dome.position.copy(camera.position); },
  };
}
