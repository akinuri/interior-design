import * as THREE from 'three';
import { t } from './i18n.js';
import { setEdgeLines } from './model.js';

// v3: earlier versions stored every value (defaults included), which pinned stale defaults.
const STORAGE_KEY = 'interior-design.scene.v3';

const DEFAULTS = {
  skyVisible: true,
  groundVisible: true,
  background: '#3b3b3b', // shown when the sky is off
  skyTop: '#4f8fd6',
  horizon: '#cfe0ee',
  ground: '#b3afa7', // light concrete / paving
  gridColor: '#7d7a73',
  fog: true,
  fogDistance: 400,
  gridFade: 40,
  skyLight: 0.35, // flat fill; most ambient light comes from envLight (sky bounce)
  sunLight: 3.2,
  sunAzimuth: 34,
  sunElevation: 54,
  sun: true,
  shadows: true,
  exposure: 1,
  realism: true,
  edges: true,
  edgeStrength: 0.35,
  viewShading: 0.5,
  ambientOcclusion: 0.8,
  aoRadius: 0.6,
  envLight: 0.45,
  shadowSoftness: 3,
};

// One-click looks. They only set values; anything can be tweaked afterwards.
const PRESETS = {
  // Sky, ground and haze (SketchUp-like).
  natural: { skyVisible: true, groundVisible: true, fog: true, gridColor: DEFAULTS.gridColor },
  // Plain dark background, no ground, light grid floating in space (Blender-like).
  clean: { skyVisible: false, groundVisible: false, fog: false, background: '#3b3b3b', gridColor: '#8f8f8f' },
};

// Drives the panel UI: one entry per control. `heading` / `label` / option texts are
// translation keys (src/i18n.js). `heading` entries are sub-titles;
// a heading's `card` (default: the previous one) says which panel card it goes in.
const FIELDS = [
  { heading: 's.look', card: 'scene' },
  { type: 'presets', options: [['natural', 's.look.natural'], ['clean', 's.look.clean']] },
  { key: 'skyVisible', label: 's.showSky', type: 'check' },
  { key: 'groundVisible', label: 's.showGround', type: 'check' },
  { key: 'background', label: 's.background', type: 'color' },
  { heading: 's.colors' },
  { key: 'skyTop', label: 's.sky', type: 'color' },
  { key: 'horizon', label: 's.horizon', type: 'color' },
  { key: 'ground', label: 's.ground', type: 'color' },
  { key: 'gridColor', label: 's.gridLines', type: 'color' },
  { heading: 's.distance' },
  { key: 'fog', label: 's.fog', type: 'check' },
  { key: 'fogDistance', label: 's.fogDistance', type: 'range', min: 20, max: 1000, step: 10, unit: 'm' },
  { key: 'gridFade', label: 's.gridFade', type: 'range', min: 10, max: 300, step: 5, unit: 'm' },
  { heading: 's.lighting' },
  { key: 'skyLight', label: 's.skyLight', type: 'range', min: 0, max: 4, step: 0.05 },
  { key: 'sunLight', label: 's.sunLight', type: 'range', min: 0, max: 4, step: 0.05 },
  { key: 'sunAzimuth', label: 's.sunDirection', type: 'range', min: 0, max: 360, step: 1, unit: '°' },
  { key: 'sunElevation', label: 's.sunHeight', type: 'range', min: 5, max: 90, step: 1, unit: '°' },

  { heading: 's.mode', card: 'render' },
  { key: 'realism', label: 's.realism', type: 'check' },
  { heading: 's.clarity' },
  { key: 'edges', label: 's.edges', type: 'check' },
  { key: 'edgeStrength', label: 's.edgeStrength', type: 'range', min: 0, max: 1, step: 0.05 },
  { key: 'viewShading', label: 's.viewShading', type: 'range', min: 0, max: 1, step: 0.05 },
  { heading: 's.light' },
  { key: 'envLight', label: 's.envLight', type: 'range', min: 0, max: 2, step: 0.05, realism: true },
  { key: 'exposure', label: 's.exposure', type: 'range', min: 0.3, max: 2, step: 0.05 },
  { heading: 's.sunShadows' },
  { key: 'sun', label: 's.sun', type: 'check' },
  { key: 'shadows', label: 's.shadows', type: 'check' },
  { key: 'shadowSoftness', label: 's.shadowSoftness', type: 'range', min: 0, max: 10, step: 0.5, realism: true },
  { key: 'ambientOcclusion', label: 's.ao', type: 'range', min: 0, max: 1, step: 0.05, realism: true },
  { key: 'aoRadius', label: 's.aoReach', type: 'range', min: 0.1, max: 2, step: 0.05, unit: 'm', realism: true },
];

