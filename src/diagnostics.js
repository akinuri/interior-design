import * as THREE from 'three';

/*
 * Performance diagnostics. Collects everything that could explain low FPS on a
 * given machine and benchmarks frame time with each heavy feature switched off
 * in turn, so reports from different machines can be compared side by side.
 *
 * Run it by clicking the FPS readout, or by opening the page with `?diag`.
 */

// --- captured from page load on ---
const log = [];
const longTasks = { count: 0, totalMs: 0 };
const pushLog = (level, msg) => {
  log.push({ level, atMs: Math.round(performance.now()), msg: String(msg).slice(0, 500) });
  if (log.length > 200) log.shift();
};

/** Call as early as possible so startup warnings / errors are included. */
export function installLogCapture(canvas) {
  for (const level of ['warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      pushLog(level, args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
      original(...args);
    };
  }
  window.addEventListener('error', (e) => pushLog('uncaught', e.message));
  window.addEventListener('unhandledrejection', (e) => pushLog('unhandled-rejection', e.reason?.message ?? e.reason));
  canvas.addEventListener('webglcontextlost', () => pushLog('webgl', 'context lost'));
  canvas.addEventListener('webglcontextrestored', () => pushLog('webgl', 'context restored'));
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) { longTasks.count++; longTasks.totalMs += e.duration; }
    }).observe({ type: 'longtask', buffered: true });
  } catch { /* not supported */ }
}

// --- helpers ---
const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
const round = (v, d = 1) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : v);

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { n: s.length, mean: round(mean, 2), median: round(at(0.5), 2), p95: round(at(0.95), 2), min: round(s[0], 2), max: round(s.at(-1), 2) };
}

/** rAF intervals over `ms` milliseconds. */
async function measureFrameIntervals(ms) {
  const intervals = [];
  let last = await nextFrame();
  const end = last + ms;
  while (last < end) {
    const t = await nextFrame();
    intervals.push(t - last);
    last = t;
  }
  return stats(intervals);
}

function webglInfo(renderer) {
  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const p = (name) => { try { return gl.getParameter(name); } catch { return null; } };
  const unmaskedRenderer = dbg ? p(dbg.UNMASKED_RENDERER_WEBGL) : null;
  const unmaskedVendor = dbg ? p(dbg.UNMASKED_VENDOR_WEBGL) : null;
  const rendererString = `${unmaskedRenderer ?? p(gl.RENDERER)}`;
  return {
    version: p(gl.VERSION),
    shadingLanguage: p(gl.SHADING_LANGUAGE_VERSION),
    vendor: p(gl.VENDOR),
    renderer: p(gl.RENDERER),
    unmaskedVendor,
    unmaskedRenderer,
    // Software rendering = hardware acceleration off / blocklisted GPU.
    likelySoftwareRendering: /swiftshader|llvmpipe|software|basic render|microsoft basic/i.test(rendererString),
    // Dual-GPU laptops sometimes run the browser on the integrated GPU.
    likelyIntegratedGpu: /intel|uhd|iris|radeon\(tm\) graphics|vega \d+ graphics|apple m\d/i.test(rendererString),
    contextAttributes: gl.getContextAttributes(),
    maxTextureSize: p(gl.MAX_TEXTURE_SIZE),
    maxRenderbufferSize: p(gl.MAX_RENDERBUFFER_SIZE),
    maxSamples: p(gl.MAX_SAMPLES),
    maxViewportDims: Array.from(p(gl.MAX_VIEWPORT_DIMS) ?? []),
    timerQuery: !!gl.getExtension('EXT_disjoint_timer_query_webgl2'),
    extensions: gl.getSupportedExtensions(),
  };
}

async function browserInfo() {
  const nav = navigator;
  let uaData = null;
  try {
    uaData = await nav.userAgentData?.getHighEntropyValues(['platform', 'platformVersion', 'architecture', 'model', 'bitness', 'fullVersionList']);
  } catch { /* not available */ }
  let battery = null;
  try {
    const b = await nav.getBattery?.();
    if (b) battery = { charging: b.charging, level: b.level, chargingTimeS: b.chargingTime, dischargingTimeS: b.dischargingTime };
  } catch { /* not available */ }
  return {
    userAgent: nav.userAgent,
    userAgentData: uaData,
    platform: nav.platform,
    language: nav.language,
    hardwareConcurrency: nav.hardwareConcurrency,
    deviceMemoryGB: nav.deviceMemory ?? null, // capped at 8 by browsers
    battery,
    online: nav.onLine,
    prefersReducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    visibility: document.visibilityState,
    crossOriginIsolated: window.crossOriginIsolated,
  };
}

