import * as THREE from 'three';
import { t } from './i18n.js';

// v3: earlier versions stored every value (defaults included), which pinned stale defaults.
const STORAGE_KEY = 'interior-design.scene.v3';

const DEFAULTS = {
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
  shadows: true,
  exposure: 1,
  realism: true,
  ambientOcclusion: 0.8,
  aoRadius: 0.6,
  envLight: 0.45,
  shadowSoftness: 3,
  toneMapping: 'neutral',
};

const TONE_MAPPINGS = {
  neutral: THREE.NeutralToneMapping,
  agx: THREE.AgXToneMapping,
  aces: THREE.ACESFilmicToneMapping,
};

// Drives the panel UI: one entry per control. `heading` / `label` / option texts are
// translation keys (src/i18n.js). `heading` entries are sub-titles;
// a heading's `card` (default: the previous one) says which panel card it goes in.
const FIELDS = [
  { heading: 's.colors', card: 'scene' },
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
  { heading: 's.light' },
  { key: 'envLight', label: 's.envLight', type: 'range', min: 0, max: 2, step: 0.05, realism: true },
  { key: 'exposure', label: 's.exposure', type: 'range', min: 0.3, max: 2, step: 0.05 },
  { key: 'toneMapping', label: 's.filmLook', type: 'select', options: [['neutral', 's.film.neutral'], ['agx', 's.film.agx'], ['aces', 's.film.aces']] },
  { heading: 's.shadows' },
  { key: 'shadows', label: 's.sunShadows', type: 'check' },
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
export function createSceneSettings({ containers, resetButtons, scene, renderer, pipeline, skyLight, sun, skyDome, ground }) {
  const values = { ...DEFAULTS };
  try { Object.assign(values, JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')); } catch { /* ignore */ }
  const white = new THREE.Color(0xffffff);

  function apply() {
    const v = values;
    skyDome.setColors(v.skyTop, v.horizon, v.ground);
    // Haze takes the horizon colour so the ground melts into the sky.
    scene.fog = v.fog ? new THREE.Fog(v.horizon, v.fogDistance * 0.2, v.fogDistance) : null;
    ground.floorMaterial.color.set(v.ground);
    ground.gridColor.set(v.gridColor);
    ground.setFadeDistance(v.gridFade);

    // Ambient light: bluish from above, earth-coloured bounce from below.
    skyLight.color.set(v.skyTop).lerp(white, 0.65);
    skyLight.groundColor.set(v.ground);
    // With realism off, the bounce light is folded into the flat fill so overall
    // brightness stays about the same.
    skyLight.intensity = v.realism ? v.skyLight : v.skyLight + v.envLight * 4.5;
    sun.intensity = v.sunLight;
    const az = THREE.MathUtils.degToRad(v.sunAzimuth);
    const el = THREE.MathUtils.degToRad(v.sunElevation);
    // Direction only; main keeps the sun (and its shadow area) centred on the view.
    sun.userData.direction.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
    skyDome.setSunDirection(sun.userData.direction);
    sun.castShadow = v.shadows;
    renderer.toneMappingExposure = v.exposure;

    // Realism off: no AO, no bounce light, crisp shadows (the slider values are kept).
    pipeline.setAmbientOcclusion(v.realism ? v.ambientOcclusion : 0);
    pipeline.setAmbientOcclusionRadius(v.aoRadius);
    scene.environmentIntensity = v.realism ? v.envLight : 0;
    sun.shadow.radius = v.realism ? v.shadowSoftness : 1;
    for (const { input, f } of Object.values(inputs)) if (f.realism) input.disabled = !v.realism;
    renderer.toneMapping = TONE_MAPPINGS[v.toneMapping] ?? THREE.NeutralToneMapping;

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
