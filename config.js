/**
 * Panneau de configuration : champs, zones Lignes/Colonnes (glisser-déposer ou clic),
 * calcul, filtres, affichage et format des nombres.
 * Communique avec l'application via l'objet `app` fourni à init().
 */
const TCDConfig = (function () {
  const { el } = UI;
  const { label } = TCDData;
  const $id = id => document.getElementById(id);
  let app = null;
  let dragging = false;

  const ORDERS = [
    ['key_a_to_z', 'Par libellé (A → Z)'],
    ['value_z_to_a', 'Par valeur décroissante'],
    ['value_a_to_z', 'Par valeur croissante'],
  ];

  const ACCENTS = [
    ['bleu', 'Bleu', '#3157d5'],
    ['marine', 'Bleu France', '#000091'],
    ['vert', 'Vert', '#16855c'],
    ['petrole', 'Bleu canard', '#0e7490'],
    ['violet', 'Violet', '#6d4bd8'],
    ['orange', 'Orange', '#c2570c'],
    ['ardoise', 'Ardoise', '#475569'],
  ];

  function init(api) {
    app = api;

    const agg = $id('agg-select');
    for (const [group, names] of TCDAggregators.GROUPS) {
      const og = el('optgroup', { label: group });
      for (const name of names) { og.append(el('option', { value: name }, TCDAggregators.LABELS[name] || name)); }
      agg.append(og);
    }
    agg.addEventListener('change', () => {
      const name = agg.value;
      app.update({ aggregatorName: name, vals: fitVals(app.settings().vals, TCDAggregators.numInputs(name)) });
    });

    document.querySelectorAll('.order-select').forEach(sel => {
      for (const [v, l] of ORDERS) { sel.append(el('option', { value: v }, l)); }
    });
    $id('row-order').addEventListener('change', e => app.update({ rowOrder: e.target.value }));
    $id('col-order').addEventListener('change', e => app.update({ colOrder: e.target.value }));
    $id('row-totals').addEventListener('change', e => app.update({ rowTotals: e.target.checked }));
    $id('col-totals').addEventListener('change', e => app.update({ colTotals: e.target.checked }));
    $id('subtotals').addEventListener('change', e => app.update({ subtotals: e.target.checked }));
    $id('heat-scope').addEventListener('change', e => app.update({ rendererName: rendererName('heat', e.target.value) }));
    $id('decimals').addEventListener('change', e => app.update({ decimals: e.target.value }));
    $id('scale').addEventListener('change', e => app.update({ scale: Number(e.target.value) }));
    $id('suffix').addEventListener('input', e => app.update({ suffix: e.target.value.trim() }));

    segmented($id('renderer-seg'), v => app.update({ rendererName: rendererName(v, $id('heat-scope').value) }));
    segmented($id('density-seg'), v => app.update({ density: v }));

    const sw = $id('accent-swatches');
    for (const [id, name, color] of ACCENTS) {
      sw.append(el('button', {
        type: 'button', role: 'radio', class: 'swatch', title: name, 'aria-label': name,
        dataset: { value: id }, style: `--swatch:${color}`,
        onclick: () => app.update({ accent: id }),
      }));
    }

    $id('swap-axes').innerHTML = Icons.svg('swap', 15);
    $id('swap-axes').addEventListener('click', () => {
      const s = app.settings();
      app.update({ rows: s.cols, cols: s.rows, rowOrder: s.colOrder, colOrder: s.rowOrder });
    });
    $id('clear-filters').addEventListener('click', () => app.update({ exclusions: {} }));
    $id('field-search').addEventListener('input', filterFieldList);
    $id('cfg-done').addEventListener('click', () => app.closeConfig());
    $id('cfg-revert').addEventListener('click', () => app.revert());

    $('#zone-unused, #zone-rows, #zone-cols').sortable({
      connectWith: '.zone',
      items: '> li.chip',
      placeholder: 'chip-placeholder',
      tolerance: 'pointer',
      distance: 4,
      cursor: 'grabbing',
      start(_e, ui) {
        dragging = true;
        document.body.classList.add('is-dragging');
        ui.placeholder.css({ width: ui.item.outerWidth(), height: ui.item.outerHeight() });
        UI.closePopover();
      },
      over() { $(this).addClass('is-over'); },
      out() { $(this).removeClass('is-over'); },
      stop() {
        dragging = false;
        document.body.classList.remove('is-dragging');
        $('.zone').removeClass('is-over');
        readZones();
      },
    });
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

  /** Nom pivottable (français) du rendu, conservé pour la compatibilité des réglages */
  function rendererName(kind, scope) {
    if (kind === 'heat') {
      return { row: 'Carte de chaleur par ligne', col: 'Carte de chaleur par colonne' }[scope] || 'Carte de chaleur';
    }
    return kind === 'bars' ? 'Table avec barres' : 'Table';
  }

  function fitVals(vals, n) {
    const fields = app.fields();
    const numeric = fields.filter(f => f.type === 'number').map(f => f.name);
    const out = (vals || []).slice(0, n);
    while (out.length < n) {
      out.push(numeric.find(f => !out.includes(f)) || numeric[0] || (fields[0] && fields[0].name));
    }
    return out;
  }

  function readZones() {
    const read = id => $(`#${id} > li.chip`).map((_i, li) => li.dataset.attr).get();
    const rows = read('zone-rows'), cols = read('zone-cols');
    const s = app.settings();
    if (rows.join('\0') !== s.rows.join('\0') || cols.join('\0') !== s.cols.join('\0')) {
      app.update({ rows, cols });
    } else {
      refresh();
    }
  }

  function moveTo(attr, zone) {
    const s = app.settings();
    const rows = s.rows.filter(a => a !== attr), cols = s.cols.filter(a => a !== attr);
    if (zone === 'rows') { rows.push(attr); }
    if (zone === 'cols') { cols.push(attr); }
    app.update({ rows, cols });
  }

  function typeBadge(field) {
    if (field.type === 'number') { return el('span', { class: 'ft ft-number', title: 'Nombre' }, '#'); }
    if (field.type === 'date') { return el('span', { class: 'ft ft-date', title: 'Date', html: Icons.svg('calendar', 11) }); }
    return el('span', { class: 'ft ft-text', title: 'Texte' }, 'Aa');
  }

  function chip(field, zone) {
    const s = app.settings();
    const excluded = (s.exclusions[field.name] || []).length;
    const name = field.parent
      ? [el('span', { class: 'chip-parent' }, label(field.parent) + ' ›'), ' ', field.name.split(' › ').pop()]
      : [label(field.name)];
    const li = el('li', {
      class: `chip chip-${zone}` + (field.parent ? ' is-derived' : ''),
      tabindex: 0, role: 'button', 'aria-haspopup': 'true',
      dataset: { attr: field.name },
      title: field.parent ? `${label(field.parent)} regroupé par ${field.name.split(' › ').pop().toLowerCase()}` : label(field.name),
    }, typeBadge(field), el('span', { class: 'chip-label' }, ...name));

    if (excluded) {
      li.append(el('button', {
        type: 'button', class: 'chip-btn chip-filter is-active',
        title: `Filtre actif : ${excluded} valeur(s) masquée(s)`,
        html: Icons.svg('filter', 12) + `<span>${excluded}</span>`,
        onclick: e => { e.stopPropagation(); openFilter(field.name, li); },
      }));
    }
    if (zone !== 'unused') {
      li.append(el('button', {
        type: 'button', class: 'chip-btn chip-remove', title: 'Retirer', 'aria-label': `Retirer ${label(field.name)}`,
        html: Icons.svg('x', 12),
        onclick: e => { e.stopPropagation(); moveTo(field.name, 'unused'); },
      }));
    }
    li.addEventListener('click', () => { if (!dragging) { openChipMenu(field.name, zone, li); } });
    li.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openChipMenu(field.name, zone, li); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && zone !== 'unused') { moveTo(field.name, 'unused'); }
    });
    return li;
  }

  function openChipMenu(attr, zone, anchor) {
    if (UI.isOpenFor(anchor)) { UI.closePopover(); return; }
    const items = [];
    if (zone !== 'rows') { items.push({ icon: 'rows', label: zone === 'cols' ? 'Déplacer vers les lignes' : 'Ajouter aux lignes', onClick: () => moveTo(attr, 'rows') }); }
    if (zone !== 'cols') { items.push({ icon: 'cols', label: zone === 'rows' ? 'Déplacer vers les colonnes' : 'Ajouter aux colonnes', onClick: () => moveTo(attr, 'cols') }); }
    items.push({ icon: 'filter', label: 'Filtrer les valeurs…', onClick: () => openFilter(attr, anchor) });
    if (zone !== 'unused') { items.push('sep', { icon: 'x', label: 'Retirer du tableau', danger: true, onClick: () => moveTo(attr, 'unused') }); }
    UI.openPopover(anchor, UI.menu(items, label(attr)));
  }

  /** Fenêtre de filtre façon tableur : recherche, tout/aucun, « seulement », comptes */
  function openFilter(attr, anchor) {
    const ds = app.dataset();
    const sorter = TCDData.makeSorters(ds.sortKeys)(attr);
    const counts = TCDData.valueCounts(ds.records, attr, sorter);
    const excluded = new Set((app.settings().exclusions[attr] || []).map(String));
    const LIMIT = 500;

    const search = el('input', { type: 'search', class: 'input', placeholder: 'Rechercher une valeur…' });
    const list = el('div', { class: 'fp-list' });
    const status = el('span', { class: 'muted' });
    const apply = el('button', { type: 'button', class: 'btn btn-primary' }, 'Appliquer');

    const visible = () => {
      const q = search.value.trim().toLocaleLowerCase('fr');
      return q ? counts.filter(([v]) => String(v).toLocaleLowerCase('fr').includes(q)) : counts;
    };
    const updateStatus = () => {
      const shown = counts.length - counts.filter(([v]) => excluded.has(String(v))).length;
      status.textContent = `${shown} / ${counts.length} sélectionnée(s)`;
      apply.disabled = shown === 0;
    };
    const draw = () => {
      const items = visible();
      list.replaceChildren(...items.slice(0, LIMIT).map(([value, n]) => {
        const key = String(value);
        const cb = el('input', { type: 'checkbox' });
        cb.checked = !excluded.has(key);
        cb.addEventListener('change', () => { cb.checked ? excluded.delete(key) : excluded.add(key); updateStatus(); });
        const only = el('button', {
          type: 'button', class: 'fp-only', title: 'Ne garder que cette valeur',
          onclick: e => {
            e.preventDefault();
            counts.forEach(([v]) => excluded.add(String(v)));
            excluded.delete(key);
            draw();
          },
        }, 'seulement');
        return el('label', { class: 'fp-item' + (value === TCDData.EMPTY ? ' is-empty' : '') },
          cb, el('span', { class: 'fp-value' }, key), only, el('span', { class: 'fp-count' }, n.toLocaleString('fr-FR')));
      }));
      if (items.length > LIMIT) {
        list.append(el('div', { class: 'fp-more' }, `… et ${items.length - LIMIT} autres valeurs : affinez la recherche.`));
      }
      if (!items.length) { list.append(el('div', { class: 'fp-more' }, 'Aucune valeur ne correspond.')); }
      updateStatus();
    };
    search.addEventListener('input', draw);

    const bulk = (keep) => () => { visible().forEach(([v]) => (keep ? excluded.delete(String(v)) : excluded.add(String(v)))); draw(); };
    apply.addEventListener('click', () => {
      const ex = { ...app.settings().exclusions };
      if (excluded.size) { ex[attr] = [...excluded]; } else { delete ex[attr]; }
      UI.closePopover();
      app.update({ exclusions: ex });
    });

    const root = el('div', { class: 'filter-pop' },
      el('div', { class: 'fp-head' }, el('strong', {}, label(attr)), status),
      search,
      el('div', { class: 'fp-bulk' },
        el('button', { type: 'button', class: 'link-btn', onclick: bulk(true) }, 'Tout cocher'),
        el('button', { type: 'button', class: 'link-btn', onclick: bulk(false) }, 'Tout décocher')),
      list,
      el('div', { class: 'fp-foot' },
        el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => UI.closePopover() }, 'Annuler'),
        apply));
    draw();
    UI.openPopover(anchor, root, { className: 'is-filter' });
  }

  function filterFieldList() {
    const q = $id('field-search').value.trim().toLocaleLowerCase('fr');
    document.querySelectorAll('#zone-unused > li.chip').forEach(li => {
      li.hidden = q && !label(li.dataset.attr).toLocaleLowerCase('fr').includes(q);
    });
  }

  function renderValInputs(s) {
    const box = $id('val-inputs');
    const labels = TCDAggregators.inputLabels(s.aggregatorName);
    const fields = app.fields();
    const numeric = fields.filter(f => f.type === 'number');
    const others = fields.filter(f => f.type !== 'number');
    box.replaceChildren(...labels.map((lab, i) => {
      const sel = el('select', { class: 'input' },
        numeric.length ? el('optgroup', { label: 'Champs numériques' }, numeric.map(f => el('option', { value: f.name }, label(f.name)))) : null,
        others.length ? el('optgroup', { label: 'Autres champs' }, others.map(f => el('option', { value: f.name }, label(f.name)))) : null);
      sel.value = s.vals[i] || '';
      sel.addEventListener('change', () => {
        const vals = s.vals.slice();
        vals[i] = sel.value;
        app.update({ vals });
      });
      return el('label', { class: 'field' }, el('span', { class: 'field-label' }, lab), sel);
    }));
  }

  function renderActiveFilters(s) {
    const box = $id('active-filters');
    const entries = Object.entries(s.exclusions).filter(([, v]) => v && v.length);
    $id('filters-section').hidden = !entries.length;
    box.replaceChildren(...entries.map(([attr, values]) => filterPill(attr, values, false)));
  }

  /** Pastille de filtre actif (réutilisée dans la barre de consultation) */
  function filterPill(attr, values, compact) {
    const pill = el('span', { class: 'filter-pill' + (compact ? ' is-compact' : '') });
    const open = el('button', {
      type: 'button', class: 'filter-pill-main', title: 'Modifier le filtre',
      html: Icons.svg('filter', 12) + '<span></span>',
      onclick: () => openFilter(attr, pill),
    });
    open.querySelector('span').textContent = `${label(attr)} · ${values.length} masquée${values.length > 1 ? 's' : ''}`;
    const clear = el('button', {
      type: 'button', class: 'filter-pill-clear', title: 'Supprimer ce filtre', html: Icons.svg('x', 12),
      onclick: () => { const ex = { ...app.settings().exclusions }; delete ex[attr]; app.update({ exclusions: ex }); },
    });
    pill.append(open, clear);
    return pill;
  }

  function refresh() {
    if (!app || dragging) { return; }
    const s = app.settings();
    const fields = app.fields();
    const byName = new Map(fields.map(f => [f.name, f]));
    const used = new Set([...s.rows, ...s.cols]);
    const asField = name => byName.get(name) || { name, type: 'text' };

    $id('zone-rows').replaceChildren(...s.rows.map(n => chip(asField(n), 'rows')));
    $id('zone-cols').replaceChildren(...s.cols.map(n => chip(asField(n), 'cols')));
    $id('zone-unused').replaceChildren(...fields.filter(f => !used.has(f.name)).map(f => chip(f, 'unused')));
    $id('field-count').textContent = `${fields.filter(f => !f.parent).length} champs`;
    filterFieldList();

    $id('agg-select').value = s.aggregatorName;
    renderValInputs(s);
    renderActiveFilters(s);

    const r = app.rendererOf(s.rendererName);
    setSegmented($id('renderer-seg'), r.kind);
    $id('heat-scope-field').hidden = r.kind !== 'heat';
    $id('heat-scope').value = r.scope;
    $id('row-order').value = s.rowOrder;
    $id('col-order').value = s.colOrder;
    $id('row-totals').checked = s.rowTotals;
    $id('col-totals').checked = s.colTotals;
    $id('subtotals').checked = s.subtotals;
    $id('decimals').value = String(s.decimals);
    $id('scale').value = String(s.scale);
    if (document.activeElement !== $id('suffix')) { $id('suffix').value = s.suffix; }
    $id('format-preview').textContent = 'Aperçu : ' + TCDAggregators.numberFormatter(s)(1234567.891);
    setSegmented($id('density-seg'), s.density);
    $id('accent-swatches').querySelectorAll('.swatch').forEach(b => {
      const on = b.dataset.value === s.accent;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-checked', on);
    });
  }

  function accentColor(id) {
    return (ACCENTS.find(a => a[0] === id) || ACCENTS[0])[2];
  }

  return { init, refresh, openFilter, filterPill, rendererName, accentColor, ACCENTS };
})();