function displayInfo(renderer, canvas) {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  return {
    devicePixelRatio: window.devicePixelRatio, // includes OS scaling and browser zoom
    rendererPixelRatio: renderer.getPixelRatio(),
    screen: { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight, colorDepth: screen.colorDepth },
    window: { innerWidth: innerWidth, innerHeight: innerHeight, outerWidth: outerWidth, outerHeight: outerHeight },
    canvasCss: { width: canvas.clientWidth, height: canvas.clientHeight },
    drawingBuffer: { width: size.x, height: size.y, megapixels: round((size.x * size.y) / 1e6, 2) },
    visualViewportScale: window.visualViewport?.scale ?? null,
    multipleScreens: screen.isExtended ?? null,
  };
}

function rendererInfo(renderer) {
  const c = renderer.capabilities;
  return {
    threeRevision: THREE.REVISION,
    isWebGL2: c.isWebGL2 ?? true,
    precision: c.precision,
    maxSamples: c.maxSamples,
    maxTextureSize: c.maxTextureSize,
    toneMapping: renderer.toneMapping,
    shadowMapEnabled: renderer.shadowMap.enabled,
    shadowMapType: renderer.shadowMap.type,
    memory: { ...renderer.info.memory },
    programs: renderer.info.programs?.length ?? null,
  };
}

/**
 * @param ctx {
 *   renderer, scene, canvas, sun, pipeline, getCamera, pauseLoop, resumeLoop,
 *   getAppState: () => object, onProgress: (text) => void
 * }
 */
export async function runDiagnostics(ctx) {
  const { renderer, scene, canvas, sun, pipeline, getCamera, onProgress } = ctx;
  const gl = renderer.getContext();
  const px = new Uint8Array(4);
  // Reading one pixel waits for the GPU to finish, so timings include GPU work.
  const sync = () => { renderer.setRenderTarget(null); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); };

  const report = {
    tool: 'interior-design diagnostics',
    version: 1,
    takenAt: new Date().toISOString(),
    page: location.origin + location.pathname,
    notes: [],
  };

  onProgress('Collecting system info…');
  report.browser = await browserInfo();
  report.display = displayInfo(renderer, canvas);
  report.webgl = webglInfo(renderer);
  report.renderer = rendererInfo(renderer);
  report.app = ctx.getAppState();

  // Draw calls / triangles for one full frame (all passes).
  renderer.info.autoReset = false;
  renderer.info.reset();
  pipeline.render(getCamera());
  report.renderer.frame = { ...renderer.info.render };
  renderer.info.reset();
  renderer.info.autoReset = true;

  onProgress('Measuring display refresh rate (app paused)…');
  ctx.pauseLoop();
  report.refreshIdleMs = await measureFrameIntervals(1500);
  ctx.resumeLoop();

  onProgress('Measuring frame rate while the app runs…');
  report.appRunningMs = await measureFrameIntervals(2500);

  // --- benchmark: same view, one feature off at a time ---
  ctx.pauseLoop();
  const camera = getCamera();
  const original = {
    pixelRatio: renderer.getPixelRatio(),
    ao: pipeline.getAmbientOcclusion(),
    env: scene.environmentIntensity,
    shadows: sun.castShadow,
  };
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const setPixelRatio = (r) => { renderer.setPixelRatio(r); renderer.setSize(w, h, false); pipeline.setSize(w, h); };
  const restore = () => {
    setPixelRatio(original.pixelRatio);
    pipeline.setAmbientOcclusion(original.ao);
    scene.environmentIntensity = original.env;
    sun.castShadow = original.shadows;
  };

  const configs = [
    { name: 'as configured', apply: () => {} },
    { name: 'no AO (corner shading)', apply: () => pipeline.setAmbientOcclusion(0) },
    { name: 'no sky bounce light', apply: () => { scene.environmentIntensity = 0; } },
    { name: 'no sun shadows', apply: () => { sun.castShadow = false; } },
    { name: 'no post-processing', direct: true, apply: () => {} },
    { name: 'pixel ratio 1', apply: () => setPixelRatio(1) },
    { name: 'pixel ratio 1 + no AO', apply: () => { setPixelRatio(1); pipeline.setAmbientOcclusion(0); } },
    { name: 'minimal (ratio 1, no post, no shadows)', direct: true, apply: () => { setPixelRatio(1); sun.castShadow = false; scene.environmentIntensity = 0; } },
  ];

  report.benchmark = [];
  try {
    for (const [i, c] of configs.entries()) {
      onProgress(`Benchmark ${i + 1}/${configs.length}: ${c.name}…`);
      await nextFrame(); // let the progress text paint
      restore();
      c.apply();
      const frame = () => (c.direct ? renderer.render(scene, camera) : pipeline.render(camera));
      const tCompile = performance.now();
      frame(); sync(); // first frame may compile shaders
      const firstFrameMs = performance.now() - tCompile;
      for (let k = 0; k < 4; k++) { frame(); sync(); }
      const times = [];
      const budgetEnd = performance.now() + 4000; // cap per config on very slow machines
      for (let k = 0; k < 30 && performance.now() < budgetEnd; k++) {
        const t0 = performance.now();
        frame(); sync();
        times.push(performance.now() - t0);
      }
      const size = renderer.getDrawingBufferSize(new THREE.Vector2());
      report.benchmark.push({ name: c.name, firstFrameMs: round(firstFrameMs), buffer: `${size.x}x${size.y}`, frameMs: stats(times) });
    }
  } catch (e) {
    report.benchmarkError = String(e?.message ?? e);
  } finally {
    restore();
    ctx.resumeLoop();
  }

  report.longTasks = { count: longTasks.count, totalMs: round(longTasks.totalMs) };
  report.log = log.slice();
  report.notes = interpret(report);
  return report;
}

