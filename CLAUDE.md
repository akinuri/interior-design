# Notes for AI agents

A SketchUp-like 3D interior design app in the browser (Three.js 0.170, plain ES modules, no framework).
README.md describes the features for users; this file is what you need to keep developing it.

## Running

- `npm run dev` (Vite) or a plain static server (the owner uses VS Code Live Server). The page must keep
  working **without a bundler**: `index.html` has an import map pointing into `node_modules`, and a
  `window.process` stand-in for tippy.js. New dependencies need an import-map entry too.
- Pushing to `main` deploys GitHub Pages (`.github/workflows/deploy.yml`). **Never push unless asked.**

## Code map (`src/`)

- `mesh.js`: the geometry. A `Mesh` is vertices, edges and flat faces (loops, the first one outer, the rest holes),
  "sticky" like SketchUp: `rebuildPlane` is the planar arrangement (splits crossing edges, finds regions, keeps
  the ones covered by old faces, cancels back-to-back faces, dissolves edges). `addLoop` / `addSegment` /
  `pushPull` / `erase` build on it.
- `model.js`: the scene state. Root mesh plus groups (separate meshes; one can be "entered" for editing),
  measurements, guides, materials, selection (keys `f<id>` face, `e<id>` edge, `g<id>` group, `m<id>`
  measurement, `u<id>` guide), undo (JSON snapshots, `checkpoint()` before an edit), rendering of meshes.
- `tools.js`: all pointer / keyboard interaction (select, orbit, pan, line, rect, circle, push/pull, move,
  rotate, measure, person), snapping (`snap()` on a plane; `screenSnap()` / `pullSnap()` in screen space;
  `crossings()` for intersections), typed values, axis / edge-aligned locks.
- `main.js`: UI wiring (cards, buttons, views, Home / Focus framing, shortcuts).
- `boolean.js`: union / subtract / intersect of closed groups (BSP CSG, then merged back with `rebuildPlane`).
- `materials.js` (textures), `person.js` (figure, eye view, walking), `measurements.js`, `i18n.js`, `units.js`, others small.

## Conventions

- **Units**: the model is in metres; the UI shows and takes centimetres (`units.js`).
- **i18n**: every UI string is in `i18n.js` in English and Turkish; `index.html` carries the English text too
  (`data-i18n*` attributes). Add both languages.
- **Files**: design files are JSON (`format: 'interior-design'`, `version: 4`); older versions are converted on
  open. Loading validates everything (`setData`), so keep new fields optional with defaults.
- Comments explain *why*; plain words. Keep the existing style (2-space indent, single quotes).

## Working with the owner

- Short requests, iterated quickly; they compare against SketchUp. Prefer SketchUp's behaviour when unsure.
- A bare `c` means: commit the pending work (no push); a bare `p` means: push. Commit style: `(feat)`, `(fix)`, `(ui)`, `(docs)` + short
  summary; split unrelated changes into separate commits.
- Don't commit their files: `ref/`, screenshots in the root, `scene_*.png`, `design_*.json`.
- UI taste: general controls first (e.g. "Add" before lists), separators between groups, subtle labels, no
  visible text inputs where a live label will do, minimal cursor changes. Fix lighting with lighting, not colours.

## Behaviour settled with the owner (don't undo without asking)

- **Snapping**: on/off with `S` (kept in localStorage, not in files). Order: corners → intersections (red X) →
  midpoints → edges → faces → axes / along or across an edge (magenta ∥ ⊥) → grid. Point snaps show as shapes
  (square corner, diamond midpoint, X intersection, dot edge); otherwise a see-through `+`. Snaps work across
  groups, also while editing one, for Move and Push/Pull (drawing tools still snap within the edited group only).
- **Push/Pull**: no grid steps; hover a corner / edge / parallel face of anything to go level with it; type for exact.
- **Move**: shows grab points (corners, midpoints) of what will move; with nothing selected, of what's under the
  mouse (kept while reaching for an outer corner). Moves along the floor, but in a level view (camera within
  ~15° of horizontal) along the upright plane facing the camera. Locks: Shift (held, nearest axis), `→`/`←` X/Z,
  `↑` vertical. Moves landing over 1 km away are ignored (one once flung a group 500,000 km; Home went blank).
  A tap on Ctrl (alone, not Ctrl+key) toggles copy mode, before or during a move; it resets after each move.
- **Rotate** (`K`; Q is Orbit): centre → start direction → angle (15° steps, corners exact, typed degrees). The
  protractor lies on the face under the mouse; `↑`/`→`/`←` lock Y/X/Z. The bounding box (world axes) shows
  handles only on the hovered side, all blue: a centre one (protractor placed, axis fixed) and four out from it
  (turn straight away). Ctrl copies, as with Move.
- **Measure**: ending on a corner / edge / midpoint / intersection → a measurement (ends, line, label). Ending
  anywhere else, from any start → a guide through the end, square to the measured line, labelled (from an edge:
  parallel to that edge). Shift locks the direction (sticky: stays after release; dropped by waving the mouse
  well away, pressing Shift again, or finishing); while locked, typing a length works (Shift+digits too).
- **Booleans**: two closed groups selected → Union / Subtract / Intersect. Subtract cuts the *first selected*
  out of the other (SketchUp). Result is one group; cut faces take the cutter's colour / material.
- **Esc** repeatedly: cancel → leave eye view → deselect → leave group → Select tool.
- **Person** stands on the floor-like face under them (`state.y`); walks up steps ≤ 35 cm, falls off edges.
- **Materials**: size is per tile / plank / brick (`units` in `materials.js`), plus rotation and offset.

## Known gaps / ideas not done

- Guides don't follow push/pull; moved vertices don't merge with ones they land on.
- Line / rect / circle don't snap to geometry outside a group being edited (asked, no answer yet).
- Booleans: groups only (not loose geometry), closed solids only; curved shapes may leave extra edges.
- SketchUp's measure-tool mode cycling (guide line / point / measure) was discussed and skipped.

## Testing

No test suite. Verify in a real browser: `npm run build && npx vite preview --port 4224`, then drive it with
`puppeteer-core` and the installed Chrome (`--enable-gpu --use-angle=d3d11` for WebGL). Load scenes by
dispatching a `drop` event with a JSON file; read results back by clicking `#file-save` and capturing the
download. Pure geometry (`mesh.js`, `boolean.js`) can be tested in Node directly. Look at screenshots, not just numbers.
Gotchas: click rebuilt UI elements with `el.click()` inside `page.evaluate`; wait for the preview server before
loading; typed lengths are cm. If a design "shows nothing" on Home, check the file for absurd coordinates.
`docs/screenshot.png` is the README image: `docs/sample-scene.json` (an old v2 file, also a good conversion test)
opened at 1920×1080 (narrower and the two top bars wrap), mouse off the canvas, after the AO settles.
