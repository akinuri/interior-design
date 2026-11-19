import tippy from 'tippy.js';

/*
 * Styled tooltips (Tippy.js) for everything that has a `title`.
 * A trailing "(X)" or "(Ctrl+S)" in the title is shown as key badges.
 * Use setTip() to change a tooltip later (setting `title` again would bring
 * back the browser's native tooltip).
 */

const escape = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function render(text) {
  const m = text.match(/^(.*?)\s*\(((?:Ctrl\+|Shift\+|Alt\+)*(?:[A-Za-z0-9]{1,6}|\?))\)\s*(.*)$/s);
  if (!m) return `<span>${escape(text)}</span>`;
  const [, label, shortcut, rest] = m;
  const keys = shortcut.split('+').map((k) => `<kbd>${escape(k)}</kbd>`).join('<span class="plus">+</span>');
  const tail = !rest ? '' : /^[,.;:]/.test(rest) ? rest : ` ${rest}`;
  return `<span>${escape(label + tail)}</span><span class="keys">${keys}</span>`;
}

/** Tooltip side: away from the screen edge the control sits on. */
function placementFor(el) {
  if (el.closest('.tools')) return 'right';
  if (el.closest('.toolbar')) return 'bottom';
  if (el.closest('.fps')) return 'top-end';
  if (el.closest('.panel.selection')) return 'bottom';
  if (el.closest('.panel')) return 'left';
  return 'top';
}

/** Convert every element with a `title` under `root` (call again after adding UI). */
export function initTooltips(root = document) {
  for (const el of root.querySelectorAll('[title]')) {
    const text = el.getAttribute('title');
    el.removeAttribute('title');
    if (!text) continue;
    if (el._tippy) { setTip(el, text); continue; }
    tippy(el, {
      content: render(text),
      allowHTML: true, // content is escaped in render()
      theme: 'app',
      placement: placementFor(el),
      delay: [350, 0],
      duration: [150, 100],
      offset: [0, 8],
      arrow: true,
      // Don't keep a tooltip up while dragging a slider etc.
      hideOnClick: true,
      touch: false,
    });
  }
}

/** Change an element's tooltip text. */
export function setTip(el, text) {
  if (el._tippy) el._tippy.setContent(render(text));
  else el.setAttribute('title', text);
}
