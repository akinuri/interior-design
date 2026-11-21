import { t } from './i18n.js';

const FORMAT = 'interior-design';
// v4: geometry (vertices, edges, faces). Older files are converted on open: v3 had shapes + lines,
// v1/v2 had walls. Missing parts get defaults.
const VERSION = 4;

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const stamp = () => new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');

/**
 * Design files (.json) to share a whole scene with someone using this app:
 * save / open / drag-and-drop onto the page. Opening a file replaces the
 * entire scene (geometry, person, environment, grid, view); anything the file
 * doesn't contain is reset to defaults.
 *
 * `getScene()` returns the scene as plain data, `setScene(data)` resets the
 * app to it and returns the number of objects loaded.
 */
export function createProjectIO({ getScene, setScene, notify, count }) {
  function save() {
    const data = { format: FORMAT, version: VERSION, savedAt: new Date().toISOString(), ...getScene() };
    download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `design_${stamp()}.json`);
    notify(t('msg.saved', { n: count() }));
  }

  async function load(file) {
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      notify(t('msg.notJson', { name: file.name }), true);
      return;
    }
    if (data?.format !== FORMAT || !(data.geometry || Array.isArray(data.shapes) || Array.isArray(data.walls))) {
      notify(t('msg.notDesign', { name: file.name }), true);
      return;
    }
    if (data.version > VERSION) notify(t('msg.newerVersion'), true);
    const count = setScene(data);
    notify(t('msg.opened', { name: file.name, n: count }));
  }

  function open() {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.json,application/json' });
    input.addEventListener('change', () => input.files[0] && load(input.files[0]));
    input.click();
  }

  // Drop a .json file anywhere on the page to open it.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) load(file);
  });

  return { save, open };
}
