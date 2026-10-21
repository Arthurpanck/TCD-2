/**
 * Panneau de configuration bâti sur pivotUI.
 * pivotUI garde toute la logique (glisser-déposer, filtres, calcul, tri, rendu) ;
 * ce module place ses éléments dans le panneau et les habille : puces typées, menus,
 * fenêtres de filtre positionnées, libellés des calculs et des tris.
 * Les éléments déplacés restent dans l'hôte de pivotUI, qui les retrouve par leurs classes.
 */
const TCDConfig = (function () {
  const { el, $id } = UI;
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
    $id('heat-scope').addEventListener('change', e => setRenderer(TCDRender.nameOf('heat', e.target.value)));
    // Boutons segmentés du DSFR, construits à partir des choix de TCDRender
    $id('renderer-seg').replaceWith(Object.assign(UI.segmented('Mise en forme', TCDRender.STYLES, null,
      v => setRenderer(TCDRender.nameOf(v, $id('heat-scope').value))), { id: 'renderer-seg' }));
    $id('density-seg').replaceWith(Object.assign(UI.segmented('Densité', TCDRender.DENSITIES, null,
      v => app.update({ density: v })), { id: 'density-seg' }));

    $id('table-title').addEventListener('input', e => app.update({ title: e.target.value }));
    const font = step => app.update({ fontScale: +(app.settings().fontScale + step).toFixed(2) });
    $id('font-down').addEventListener('click', () => font(-0.1));
    $id('font-up').addEventListener('click', () => font(0.1));
    $id('swap-axes').addEventListener('click', swapAxes);
    $id('clear-filters').addEventListener('click', () => clearFilter(null));
    $id('field-search').addEventListener('input', filterFieldList);
    $id('cfg-done').addEventListener('click', () => app.closeConfig());
    $id('cfg-revert').addEventListener('click', () => app.revert());

    // Fenêtres de filtre : fermeture par clic à l'extérieur (équivaut à « Annuler ») ; Échap : voir index.js
    document.addEventListener('mousedown', e => {
      if (e.target.closest('.pvtFilterBox, .pvtTriangle, .filter-pill, .sum-filters, .popover')) { return; }
      closeFilterBoxes();
    });
  }

  function setSegmented(root, value) {
    root.querySelectorAll('input[type="radio"]').forEach(r => { r.checked = r.value === value; });
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
    // (habillées hors du document : chaque insertion dans le tableau d'interface coûte un recalcul de style)
    const boxes = unused.children('.pvtFilterBox').detach();
    boxes.each((i, box) => { box.dataset.axis = i; decorateFilterBox(box); });
    $('#filter-layer').append(boxes);

    $('#slot-unused').append(unused.removeClass('pvtVertList pvtHorizList'));
    $('#slot-rows').append(ui.find('td.pvtRows'));
    $('#slot-cols').append(ui.find('td.pvtCols').removeClass('pvtHorizList'));
    // Tris de pivotUI habillés en boutons du DSFR
    const orderClasses = 'fr-btn fr-btn--secondary fr-btn--sm fr-btn--icon-right fr-icon-arrow-up-down-line order-btn';
    $('#slot-row-order').append(ui.find('a.pvtRowOrder').addClass(orderClasses));
    $('#slot-col-order').append(ui.find('a.pvtColOrder').addClass(orderClasses));
    // Le DSFR présente un lien sans href comme désactivé : on lui en donne un, sans navigation
    host.find('a.order-btn').attr('href', '#').on('click', e => e.preventDefault());
    host.find('a.order-btn').on('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } });
    $('#slot-vals').append(ui.find('td.pvtVals'));
    $('#slot-renderer').append(ui.find('select.pvtRenderer').closest('td'));
    // Le tableau rendu s'inscrit dans la structure du tableau DSFR (fr-table__content)
    $('#table-scroll').append(ui.find('td.pvtRendererArea').addClass('fr-table__content'));
    ui.remove();

    host.find('td.pvtVals br').remove();
    const agg = host.find('select.pvtAggregator').attr('id', 'agg-select');
    agg.before(el('label', { class: 'fr-label', for: 'agg-select' }, 'Calcul'));
    groupAggregators(agg);

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
    select.empty().append(groups, known.size ? others : []).val(current).addClass('fr-select');
  }

  /** Type du champ : badge du DSFR, une couleur par type */
  function typeBadge(field) {
    const type = field ? field.type : 'text';
    const [color, title, text] = type === 'number' ? ['green-emeraude', 'Nombre', '#']
      : type === 'date' ? ['orange-terre-battue', 'Date', 'Date'] : ['purple-glycine', 'Texte', 'Abc'];
    return el('span', { class: `ft fr-badge fr-badge--sm fr-badge--no-icon fr-badge--${color}`, title }, text);
  }

  function decorateChip(li, fields) {
    const attr = attrOf(li);
    const field = fields.get(attr);
    // Tag du DSFR, déplaçable par pivotUI
    li.classList.add('chip', 'fr-tag', 'fr-tag--sm');
    li.dataset.attr = attr;
    if (field && field.parent) { li.classList.add('is-derived'); }
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.title = field && field.parent ? `${field.parent} regroupé par ${attr.split(' › ').pop().toLowerCase()}` : attr;
    li.prepend(typeBadge(field));
    const triangle = li.querySelector('.pvtTriangle');
    triangle.textContent = '';
    triangle.classList.add('fr-icon-filter-line', 'fr-icon--xs');
    triangle.title = 'Filtrer les valeurs';
    triangle.addEventListener('click', placeFilterBox);
    li.append(el('button', {
      type: 'button', class: 'chip-btn chip-remove fr-icon-close-line fr-icon--xs', title: 'Retirer', 'aria-label': `Retirer ${attr}`,
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
    if (zone !== 'rows') { items.push({ icon: 'fr-icon-layout-row-line', label: zone === 'cols' ? 'Déplacer vers les lignes' : 'Ajouter aux lignes', onClick: () => moveTo(attr, 'rows') }); }
    if (zone !== 'cols') { items.push({ icon: 'fr-icon-layout-column-line', label: zone === 'rows' ? 'Déplacer vers les colonnes' : 'Ajouter aux colonnes', onClick: () => moveTo(attr, 'cols') }); }
    items.push({ icon: 'fr-icon-filter-line', label: 'Filtrer les valeurs…', onClick: () => openFilter(attr, anchor) });
    if (zone !== 'unused') { items.push('sep', { icon: 'fr-icon-close-line', label: 'Retirer du tableau', danger: true, onClick: () => moveTo(attr, 'unused') }); }
    UI.openPopover(anchor, UI.menu(items, attr));
  }

  // ---------------------------------------------------------------------------
  // Fenêtres de filtre de pivotUI
  // ---------------------------------------------------------------------------

  /** Fenêtre de filtre de pivotUI habillée avec les champs et boutons du DSFR */
  function decorateFilterBox(box) {
    box.querySelectorAll('input.pvtSearch').forEach(i => {
      i.type = 'search';
      i.classList.add('fr-input');
      i.setAttribute('aria-label', 'Rechercher une valeur');
    });
    box.querySelectorAll('p:not(:last-child) button').forEach(b => b.classList.add('fr-btn', 'fr-btn--tertiary-no-outline', 'fr-btn--sm'));
    const final = box.querySelectorAll(':scope > p:last-child button');
    final.forEach((b, i) => b.classList.add('fr-btn', 'fr-btn--sm', ...(i === 0 && final.length > 1 ? [] : ['fr-btn--secondary'])));
    box.querySelectorAll('span.count').forEach(s => { s.textContent = s.textContent.replace(/[()]/g, ''); });
    // Trop de valeurs : pivotUI n'a pas construit la liste, on propose de la construire
    if (!box.querySelector('.pvtCheckContainer')) {
      const attr = box.querySelector('h4 > span').textContent;
      box.querySelector('h4').after(el('p', { class: 'fp-many' },
        'Ce champ a beaucoup de valeurs : leur liste n’est construite qu’à la demande.',
        el('button', { type: 'button', class: 'fr-btn fr-btn--secondary fr-btn--sm', onclick: () => app.showAllFilterValues(attr) }, 'Afficher toutes les valeurs')));
      box.querySelectorAll(':scope > p:not(.fp-many)').forEach(p => { if (!p.querySelector('button')) { p.remove(); } });
    }
  }

  let checkboxSeq = 0;
  /**
   * Liste des valeurs en cases à cocher du DSFR (case avant son libellé), avec « seulement » qui ne
   * garde que cette valeur en marquant les cases modifiées comme le fait pivotUI. Faite à la première
   * ouverture : à la construction, chaque insertion dans ces listes est très lente.
   * La recherche de pivotUI masque toujours le parent du libellé, désormais le groupe DSFR.
   */
  function decorateValueList(box) {
    if (box.dataset.decorated) { return; }
    box.dataset.decorated = '1';
    const inputs = [...box.querySelectorAll('input.pvtFilter')];
    box.querySelectorAll('.pvtCheckContainer > p > label').forEach(label => {
      const input = label.querySelector('input.pvtFilter');
      const group = el('div', { class: 'fr-checkbox-group fr-checkbox-group--sm' + (label.querySelector('.value').textContent === TCDData.EMPTY ? ' is-empty' : '') });
      input.id = 'pvt-value-' + (++checkboxSeq);
      label.className = 'fr-label';
      label.htmlFor = input.id;
      label.parentNode.replaceChild(group, label);
      group.append(input, label, el('button', {
        type: 'button', class: 'fp-only fr-btn fr-btn--tertiary-no-outline fr-btn--sm', title: 'Ne garder que cette valeur',
        onclick: e => {
          e.preventDefault();
          inputs.forEach(i => { if (i.checked !== (i === input)) { i.checked = i === input; $(i).toggleClass('changed'); } });
        },
      }, 'seulement'));
    });
  }

  const openBox = () => [...document.querySelectorAll('#filter-layer .pvtFilterBox')].find(b => b.style.display !== 'none');

  /** Ferme la fenêtre de filtre ouverte (« Annuler » de pivotUI) ; indique s'il y en avait une */
  function closeFilterBoxes() {
    const box = openBox();
    if (box) { $(box).children('p').last().find('button').last().trigger('click'); }
    return Boolean(box);
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
    decorateValueList(box);
    const anchor = visible(pendingAnchor) ? pendingAnchor : e.currentTarget;
    pendingAnchor = null;
    document.querySelectorAll('#filter-layer .pvtFilterBox').forEach(b => { if (b !== box) { b.style.display = 'none'; } });
    UI.placeNear(box, anchor.getBoundingClientRect());
    const search = box.querySelector('input.pvtSearch');
    if (search) { search.focus({ preventScroll: true }); }
  }

  /** Supprime le filtre d'un champ (ou de tous si attr est null) en recochant ses valeurs dans pivotUI */
  function clearFilter(attr) {
    const lis = attr === null ? $host.find('.pvtAxisContainer li') : liOf(attr);
    lis.each((_i, li) => { $(boxOf(li)).find('input.pvtFilter').prop('checked', true); });
    lis.removeClass('pvtFilteredAttribute');
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
    const pill = el('span', { class: 'filter-pill' });
    // Tag du DSFR pour modifier le filtre, bouton icône du DSFR pour le supprimer
    const open = el('button', {
      type: 'button', class: 'filter-pill-main fr-tag fr-tag--sm fr-tag--icon-left fr-icon-filter-line', title: 'Modifier le filtre',
      // Dans une popover, la pastille disparaît à l'ouverture du filtre : on ancre sur le bouton de résumé
      onclick: () => openFilter(attr, compact ? (document.querySelector('.sum-filters') || pill) : pill),
    }, `${attr} · ${count} masquée${count > 1 ? 's' : ''}`);
    const clear = el('button', {
      type: 'button', class: 'filter-pill-clear fr-btn fr-btn--tertiary-no-outline fr-btn--sm fr-icon-close-line', title: 'Supprimer ce filtre',
      onclick: () => { UI.closePopover(); clearFilter(attr); },
    }, 'Supprimer ce filtre');
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
    $host.find('td.pvtVals label.val-label').remove();
    $host.find('select.pvtAttrDropdown').each((i, sel) => {
      sel.classList.add('fr-select');
      sel.id = 'val-select-' + i;
      sel.before(el('label', { class: 'fr-label val-label', for: sel.id }, labels[i] || 'Champ'));
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

    if (document.activeElement !== $id('table-title')) { $id('table-title').value = s.title; }
    const r = TCDRender.kindOf(pvt.rendererName);
    setSegmented($id('renderer-seg'), r.kind);
    $id('heat-scope-field').hidden = r.kind !== 'heat';
    $id('heat-scope').value = r.scope;
    $id('row-totals').checked = s.rowTotals;
    $id('col-totals').checked = s.colTotals;
    $id('subtotals').checked = s.subtotals;
    setSegmented($id('density-seg'), s.density);
    $id('font-value').textContent = Math.round(s.fontScale * 100) + ' %';
    $id('font-down').disabled = s.fontScale <= 0.8;
    $id('font-up').disabled = s.fontScale >= 1.4;
  }

  return { init, adopt, sync, openFilter, filterPill, closeFilters: closeFilterBoxes };
})();
