import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/**
 * Scene render -> ambient occlusion (GTAO) -> output (tone mapping + colour space).
 * AO darkens creases where surfaces meet (wall corners, wall/floor edges).
 * It needs a perspective camera, so it's skipped in parallel view.
 */
export function createRenderPipeline({ renderer, scene, camera }) {
  // Multisampled target keeps edges antialiased now that we render off-screen.
  const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);

  const renderPass = new RenderPass(scene, camera);
  const ao = new GTAOPass(scene, camera, 1, 1);
  ao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1, thickness: 1, scale: 1, samples: 16, distanceFallOff: 1 });
  ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, rings: 2, samples: 16 });

  composer.addPass(renderPass);
  composer.addPass(ao);
  composer.addPass(new OutputPass());

  let aoStrength = 1;

  return {
    setSize(w, h) {
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(w, h);
    },
    /** 0 = off, 1 = full. */
    setAmbientOcclusion(strength) {
      aoStrength = strength;
      ao.blendIntensity = strength;
    },
    getAmbientOcclusion: () => aoStrength,
    /** How far (m) the darkening reaches out from creases. */
    setAmbientOcclusionRadius(m) {
      ao.updateGtaoMaterial({ radius: m });
    },
    render(activeCamera) {
      renderPass.camera = activeCamera;
      ao.enabled = aoStrength > 0 && activeCamera.isPerspectiveCamera;
      composer.render();
    },
  };
}
