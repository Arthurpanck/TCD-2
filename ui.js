// Petits composants d'interface partagés : popover, menu, toast, création d'éléments
const UI = (function () {
  const pop = document.getElementById('popover');
  const toastEl = document.getElementById('toast');
  let anchor = null, onClose = null, align = 'start', toastTimer = null;

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) { continue; }
      if (k === 'class') { node.className = v; }
      else if (k === 'html') { node.innerHTML = v; }
      else if (k.startsWith('on') && typeof v === 'function') { node.addEventListener(k.slice(2), v); }
      else if (k === 'dataset') { Object.assign(node.dataset, v); }
      else { node.setAttribute(k, v === true ? '' : v); }
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) { continue; }
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  function position() {
    if (!anchor || pop.hidden) { return; }
    const r = anchor.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    pop.style.maxHeight = (vh - 16) + 'px';
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let left = align === 'end' ? r.right - pw : r.left;
    left = Math.max(8, Math.min(left, vw - pw - 8));
    let top = r.bottom + 6;
    if (top + ph > vh - 8 && r.top - ph - 6 >= 8) { top = r.top - ph - 6; }
    top = Math.max(8, Math.min(top, vh - ph - 8));
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }

  function isOpenFor(el) { return !pop.hidden && anchor === el; }

  function openPopover(anchorEl, content, opts = {}) {
    closePopover();
    anchor = anchorEl;
    align = opts.align || 'start';
    onClose = opts.onClose || null;
    pop.className = 'popover ' + (opts.className || '');
    pop.replaceChildren(content);
    pop.hidden = false;
    anchorEl.setAttribute('aria-expanded', 'true');
    position();
    const focusTarget = pop.querySelector('[autofocus], input[type=search], button:not([disabled])');
    if (focusTarget) { focusTarget.focus({ preventScroll: true }); }
  }

  function closePopover() {
    if (pop.hidden) { return; }
    pop.hidden = true;
    if (anchor) { anchor.setAttribute('aria-expanded', 'false'); }
    const cb = onClose;
    anchor = null;
    onClose = null;
    if (cb) { cb(); }
  }

  /** Menu d'actions : items = [{ icon, label, onClick, danger }] ou 'sep' */
  function menu(items, title) {
    const root = el('div', { class: 'menu', role: 'menu' });
    if (title) { root.append(el('div', { class: 'menu-title' }, title)); }
    for (const item of items) {
      if (item === 'sep') { root.append(el('div', { class: 'menu-sep' })); continue; }
      root.append(el('button', {
        type: 'button', role: 'menuitem', class: 'menu-item' + (item.danger ? ' is-danger' : ''),
        onclick: () => { closePopover(); item.onClick(); },
        html: (item.icon ? Icons.get(item.icon, 15) : '') + `<span></span>`,
      }));
      root.lastChild.querySelector('span').textContent = item.label;
    }
    return root;
  }

  let segSeq = 0;
  /** Bouton segmenté du DSFR (fr-segmented) : items = [[valeur, libellé]] */
  function segmented(legend, items, value, onChange) {
    const name = 'seg-' + (++segSeq);
    return el('fieldset', { class: 'fr-segmented fr-segmented--sm' },
      el('legend', { class: 'fr-segmented__legend' }, legend),
      el('div', { class: 'fr-segmented__elements' }, items.map(([v, label], i) => {
        const id = `${name}-${i}`;
        const input = el('input', { type: 'radio', id, name, value: v, onchange: () => onChange(v) });
        input.checked = v === value;
        return el('div', { class: 'fr-segmented__element' }, input, el('label', { class: 'fr-label', for: id }, label));
      })));
  }

  function toast(message, kind = 'info') {
    toastEl.textContent = message;
    toastEl.className = 'toast is-' + kind;
    toastEl.hidden = false;
    requestAnimationFrame(() => toastEl.classList.add('is-visible'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.remove('is-visible');
      setTimeout(() => { toastEl.hidden = true; }, 200);
    }, 2600);
  }

  document.addEventListener('mousedown', e => {
    if (!pop.hidden && !pop.contains(e.target) && !(anchor && anchor.contains(e.target))) { closePopover(); }
  }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closePopover(); } });
  window.addEventListener('resize', () => position());

  return { el, openPopover, closePopover, isOpenFor, menu, segmented, toast };
})();