/**
 * Scene look & feel (colours, fog / grid fade, sun & sky) and rendering
 * (bounce light, exposure, film look, shadows, AO). Builds its controls into
 * `containers.scene` / `containers.render`, each with its own reset button,
 * and persists values.
 */
export function createSceneSettings({ containers, resetButtons, scene, renderer, pipeline, skyLight, sun, headLight, skyDome, ground }) {
  const values = { ...DEFAULTS };
  try { Object.assign(values, JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')); } catch { /* ignore */ }
  const white = new THREE.Color(0xffffff);

  function apply() {
    const v = values;
    // Sky off: the dome shows one plain background colour (no gradient, no sun glow).
    // (Painting the dome rather than using scene.background keeps the colour exact
    // through the post-processing.)
    if (v.skyVisible) {
      skyDome.setColors(v.skyTop, v.horizon, v.ground);
      skyDome.setGlow(true);
    } else {
      skyDome.setPlain(v.background, v.exposure);
    }
    ground.setFloorVisible(v.groundVisible);
    // Haze takes the horizon colour (or the background) so distant things melt into it.
    const hazeColor = v.skyVisible ? v.horizon : v.background;
    scene.fog = v.fog ? new THREE.Fog(hazeColor, v.fogDistance * 0.2, v.fogDistance) : null;
    ground.floorMaterial.color.set(v.ground);
    ground.underMaterial.color.set(v.ground);
    ground.gridColor.set(v.gridColor);
    ground.setFadeDistance(v.gridFade);

    // Ambient light: bluish from above, earth-coloured bounce from below.
    skyLight.color.set(v.skyTop).lerp(white, 0.65);
    skyLight.groundColor.set(v.ground);
    // With realism off, the bounce light is folded into the flat fill so overall
    // brightness stays about the same.
    // View shading: part of the flat ambient light moves into a light shining from
    // the camera, so faces differ by their angle to the viewer.
    const flat = v.realism ? v.skyLight : v.skyLight + v.envLight * 4.5;
    // Sun off: part of its strength moves into the sky light (which mostly lights
    // upward-facing surfaces like the ground) so the scene doesn't go gloomy.
    const sunToSky = v.sun ? 0 : 0.4 * v.sunLight;
    skyLight.intensity = (flat + sunToSky) * (1 - 0.45 * v.viewShading);
    headLight.intensity = 1.5 * v.viewShading;
    setEdgeLines({ visible: v.edges, opacity: v.edgeStrength });
    sun.intensity = v.sun ? v.sunLight : 0; // Sun off: only sky ambient + camera light
    const az = THREE.MathUtils.degToRad(v.sunAzimuth);
    const el = THREE.MathUtils.degToRad(v.sunElevation);
    // Direction only; main keeps the sun (and its shadow area) centred on the view.
    sun.userData.direction.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
    skyDome.setSunDirection(sun.userData.direction);
    sun.castShadow = v.sun && v.shadows; // shadows need the sun
    renderer.toneMappingExposure = v.exposure;

    // Realism off: no AO, no bounce light, crisp shadows (the slider values are kept).
    pipeline.setAmbientOcclusion(v.realism ? v.ambientOcclusion : 0);
    pipeline.setAmbientOcclusionRadius(v.aoRadius);
    scene.environmentIntensity = v.realism ? v.envLight : 0;
    sun.shadow.radius = v.realism ? v.shadowSoftness : 1;
    for (const { input, f } of Object.values(inputs)) {
      const needs = [];
      if (f.realism) needs.push(v.realism);
      if (f.key === 'edgeStrength') needs.push(v.edges);
      if (f.key === 'shadows' || f.key === 'shadowSoftness') needs.push(v.sun);
      if (f.key === 'shadowSoftness') needs.push(v.shadows);
      if (f.key === 'background') needs.push(!v.skyVisible);
      input.disabled = needs.includes(false);
    }

    // Store only what the user changed, so future default tweaks still apply.
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(changedFrom(DEFAULTS, values) ?? {})); } catch { /* ignore */ }
  }

  // --- UI ---
  const inputs = {};
  const outputs = {};
  const fmt = (f, val) => `${Number(val).toFixed(f.step < 1 ? 2 : 0)}${f.unit ? ` ${f.unit}` : ''}`.replace(' °', '°');

  const cardKeys = { scene: [], render: [] };
  let card = 'scene';
  for (const f of FIELDS) {
    if (f.heading) {
      card = f.card ?? card;
      const h = document.createElement('h4');
      h.dataset.i18n = f.heading;
      h.textContent = t(f.heading);
      containers[card].append(h);
      continue;
    }
    const container = containers[card];
    if (f.type === 'presets') {
      // A row of buttons that apply a preset (not a stored value of its own).
      const row = document.createElement('div');
      row.className = 'presets';
      for (const [name, key] of f.options) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.i18n = key;
        button.textContent = t(key);
        button.addEventListener('click', () => { Object.assign(values, PRESETS[name]); sync(); apply(); });
        row.append(button);
      }
      container.append(row);
      continue;
    }
    cardKeys[card].push(f.key);
    const label = document.createElement('label');
    const text = document.createElement('span');
    text.dataset.i18n = f.label;
    text.textContent = t(f.label);
    label.append(text);
    const input = document.createElement(f.type === 'select' ? 'select' : 'input');
    if (f.type === 'select') {
      for (const [value, key] of f.options) {
        const option = new Option(t(key), value);
        option.dataset.i18n = key;
        input.append(option);
      }
    } else {
      input.type = f.type === 'check' ? 'checkbox' : f.type;
    }
    if (f.type === 'check') input.className = 'check';
    if (f.type === 'range') Object.assign(input, { min: f.min, max: f.max, step: f.step });

    input.addEventListener('input', () => {
      values[f.key] = f.type === 'check' ? input.checked : f.type === 'range' ? parseFloat(input.value) : input.value;
      if (outputs[f.key]) outputs[f.key].textContent = fmt(f, values[f.key]);
      apply();
    });

    if (f.type === 'range') {
      const out = document.createElement('output');
      label.append(out);
      outputs[f.key] = out;
      container.append(label, input);
      input.addEventListener('dblclick', () => { values[f.key] = DEFAULTS[f.key]; sync(); apply(); });
      input.dataset.i18nTitle = 's.dblclickReset';
      input.title = t('s.dblclickReset');
    } else {
      label.append(input);
      container.append(label);
    }
    inputs[f.key] = { input, f };
  }

  function sync() {
    for (const [key, { input, f }] of Object.entries(inputs)) {
      if (f.type === 'check') input.checked = values[key];
      else input.value = String(values[key]);
      if (outputs[key]) outputs[key].textContent = fmt(f, values[key]);
    }
  }

  for (const [c, button] of Object.entries(resetButtons)) {
    button.addEventListener('click', () => {
      for (const k of cardKeys[c]) values[k] = DEFAULTS[k];
      sync();
      apply();
    });
  }

  sync();
  apply();

  return {
    /** Only the values that differ from the defaults (undefined if none). */
    getChanged: () => changedFrom(DEFAULTS, values),
    /** Reset to defaults, then take every valid value from `obj` (e.g. from a design file). */
    set(obj) {
      Object.assign(values, pickValid(DEFAULTS, obj));
      sync();
      apply();
    },
  };
}

/** The entries of `values` that differ from `defaults`, or undefined if there are none. */
export function changedFrom(defaults, values) {
  const out = Object.fromEntries(Object.keys(defaults).filter((k) => values[k] !== defaults[k]).map((k) => [k, values[k]]));
  return Object.keys(out).length ? out : undefined;
}

/** `defaults` overlaid with the entries of `obj` that have the same type (and are finite, for numbers). */
export function pickValid(defaults, obj) {
  const out = { ...defaults };
  if (!obj || typeof obj !== 'object') return out;
  for (const k of Object.keys(defaults)) {
    const v = obj[k];
    if (typeof v === typeof defaults[k] && (typeof v !== 'number' || Number.isFinite(v))) out[k] = v;
  }
  return out;
}
