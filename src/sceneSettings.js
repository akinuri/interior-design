import * as THREE from 'three';

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
  skyLight: 2.6,
  sunLight: 2.8,
  sunAzimuth: 34,
  sunElevation: 54,
  shadows: true,
  exposure: 1,
};

// Drives the panel UI: one entry per control, `heading` entries are sub-titles.
const FIELDS = [
  { heading: 'Colors' },
  { key: 'skyTop', label: 'Sky', type: 'color' },
  { key: 'horizon', label: 'Horizon / haze', type: 'color' },
  { key: 'ground', label: 'Ground', type: 'color' },
  { key: 'gridColor', label: 'Grid lines', type: 'color' },
  { heading: 'Distance & fade' },
  { key: 'fog', label: 'Fog', type: 'check' },
  { key: 'fogDistance', label: 'Fog distance', type: 'range', min: 20, max: 1000, step: 10, unit: 'm' },
  { key: 'gridFade', label: 'Grid fade', type: 'range', min: 10, max: 300, step: 5, unit: 'm' },
  { heading: 'Lighting' },
  { key: 'skyLight', label: 'Sky light', type: 'range', min: 0, max: 4, step: 0.05 },
  { key: 'sunLight', label: 'Sun light', type: 'range', min: 0, max: 4, step: 0.05 },
  { key: 'sunAzimuth', label: 'Sun direction', type: 'range', min: 0, max: 360, step: 1, unit: '°' },
  { key: 'sunElevation', label: 'Sun height', type: 'range', min: 5, max: 90, step: 1, unit: '°' },
  { key: 'shadows', label: 'Shadows', type: 'check' },
  { key: 'exposure', label: 'Exposure', type: 'range', min: 0.3, max: 2, step: 0.05 },
];

/**
 * Scene look & feel: colours, fog / grid fade, lights, exposure.
 * Builds its own controls into `container` and persists values.
 */
export function createSceneSettings({ container, resetButton, scene, renderer, skyLight, sun, skyDome, ground }) {
  const values = { ...DEFAULTS };
  try { Object.assign(values, JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')); } catch { /* ignore */ }
  const white = new THREE.Color(0xffffff);

  function apply() {
    const v = values;
    skyDome.setColors(v.skyTop, v.horizon);
    // Haze takes the horizon colour so the ground melts into the sky.
    scene.fog = v.fog ? new THREE.Fog(v.horizon, v.fogDistance * 0.2, v.fogDistance) : null;
    ground.floorMaterial.color.set(v.ground);
    ground.gridColor.set(v.gridColor);
    ground.setFadeDistance(v.gridFade);

    // Ambient light: bluish from above, earth-coloured bounce from below.
    skyLight.color.set(v.skyTop).lerp(white, 0.65);
    skyLight.groundColor.set(v.ground);
    skyLight.intensity = v.skyLight;
    sun.intensity = v.sunLight;
    const az = THREE.MathUtils.degToRad(v.sunAzimuth);
    const el = THREE.MathUtils.degToRad(v.sunElevation);
    sun.position.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).multiplyScalar(30);
    skyDome.setSunDirection(sun.position);
    sun.castShadow = v.shadows;
    renderer.toneMappingExposure = v.exposure;

    // Store only what the user changed, so future default tweaks still apply.
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(changedFrom(DEFAULTS, values) ?? {})); } catch { /* ignore */ }
  }

  // --- UI ---
  const inputs = {};
  const outputs = {};
  const fmt = (f, val) => `${Number(val).toFixed(f.step < 1 ? 2 : 0)}${f.unit ? ` ${f.unit}` : ''}`.replace(' °', '°');

  for (const f of FIELDS) {
    if (f.heading) {
      const h = document.createElement('h4');
      h.textContent = f.heading;
      container.append(h);
      continue;
    }
    const label = document.createElement('label');
    label.textContent = f.label;
    const input = document.createElement('input');
    input.type = f.type === 'check' ? 'checkbox' : f.type;
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
      input.title = 'Double-click to reset';
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

  resetButton.addEventListener('click', () => {
    Object.assign(values, DEFAULTS);
    sync();
    apply();
  });

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
