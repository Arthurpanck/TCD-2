// Petits composants d'interface partagés : popover, menu, toast, création d'éléments
const UI = (function () {
  const pop = document.getElementById('popover');
  const toastEl = document.getElementById('toast');
  const $id = id => document.getElementById(id);
  let anchor = null, align = 'start', toastTimer = null;

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) { continue; }
      if (k === 'class') { node.className = v; }
      else if (k.startsWith('on') && typeof v === 'function') { node.addEventListener(k.slice(2), v); }
      else { node.setAttribute(k, v === true ? '' : v); }
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) { continue; }
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  /**
   * Place un élément flottant sous `target` (au-dessus faute de place), sans sortir de la fenêtre :
   * position() de jQuery UI, collisions « fit » à l'horizontale et « flip » à la verticale.
   */
  function placeNear(node, target, alignEnd = false) {
    const side = alignEnd ? 'right' : 'left';
    $(node).position({ my: `${side} top`, at: `${side} bottom+6`, of: target, collision: 'fit flip' });
  }

  function position() {
    if (!anchor || pop.hidden) { return; }
    pop.style.maxHeight = (window.innerHeight - 16) + 'px';
    placeNear(pop, anchor, align === 'end');
  }

  function isOpenFor(el) { return !pop.hidden && anchor === el; }
  /** Le menu ouvert, ou l'élément qui l'a ouvert, contient-il `node` ? */
  const menuHolds = node => !pop.hidden && (pop.contains(node) || Boolean(anchor && anchor.contains(node)));

  function openPopover(anchorEl, content, opts = {}) {
    closePopover();
    anchor = anchorEl;
    align = opts.align || 'start';
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
    anchor = null;
  }

  /** Menu d'actions : items = [{ icon (classe fr-icon-*), label, onClick, danger }] ou 'sep' */
  function menu(items, title) {
    const root = el('div', { class: 'menu', role: 'menu' });
    if (title) { root.append(el('div', { class: 'menu-title' }, title)); }
    for (const item of items) {
      if (item === 'sep') { root.append(el('div', { class: 'menu-sep' })); continue; }
      // Bouton tertiaire du DSFR, icône à gauche (fr-icon-*)
      root.append(el('button', {
        type: 'button', role: 'menuitem',
        class: `menu-item fr-btn fr-btn--tertiary-no-outline fr-btn--sm${item.icon ? ' fr-btn--icon-left ' + item.icon : ''}${item.danger ? ' is-danger' : ''}`,
        onclick: () => { closePopover(); item.onClick(); },
      }, item.label));
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

  /** Notification : petite alerte du DSFR (fr-alert--info, --success, --error), en bas de l'écran */
  function toast(message, kind = 'info') {
    toastEl.className = `toast fr-alert fr-alert--sm fr-alert--${kind}`;
    toastEl.replaceChildren(el('p', {}, message));
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2600);
  }

  window.addEventListener('resize', () => position());

  return { el, $id, placeNear, openPopover, closePopover, isOpenFor, menuHolds, menu, segmented, toast };
})();
