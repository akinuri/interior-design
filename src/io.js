const FORMAT = 'interior-design';
const VERSION = 2; // v1 files (walls + person only) still open; missing parts get defaults

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
 * entire scene (walls, person, environment, grid, view); anything the file
 * doesn't contain is reset to defaults.
 *
 * `getScene()` returns the scene as plain data, `setScene(data)` resets the
 * app to it and returns the number of walls loaded.
 */
export function createProjectIO({ getScene, setScene, notify }) {
  function save() {
    const data = { format: FORMAT, version: VERSION, savedAt: new Date().toISOString(), ...getScene() };
    download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `design_${stamp()}.json`);
    notify(`Saved scene (${data.walls.length} walls)`);
  }

  async function load(file) {
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      notify(`Couldn't read ${file.name}: not a valid JSON file`, true);
      return;
    }
    if (data?.format !== FORMAT || !Array.isArray(data.walls)) {
      notify(`${file.name} isn't a design file from this app`, true);
      return;
    }
    if (data.version > VERSION) notify('File is from a newer version; some parts may not load', true);
    const count = setScene(data);
    notify(`Opened ${file.name} (${count} walls)`);
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
