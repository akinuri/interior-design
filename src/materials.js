import * as THREE from 'three';

/*
 * Materials: a texture (built-in, or an image) laid flat on faces at real-world size, with a
 * tint colour. A material is
 *   { id, name, color, builtin? | image?, size: [w, h] (m: one repeat of the texture), rotation (deg) }
 * Images are data URLs kept apart from the material (in the model's image table), so the
 * undo history doesn't copy them.
 *
 * Built-in textures are drawn here (no downloads), with a fixed random seed so they look the
 * same every time. Some hold several units per repeat (planks, bricks: needed for staggered
 * rows); `units` says how many, so sizes can be shown per tile / plank / brick.
 */

const TEX = 512;

/** A small seeded random generator (same pattern every time). */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const shade = (hex, f) => {
  const c = new THREE.Color(hex);
  return `#${c.offsetHSL(0, 0, f).getHexString()}`;
};

const BUILTINS = {
  // One floor tile with half the grout on each side (whole grout lines where tiles meet).
  tiles: {
    size: [0.6, 0.6],
    units: [1, 1],
    draw(g) {
      g.fillStyle = '#e6e1d8';
      g.fillRect(0, 0, TEX, TEX);
      g.strokeStyle = '#9d9585';
      // Half inside each edge, so tiles meeting make one full line: 0.5 cm of grout at 60 cm tiles.
      g.lineWidth = (TEX * 0.005) / 0.6;
      g.strokeRect(0, 0, TEX, TEX);
    },
  },
  // 4 rows of planks (one plank per row, ends staggered).
  wood: {
    size: [1.2, 0.6],
    units: [1, 4],
    draw(g, r) {
      const rows = 4, h = TEX / rows;
      for (let i = 0; i < rows; i++) {
        const base = shade('#b17d4e', (r() - 0.5) * 0.12);
        const cut = r() * TEX;
        for (const [x0, x1] of [[0, cut], [cut, TEX]]) {
          g.fillStyle = shade(base, (r() - 0.5) * 0.05);
          g.fillRect(x0, i * h, x1 - x0, h);
        }
        // Grain: thin wavy lines.
        for (let k = 0; k < 14; k++) {
          const y = i * h + r() * h;
          g.strokeStyle = `rgba(70, 40, 18, ${0.08 + r() * 0.12})`;
          g.lineWidth = 1 + r() * 1.5;
          g.beginPath();
          for (let x = 0; x <= TEX; x += 16) g.lineTo(x, y + Math.sin(x / (40 + r() * 30) + k) * 3);
          g.stroke();
        }
        g.fillStyle = 'rgba(60, 35, 15, 0.55)';
        g.fillRect(cut - 1, i * h, 2, h);
        g.fillRect(0, i * h, TEX, 2);
      }
    },
  },
  // Running-bond brick with mortar: 2 bricks × 4 rows per repeat.
  brick: {
    size: [0.48, 0.3],
    units: [2, 4],
    draw(g, r) {
      g.fillStyle = '#cfc8bd';
      g.fillRect(0, 0, TEX, TEX);
      const rows = 4, bh = TEX / rows, cols = 2, bw = TEX / cols, m = 7;
      for (let i = 0; i < rows; i++) {
        const off = i % 2 ? bw / 2 : 0;
        for (let j = -1; j <= cols; j++) {
          g.fillStyle = shade('#a9533a', (r() - 0.5) * 0.12);
          g.fillRect(j * bw + off + m / 2, i * bh + m / 2, bw - m, bh - m);
        }
      }
    },
  },
  // Plain concrete: a soft blotchy grey.
  concrete: {
    size: [1, 1],
    units: [1, 1],
    draw(g, r) {
      g.fillStyle = '#b9b6b0';
      g.fillRect(0, 0, TEX, TEX);
      for (let k = 0; k < 900; k++) {
        const x = r() * TEX, y = r() * TEX, rad = 2 + r() * 18;
        g.fillStyle = `rgba(${r() > 0.5 ? '255,255,255' : '60,60,60'}, ${0.02 + r() * 0.04})`;
        // Wrap so the texture tiles without seams.
        for (const dx of [-TEX, 0, TEX]) for (const dy of [-TEX, 0, TEX]) {
          g.beginPath(); g.arc(x + dx, y + dy, rad, 0, Math.PI * 2); g.fill();
        }
      }
    },
  },
  // Glass: a pale see-through tint (no pattern: it's drawn transparent and glossy, see model.js).
  glass: {
    size: [1, 1],
    units: [1, 1],
    draw(g) {
      g.fillStyle = '#d3e8ea';
      g.fillRect(0, 0, TEX, TEX);
    },
  },
};

/** Is it glass (see-through, glossy; no texture size to set)? */
export const isGlass = (mat) => mat?.builtin === 'glass';
/** How opaque glass is by default (0 = invisible, 1 = solid). */
export const GLASS_OPACITY = 0.3;

export const BUILTIN_NAMES = Object.keys(BUILTINS);

/** The default size (m) of a built-in texture's repeat. */
export const builtinSize = (key) => [...BUILTINS[key].size];

/** Units (tiles / planks / bricks) across and down one repeat of a material's texture. */
export const unitsOf = (mat) => (mat.builtin && BUILTINS[mat.builtin]?.units) || [1, 1];

const canvasCache = new Map();
/** The canvas of a built-in texture (drawn once). */
function builtinCanvas(key) {
  if (!canvasCache.has(key)) {
    const c = document.createElement('canvas');
    c.width = c.height = TEX;
    BUILTINS[key].draw(c.getContext('2d'), rng(key.length * 7919 + 17));
    canvasCache.set(key, c);
  }
  return canvasCache.get(key);
}

/** A thumbnail URL for a material (for the swatches). */
export function thumbnail(mat, images) {
  if (mat.builtin && BUILTINS[mat.builtin]) return builtinCanvas(mat.builtin).toDataURL('image/png');
  return (mat.image && images.get(mat.image)) || '';
}

const textureCache = new Map(); // builtin key / image id → THREE.Texture
/** The texture of a material (shared between materials using the same picture). */
export function textureOf(mat, images) {
  const key = mat.builtin ? `b:${mat.builtin}` : `i:${mat.image}`;
  if (textureCache.has(key)) return textureCache.get(key);
  let tex = null;
  if (mat.builtin && BUILTINS[mat.builtin]) tex = new THREE.CanvasTexture(builtinCanvas(mat.builtin));
  else if (mat.image && images.get(mat.image)) {
    tex = new THREE.TextureLoader().load(images.get(mat.image));
  }
  if (!tex) return null;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  textureCache.set(key, tex);
  return tex;
}

/** Read an image file as a data URL, scaled down to at most `max` px (JPEG keeps files small). */
export function readImageFile(file, max = 1024) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * k));
      c.height = Math.max(1, Math.round(img.height * k));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve({ dataURL: c.toDataURL('image/jpeg', 0.85), aspect: img.width / img.height });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('not an image')); };
    img.src = url;
  });
}