/** Plain-language hints derived from the numbers. */
function interpret(r) {
  const notes = [];
  const idleHz = 1000 / r.refreshIdleMs.median;
  const appFps = 1000 / r.appRunningMs.median;
  if (r.webgl.likelySoftwareRendering) notes.push('GPU acceleration looks OFF (software renderer). Check the browser\'s "Use graphics acceleration" setting and chrome://gpu.');
  if (r.webgl.likelyIntegratedGpu) notes.push('Browser is using an integrated GPU. On a laptop with a dedicated GPU, set the browser to "High performance" in Windows Graphics settings.');
  if (idleHz < 50) {
    notes.push(`Even with the app paused the browser only produces ~${Math.round(idleHz)} frames/s: something outside the app caps it (battery saver / browser energy saver, background tab, remote desktop, or software rendering).`);
  } else if (appFps < idleHz * 0.8) {
    notes.push(`App runs at ~${Math.round(appFps)} fps on a ~${Math.round(idleHz)} Hz display: rendering can't keep up.`);
  } else {
    notes.push(`App keeps up with the display (~${Math.round(appFps)} fps at ~${Math.round(idleHz)} Hz): FPS is limited by the monitor's refresh rate, not by rendering.`);
  }
  if (r.display.drawingBuffer.megapixels > 4) notes.push(`Rendering ${r.display.drawingBuffer.megapixels} megapixels per frame (high-DPI screen / zoom): the post-processing cost scales with this.`);
  const base = r.benchmark?.[0]?.frameMs.median;
  if (base) {
    for (const b of r.benchmark.slice(1)) {
      const saved = base - b.frameMs.median;
      if (saved / base > 0.25) notes.push(`"${b.name}" cuts frame time ${round(base)} → ${round(b.frameMs.median)} ms (${Math.round((saved / base) * 100)}% faster).`);
    }
  }
  if (r.log.some((l) => l.level !== 'warn')) notes.push('Errors were logged; see "log".');
  return notes;
}

/** Short human-readable summary for the on-screen panel. */
export function summarize(r) {
  const lines = [];
  lines.push(`GPU: ${r.webgl.unmaskedRenderer ?? r.webgl.renderer}`);
  lines.push(`Browser: ${r.browser.userAgentData?.fullVersionList?.map((b) => `${b.brand} ${b.version}`).find((s) => /Chrome|Edge|Opera|Brave/.test(s)) ?? r.browser.userAgent}`);
  lines.push(`CPU threads: ${r.browser.hardwareConcurrency} · memory ≥ ${r.browser.deviceMemoryGB ?? '?'} GB · battery: ${r.browser.battery ? `${Math.round(r.browser.battery.level * 100)}% ${r.browser.battery.charging ? 'charging' : 'on battery'}` : 'n/a'}`);
  lines.push(`Screen: ${r.display.screen.width}×${r.display.screen.height} · devicePixelRatio ${r.display.devicePixelRatio} · render ratio ${r.display.rendererPixelRatio}`);
  lines.push(`Rendering: ${r.display.drawingBuffer.width}×${r.display.drawingBuffer.height} (${r.display.drawingBuffer.megapixels} MP) · ${r.renderer.frame.calls} draw calls · ${r.renderer.frame.triangles} triangles`);
  lines.push(`Display refresh (idle): ~${Math.round(1000 / r.refreshIdleMs.median)} Hz · app: ~${Math.round(1000 / r.appRunningMs.median)} fps (median ${r.appRunningMs.median} ms, p95 ${r.appRunningMs.p95} ms)`);
  lines.push('');
  lines.push('Frame time, GPU included (median ms, lower is better):');
  for (const b of r.benchmark ?? []) lines.push(`  ${b.name.padEnd(40)} ${String(b.frameMs.median).padStart(7)}   (${b.buffer})`);
  if (r.benchmarkError) lines.push(`  benchmark error: ${r.benchmarkError}`);
  lines.push('');
  for (const n of r.notes) lines.push(`• ${n}`);
  return lines.join('\n');
}
