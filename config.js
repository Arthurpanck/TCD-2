/**
 * Panneau de configuration bâti sur pivotUI.
 * pivotUI garde toute la logique (glisser-déposer, filtres, calcul, tri, rendu) ;
 * ce module place ses éléments dans le panneau et les habille : puces typées, menus,
 * fenêtres de filtre positionnées, libellés des calculs et des tris.
 * Les éléments déplacés restent dans l'hôte de pivotUI, qui les retrouve par leurs classes.
 */
const TCDConfig = (function () {
  const { el } = UI;
  const $id = id => document.getElementById(id);
  let app = null;
  let $host = null;
  let dragging = false;
  let pendingAnchor = null;

  const ORDER_LABELS = {
    key_a_to_z: 'Libellé A → Z',
    value_a_to_z: 'Valeur croissante',
    value_z_to_a: 'Valeur décroissante',
  };

  function init(api) {
    app = api;
    $id('row-totals').addEventListener('change', e => app.update({ rowTotals: e.target.checked }));
    $id('col-totals').addEventListener('change', e => app.update({ colTotals: e.target.checked }));
    $id('subtotals').addEventListener('change', e => app.update({ subtotals: e.target.checked }));
    $id('click-detail').addEventListener('change', e => app.update({ clickDetail: e.target.checked }));
    $id('heat-scope').addEventListener('change', e => setRenderer(rendererName('heat', e.target.value)));
    segmented($id('renderer-seg'), v => setRenderer(rendererName(v, $id('heat-scope').value)));
    segmented($id('density-seg'), v => app.update({ density: v }));

    $id('swap-axes').innerHTML = Icons.svg('swap', 15);
    $id('swap-axes').addEventListener('click', swapAxes);
    $id('clear-filters').addEventListener('click', () => {
      $('#filter-layer input.pvtFilter').prop('checked', true);
      $host.find('.pvtFilteredAttribute').removeClass('pvtFilteredAttribute');
      app.refreshPivot();
    });
    $id('field-search').addEventListener('input', filterFieldList);
    $id('cfg-done').addEventListener('click', () => app.closeConfig());
    $id('cfg-revert').addEventListener('click', () => app.revert());

    // Fenêtres de filtre : fermeture par Échap ou clic à l'extérieur (équivaut à « Annuler »)
    document.addEventListener('mousedown', e => {
      if (e.target.closest('.pvtFilterBox, .pvtTriangle, .filter-pill, .sum-filters, .popover')) { return; }
      closeFilterBoxes();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && openBox()) { e.stopImmediatePropagation(); closeFilterBoxes(); }
    }, true);
  }

  function segmented(root, onPick) {
    root.addEventListener('click', e => {
      const b = e.target.closest('button[data-value]');
      if (b) { onPick(b.dataset.value); }
    });
  }

  function setSegmented(root, value) {
    root.querySelectorAll('button[data-value]').forEach(b => {
      const on = b.dataset.value === value;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-checked', on);
    });
  }

  /** Nom pivottable (français) du rendu */
  function rendererName(kind, scope) {
    if (kind === 'heat') {
      return { row: 'Carte de chaleur par ligne', col: 'Carte de chaleur par colonne' }[scope] || 'Carte de chaleur';
    }
    return kind === 'bars' ? 'Table avec barres' : 'Table';
  }

  /** Choisit le rendu dans la liste de pivotUI, qui recalcule le tableau */
  function setRenderer(name) {
    $host.find('select.pvtRenderer').val(name).trigger('change');
  }

  // ---------------------------------------------------------------------------
  // Mise en place des éléments de pivotUI (après chaque construction)
  // ---------------------------------------------------------------------------

  /** @param {jQuery} host - élément sur lequel pivotUI a été appelé */
  function adopt(host) {
    $host = host;
    const ui = host.children('table.pvtUi');
    const unused = ui.find('td.pvtUnused');

    // Chaque fenêtre de filtre suit la puce du même rang (classe axis_N)
    unused.children('.pvtFilterBox').each((i, box) => { box.dataset.axis = i; decorateFilterBox(box); });
    $('#filter-layer').append(unused.children('.pvtFilterBox'));

    $('#slot-unused').append(unused.removeClass('pvtVertList pvtHorizList'));
    $('#slot-rows').append(ui.find('td.pvtRows'));
    $('#slot-cols').append(ui.find('td.pvtCols').removeClass('pvtHorizList'));
    $('#slot-row-order').append(ui.find('a.pvtRowOrder').addClass('btn order-btn'));
    $('#slot-col-order').append(ui.find('a.pvtColOrder').addClass('btn order-btn'));
    $('#slot-vals').append(ui.find('td.pvtVals'));
    $('#slot-renderer').append(ui.find('select.pvtRenderer').closest('td'));
    $('#output').append(ui.find('td.pvtRendererArea'));
    ui.remove();

    host.find('td.pvtVals br').remove();
    groupAggregators(host.find('select.pvtAggregator'));

    const fields = new Map(app.fields().map(f => [f.name, f]));
    host.find('.pvtAxisContainer li').each((_i, li) => decorateChip(li, fields));
    // Champs disponibles dans l'ordre des colonnes, chaque date suivie de ses regroupements
    const order = app.fields().map(f => f.name);
    unused.children('li').sort((a, b) => order.indexOf(attrOf(a)) - order.indexOf(attrOf(b))).appendTo(unused);
    $id('field-count').textContent = `${app.fields().filter(f => !f.parent).length} champs`;

    host.find('.pvtAxisContainer').on('sortstart', (_e, ui2) => {
      dragging = true;
      document.body.classList.add('is-dragging');
      ui2.placeholder.css({ width: ui2.item.outerWidth(), height: ui2.item.outerHeight() });
      UI.closePopover();
      closeFilterBoxes();
    }).on('sortstop', () => {
      document.body.classList.remove('is-dragging');
      setTimeout(() => { dragging = false; }, 0);
    }).sortable('option', { tolerance: 'pointer', distance: 4, cursor: 'grabbing' });
    filterFieldList();
  }

  const attrOf = li => $(li).children('span.pvtAttr').data('attrName');
  const liOf = attr => $host.find('.pvtAxisContainer li').filter((_i, li) => attrOf(li) === attr);
  const axisOf = li => [...li.classList].find(c => c.startsWith('axis_')).slice(5);
  const boxOf = li => document.querySelector(`#filter-layer .pvtFilterBox[data-axis="${axisOf(li)}"]`);

  /** Liste des calculs regroupée par famille, avec des libellés lisibles (la valeur reste la clé pivottable) */
  function groupAggregators(select) {
    const current = select.val();
    const known = new Set(select.children('option').map((_i, o) => o.value).get());
    const groups = TCDAggregators.GROUPS.map(([label, names]) => {
      const og = el('optgroup', { label });
      names.filter(n => known.has(n)).forEach(n => { og.append(el('option', { value: n }, TCDAggregators.LABELS[n] || n)); known.delete(n); });
      return og;
    });
    const others = el('optgroup', { label: 'Autres' }, [...known].map(n => el('option', { value: n }, TCDAggregators.LABELS[n] || n)));
    select.empty().append(groups, known.size ? others : []).val(current).addClass('input');
  }

  function typeBadge(field) {
    if (field && field.type === 'number') { return el('span', { class: 'ft ft-number', title: 'Nombre' }, '#'); }
    if (field && field.type === 'date') { return el('span', { class: 'ft ft-date', title: 'Date', html: Icons.svg('calendar', 11) }); }
    return el('span', { class: 'ft ft-text', title: 'Texte' }, 'Aa');
  }

  function decorateChip(li, fields) {
    const attr = attrOf(li);
    const field = fields.get(attr);
    li.classList.add('chip');
    li.dataset.attr = attr;
    if (field && field.parent) { li.classList.add('is-derived'); }
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.title = field && field.parent ? `${field.parent} regroupé par ${attr.split(' › ').pop().toLowerCase()}` : attr;
    li.prepend(typeBadge(field));
    const triangle = li.querySelector('.pvtTriangle');
    triangle.innerHTML = Icons.svg('filter', 12);
    triangle.title = 'Filtrer les valeurs';
    triangle.addEventListener('click', placeFilterBox);
    li.append(el('button', {
      type: 'button', class: 'chip-btn chip-remove', title: 'Retirer', 'aria-label': `Retirer ${attr}`, html: Icons.svg('x', 12),
      onclick: e => { e.stopPropagation(); moveTo(attr, 'unused'); },
    }));
    li.addEventListener('click', e => {
      if (dragging || e.target.closest('.pvtTriangle, .chip-btn')) { return; }
      openChipMenu(attr, li);
    });
    li.addEventListener('keydown', e => {
      if (e.target !== li) { return; }
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openChipMenu(attr, li); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && zoneOf(li) !== 'unused') { moveTo(attr, 'unused'); }
    });
  }

  function zoneOf(li) {
    const td = li.closest('.pvtAxisContainer');
    return td.classList.contains('pvtRows') ? 'rows' : td.classList.contains('pvtCols') ? 'cols' : 'unused';
  }

  /** Déplace une puce comme le ferait un glisser-déposer, puis laisse pivotUI recalculer */
  function moveTo(attr, zone) {
    const target = { rows: 'td.pvtRows', cols: 'td.pvtCols', unused: 'td.pvtUnused' }[zone];
    $host.find(target).append(liOf(attr));
    UI.closePopover();
    filterFieldList();
    app.refreshPivot();
  }

  function swapAxes() {
    const rows = $host.find('td.pvtRows'), cols = $host.find('td.pvtCols');
    const rowLis = rows.children('li'), colLis = cols.children('li');
    rows.append(colLis);
    cols.append(rowLis);
    const r = $host.find('a.pvtRowOrder'), c = $host.find('a.pvtColOrder');
    const ro = r.data('order');
    r.data('order', c.data('order'));
    c.data('order', ro);
    app.refreshPivot();
  }

  function openChipMenu(attr, anchor) {
    if (UI.isOpenFor(anchor)) { UI.closePopover(); return; }
    const zone = zoneOf(anchor);
    const items = [];
    if (zone !== 'rows') { items.push({ icon: 'rows', label: zone === 'cols' ? 'Déplacer vers les lignes' : 'Ajouter aux lignes', onClick: () => moveTo(attr, 'rows') }); }
    if (zone !== 'cols') { items.push({ icon: 'cols', label: zone === 'rows' ? 'Déplacer vers les colonnes' : 'Ajouter aux colonnes', onClick: () => moveTo(attr, 'cols') }); }
    items.push({ icon: 'filter', label: 'Filtrer les valeurs…', onClick: () => openFilter(attr, anchor) });
    if (zone !== 'unused') { items.push('sep', { icon: 'x', label: 'Retirer du tableau', danger: true, onClick: () => moveTo(attr, 'unused') }); }
    UI.openPopover(anchor, UI.menu(items, attr));
  }

  // ---------------------------------------------------------------------------
  // Fenêtres de filtre de pivotUI
  // ---------------------------------------------------------------------------

  function decorateFilterBox(box) {
    box.classList.add('filter-pop');
    box.querySelectorAll('input.pvtSearch').forEach(i => { i.type = 'search'; i.classList.add('input'); });
    box.querySelectorAll('p:not(:last-child) button').forEach(b => b.classList.add('link-btn'));
    const final = box.querySelectorAll(':scope > p:last-child button');
    final.forEach((b, i) => b.classList.add('btn', i === 0 && final.length > 1 ? 'btn-primary' : 'btn-ghost'));
    box.querySelectorAll('span.count').forEach(s => { s.textContent = s.textContent.replace(/[()]/g, ''); });
  }

  const openBox = () => [...document.querySelectorAll('#filter-layer .pvtFilterBox')].find(b => b.style.display !== 'none');

  function closeFilterBoxes() {
    const box = openBox();
    if (box) { $(box).children('p').last().find('button').last().trigger('click'); }
  }

  /** Ouvre la fenêtre de filtre de pivotUI d'un champ, près de l'élément `anchor` */
  function openFilter(attr, anchor) {
    UI.closePopover();
    const li = liOf(attr);
    if (!li.length) { return; }
    closeFilterBoxes();
    pendingAnchor = anchor || null;
    li.find('.pvtTriangle').trigger('click');
  }

  /** Repositionne la fenêtre ouverte par pivotUI (après son propre gestionnaire de clic) */
  function placeFilterBox(e) {
    const box = boxOf(e.currentTarget.closest('li'));
    const visible = el => el && el.isConnected && el.getClientRects().length > 0;
    const anchor = visible(pendingAnchor) ? pendingAnchor : e.currentTarget;
    pendingAnchor = null;
    document.querySelectorAll('#filter-layer .pvtFilterBox').forEach(b => { if (b !== box) { b.style.display = 'none'; } });
    const r = anchor.getBoundingClientRect();
    const w = box.offsetWidth, h = box.offsetHeight;
    box.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
    box.style.top = (r.bottom + 6 + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 6) : r.bottom + 6) + 'px';
    const search = box.querySelector('input.pvtSearch');
    if (search) { search.focus({ preventScroll: true }); }
  }

  function clearFilter(attr) {
    const li = liOf(attr);
    if (!li.length) { return; }
    $(boxOf(li[0])).find('input.pvtFilter').prop('checked', true);
    li.removeClass('pvtFilteredAttribute');
    app.refreshPivot();
  }

  function filterFieldList() {
    const q = $id('field-search').value.trim().toLocaleLowerCase('fr');
    document.querySelectorAll('#slot-unused li.chip').forEach(li => {
      li.hidden = q && !String(attrOf(li)).toLocaleLowerCase('fr').includes(q);
    });
    document.querySelectorAll('#slot-rows li.chip, #slot-cols li.chip').forEach(li => { li.hidden = false; });
  }

  // ---------------------------------------------------------------------------
  // Synchronisation après chaque calcul de pivotUI
  // ---------------------------------------------------------------------------

  /** Pastille de filtre actif (réutilisée dans la barre de consultation) */
  function filterPill(attr, count, compact) {
    const pill = el('span', { class: 'filter-pill' + (compact ? ' is-compact' : '') });
    const open = el('button', {
      type: 'button', class: 'filter-pill-main', title: 'Modifier le filtre',
      html: Icons.svg('filter', 12) + '<span></span>',
      // Dans une popover, la pastille disparaît à l'ouverture du filtre : on ancre sur le bouton de résumé
      onclick: () => openFilter(attr, compact ? (document.querySelector('.sum-filters') || pill) : pill),
    });
    open.querySelector('span').textContent = `${attr} · ${count} masquée${count > 1 ? 's' : ''}`;
    const clear = el('button', {
      type: 'button', class: 'filter-pill-clear', title: 'Supprimer ce filtre', html: Icons.svg('x', 12),
      onclick: () => { UI.closePopover(); clearFilter(attr); },
    });
    pill.append(open, clear);
    return pill;
  }

  /** @param {Object} pvt - options courantes de pivotUI (noms de champs affichés) */
  function sync(pvt) {
    if (!$host) { return; }
    const s = app.settings();
    // Tri : libellés lisibles sur les boutons de pivotUI (un clic passe au tri suivant)
    $host.find('a.pvtRowOrder, a.pvtColOrder').each((_i, a) => {
      a.textContent = ORDER_LABELS[$(a).data('order')];
      a.title = 'Cliquer pour changer de tri';
      a.tabIndex = 0;
    });

    // Champs du calcul : libellés et, à défaut, premier champ numérique
    const labels = TCDAggregators.inputLabels(pvt.aggregatorName);
    const numeric = app.fields().filter(f => f.type === 'number').map(f => f.name);
    let filled = false;
    $host.find('td.pvtVals .field-label').remove();
    $host.find('select.pvtAttrDropdown').each((i, sel) => {
      sel.classList.add('input');
      sel.before(el('span', { class: 'field-label' }, labels[i] || 'Champ'));
      if (!sel.value && numeric.length) {
        sel.value = numeric.find(n => !pvt.vals.includes(n)) || numeric[0];
        filled = true;
      }
    });
    if (filled) { app.refreshPivot(); }

    const entries = Object.entries(pvt.exclusions || {}).filter(([, v]) => v && v.length);
    $id('filters-section').hidden = !entries.length;
    $id('active-filters').replaceChildren(...entries.map(([attr, v]) => filterPill(attr, v.length, false)));
    $host.find('.pvtAxisContainer li').each((_i, li) => {
      const ex = (pvt.exclusions || {})[attrOf(li)];
      li.querySelector('.pvtTriangle').dataset.count = ex && ex.length ? ex.length : '';
    });

    const r = app.rendererOf(pvt.rendererName);
    setSegmented($id('renderer-seg'), r.kind);
    $id('heat-scope-field').hidden = r.kind !== 'heat';
    $id('heat-scope').value = r.scope;
    $id('row-totals').checked = s.rowTotals;
    $id('col-totals').checked = s.colTotals;
    $id('subtotals').checked = s.subtotals;
    $id('click-detail').checked = s.clickDetail;
    setSegmented($id('density-seg'), s.density);
    $id('format-hint').textContent = TCDGrist.isAvailable()
      ? 'Les nombres reprennent le format de la colonne dans Grist.'
      : "Les nombres s'affichent au format par défaut de Grist. Pour reprendre le format de la colonne (devise, %, décimales), donnez au widget l'accès complet au document.";
  }

  return { init, adopt, sync, openFilter, filterPill, rendererName, setRenderer, closeFilters: closeFilterBoxes };
})();
