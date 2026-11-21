# Interior Design

A simple 3D interior design app that runs in the browser. Draw flat shapes on an infinite ground, push / pull them into 3D, look at the result from any angle, or walk through it at eye height. Built with [Three.js](https://threejs.org/).

## Features

- **Edges and faces, like SketchUp**: everything is made of edges and flat faces, and geometry that touches joins up. Closed loops of lines become faces, a line across a face splits it, and a box drawn on a box is one object.
- **Draw**: line, rectangle and circle, on the ground or on any face (walls too). Points snap to corners, midpoints, edges and the grid.
- **Push / Pull**: give a face depth. Pulling out adds, pushing in carves, and pushing through to the far side cuts a hole, e.g. a door: draw a rectangle on a wall, then push it through.
- **Exact values**: type a number while drawing or pushing, then `Enter`. Lengths are in centimetres (e.g. `250` for a line, `400;300` for a rectangle); add a unit for others (`2.5m`, `25mm`).
- **Edit**: select faces and edges (double-click adds neighbours, triple-click everything connected), change their colour, or delete them. Designs from earlier versions (shapes, walls) are converted when opened.
- **Eye view**: place a person and see the room through their eyes. Walk around with WASD.
- **Views**: orbit, top view and parallel (orthographic) projection.
- **Scene and rendering settings**: sky, ground, sun, fog and grid, plus optional realistic rendering (soft shadows, corner shading, sky bounce light).
- **Save and open**: a design is saved as a `.json` file that someone else can open in this app.
- **English and Turkish**: the language is picked from your browser or OS settings; switch it with the EN / TR button in the top bar (the choice is remembered).

## Running it

```sh
npm install
npm run dev
```

Then open the address it prints. A plain static server such as VS Code's Live Server also works, as long as `npm install` has been run.

## Controls

| Action | Input |
| --- | --- |
| Select / Line / Rectangle / Circle / Push-Pull / Person | `V` / `L` / `R` / `C` / `P` / `U` |
| Orbit | Drag (Select tool) or middle-drag |
| Pan | Right-drag |
| Zoom | Mouse wheel |
| Close a line into a face | Click its start point |
| Stop drawing lines | Double-click, `Enter`, `Esc` or right-click |
| Line at 45° steps / square rectangle | Hold `Shift` while drawing |
| Exact length / size / radius / distance | Type the value, then `Enter` |
| Push / pull a face | Drag it, or click, move, click (`Esc` cancels) |
| Select a face or edge / with neighbours / everything connected | Click / double-click / triple-click (Select tool) |
| Add to / toggle in the selection, select all | `Ctrl`+click / `Shift`+click, `Ctrl+A` |
| Delete selected | `Delete` |
| Eye view (walk with WASD, `Shift` to run, `Space` to jump) | `E` |
| Home (fit scene) / Top view / Parallel projection / Grid on-off | `H` / `T` / `O` / `G` |
| Undo / Redo | `Ctrl+Z` / `Ctrl+Y` |
| Save / Open | `Ctrl+S` / `Ctrl+O` (or drop a file onto the page) |
| Open / close all settings cards | `Ctrl`+click or middle-click a card header |

![A small two-room layout with a green accent wall and a person for scale](docs/screenshot.png)
