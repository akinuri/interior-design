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

/**
 * Short form, for showing every tooltip at once (full texts would pile up): the control's name
 * (its aria-label, else the title up to the first ':' / '·') and its shortcut.
 */
function renderShort(el, text) {
  const m = text.match(/\(((?:Ctrl\+|Shift\+|Alt\+)*(?:[A-Za-z0-9]{1,6}|\?))\)/);
  const name = el.getAttribute('aria-label') || text.split(/[:·(]/)[0].trim();
  return render(m ? `${name} (${m[1]})` : name);
}

let allShown = null; // the instances shown by showAllTips, or null

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
    el._tipText = text;
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
  el._tipText = text;
  if (el._tippy) el._tippy.setContent(allShown?.includes(el._tippy) ? renderShort(el, text) : render(text));
  else el.setAttribute('title', text);
}

/**
 * Show the tooltips of every control on screen at once, in short form (on), or go back to
 * hover tooltips (off). Returns whether they're shown.
 */
export function showAllTips(on) {
  for (const t of allShown ?? []) {
    // Back to the full text and usual place only once hidden: changing them during the fade-out
    // shows the long text (in a jumping box) for a moment.
    const restore = () => {
      t.setContent(render(t.reference._tipText ?? ''));
      t.setProps({ offset: [0, 8], onHidden() {} });
    };
    t.setProps({ trigger: 'mouseenter focus', hideOnClick: true, onHidden: restore });
    if (t.state.isVisible) t.hide();
    else restore();
  }
  allShown = null;
  if (!on) return false;
  // Really on screen: what's at its middle is it (not clipped away in a closed card, not covered).
  const seen = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && (hit === el || el.contains(hit) || hit.contains(el));
  };
  allShown = [...document.querySelectorAll('*')].filter((el) => el._tippy && el._tipText && seen(el)).map((el) => el._tippy);
  // A row of buttons along the top: names wider than the buttons, so every other one or two
  // drop lower (three rows), else they'd cover each other.
  const rows = new Map();
  for (const t of allShown) {
    if (t.props.placement !== 'bottom') continue;
    const r = t.reference.getBoundingClientRect();
    const key = Math.round(r.bottom / 8);
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push([r.left, t]);
  }
  for (const row of rows.values()) row.sort((a, b) => a[0] - b[0]).forEach(([, t], i) => t.setProps({ offset: [0, 8 + (i % 3) * 26] }));
  for (const t of allShown) {
    t.setProps({ trigger: 'manual', hideOnClick: false });
    t.setContent(renderShort(t.reference, t.reference._tipText));
    t.show();
  }
  return true;
}

export const allTipsShown = () => allShown != null;
