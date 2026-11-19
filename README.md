# Interior Design

A simple 3D interior design app that runs in the browser. Draw walls on an infinite ground, look at the result from any angle, or walk through it at eye height. Built with [Three.js](https://threejs.org/).

## Features

- **Draw walls**: click point by point, or drag out a whole rectangular room. Points snap to the grid and to existing wall ends.
- **Edit walls**: select a wall to change its height, thickness or colour, or drag its corners. Connected walls follow.
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
| Select / Wall / Room / Person tool | `V` / `W` / `R` / `P` |
| Orbit | Drag (Select tool) or middle-drag |
| Pan | Right-drag |
| Zoom | Mouse wheel |
| Finish a wall chain | Double-click, `Enter` or right-click |
| Lock wall angle to 45° steps | Hold `Shift` while drawing |
| Delete selected wall | `Delete` |
| Eye view (walk with WASD, `Shift` to run, `Space` to jump) | `E` |
| Home (fit scene) / Top view / Parallel projection / Grid on-off | `H` / `T` / `O` / `G` |
| Undo / Redo | `Ctrl+Z` / `Ctrl+Y` |
| Save / Open | `Ctrl+S` / `Ctrl+O` (or drop a file onto the page) |
| Open / close all settings cards | `Ctrl`+click or middle-click a card header |

![A small two-room layout with a green accent wall and a person for scale](docs/screenshot.png)
