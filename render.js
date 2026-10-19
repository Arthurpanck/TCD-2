/**
 * Calcul et rendu du tableau croisé : moteur pivottable (PivotData + rendu Table),
 * puis mise en forme (libellés, carte de chaleur, barres, en-têtes figés).
 */
const TCDRender = (function () {
  const { label, EMPTY } = TCDData;

  function buildPivotData(dataset, s) {
    const fmt = TCDAggregators.numberFormatter(s);
    const exclusions = {};
    for (const [attr, values] of Object.entries(s.exclusions || {})) {
      if (values && values.length) { exclusions[attr] = new Set(values.map(String)); }
    }
    const filtered = Object.keys(exclusions);
    let count = 0;
    const filter = rec => {
      for (const a of filtered) { if (exclusions[a].has(String(rec[a]))) { return false; } }
      count++;
      return true;
    };

    const pd = new $.pivotUtilities.PivotData(dataset.records, {
      rows: s.rows,
      cols: s.cols,
      vals: s.vals,
      aggregator: TCDAggregators.build(s.aggregatorName, s.vals, fmt),
      aggregatorName: s.aggregatorName,
      sorters: TCDData.makeSorters(dataset.sortKeys),
      rowOrder: s.rowOrder,
      colOrder: s.colOrder,
      filter,
    });
    // Nombre de lignes retenues par les filtres (le filtre est rappelé ensuite pour le détail)
    pd.tcdRecordCount = count;
    return pd;
  }

  function renderTable(pd, s, aggLabel) {
    const table = $.pivotUtilities.renderers.Table(pd, {
      localeStrings: { totals: 'Total' },
      table: { rowTotals: s.rowTotals, colTotals: s.colTotals },
    });
    decorate(table, pd, aggLabel);
    if (s.renderer === 'heat') { heatmap(table, s.heatScope); }
    if (s.renderer === 'bars') { bars(table); }
    return table;
  }

  function decorate(table, pd, aggLabel) {
    const nRows = pd.rowAttrs.length, nCols = pd.colAttrs.length;
    table.classList.add('tcd-table');
    table.dataset.rowLevels = nRows;

    table.querySelectorAll('th.pvtAxisLabel').forEach(th => {
      th.title = th.textContent;
      th.textContent = label(th.textContent);
    });
    table.querySelectorAll('th.pvtRowLabel, th.pvtColLabel').forEach(th => {
      if (th.textContent === EMPTY) { th.classList.add('is-empty'); }
    });

    const thead = table.tHead;
    // Case en haut à gauche : on y rappelle le calcul affiché
    if (nRows && nCols) {
      const corner = thead.rows[0].cells[0];
      corner.className = 'pvtCorner';
      corner.textContent = aggLabel;
    }
    // Sans champ en colonne, la colonne de valeurs porte le nom du calcul
    if (!nCols) {
      table.querySelectorAll('th.pvtRowTotalLabel').forEach(th => {
        th.textContent = aggLabel;
        th.classList.add('pvtValueHeader');
      });
    }

    for (const tr of table.tBodies[0].rows) {
      const ths = [...tr.cells].filter(c => c.classList.contains('pvtRowLabel'));
      ths.forEach((th, k) => { th.dataset.level = nRows - ths.length + k; });
      if (nRows > 1 && ths.length === nRows) { tr.classList.add('group-start'); }
      if (tr.querySelector('.pvtColTotalLabel')) {
        tr.classList.add('pvtTotalsRow');
        if (!nRows) { tr.querySelector('.pvtColTotalLabel').textContent = nCols ? aggLabel : 'Total'; }
      }
    }
  }

  function heatGroup(cells) {
    let min = Infinity, max = -Infinity;
    const values = cells.map(c => {
      const v = parseFloat(c.getAttribute('data-value'));
      if (isFinite(v)) { min = Math.min(min, v); max = Math.max(max, v); }
      return v;
    });
    const range = max - min;
    cells.forEach((c, i) => {
      const v = values[i];
      if (!isFinite(v)) { return; }
      const t = range ? (v - min) / range : 0.5;
      c.style.setProperty('--heat', t.toFixed(3));
      c.classList.add('is-heat');
      if (t > 0.62) { c.classList.add('is-heat-strong'); }
    });
  }

  /** Cellules de valeurs ; sans champ en colonnes (ou en lignes), ce sont les totaux qui portent les valeurs */
  function valueCells(table) {
    const cells = [...table.querySelectorAll('td.pvtVal')];
    return cells.length ? cells : [...table.querySelectorAll('td.pvtTotal')];
  }

  function heatmap(table, scope) {
    const cells = valueCells(table);
    if (cells.length && !cells[0].classList.contains('pvtVal')) {
      heatGroup(cells);
    } else if (scope === 'row' || scope === 'col') {
      const re = scope === 'row' ? /\brow(\d+)\b/ : /\bcol(\d+)\b/;
      const groups = new Map();
      for (const c of cells) {
        const k = re.exec(c.className)[1];
        if (!groups.has(k)) { groups.set(k, []); }
        groups.get(k).push(c);
      }
      groups.forEach(heatGroup);
    } else {
      heatGroup(cells);
    }
  }

  function bars(table) {
    const cells = valueCells(table);
    const values = cells.map(c => parseFloat(c.getAttribute('data-value')));
    const maxAbs = Math.max(0, ...values.filter(isFinite).map(Math.abs));
    if (!maxAbs) { return; }
    cells.forEach((c, i) => {
      const v = values[i];
      if (!isFinite(v)) { return; }
      c.style.setProperty('--pct', (Math.abs(v) / maxAbs).toFixed(4));
      c.classList.add('has-bar');
      if (v < 0) { c.classList.add('bar-neg'); }
    });
  }

  /** En-têtes figés : calcule les décalages des lignes d'en-tête et des colonnes de libellés */
  function stick(table) {
    const thead = table.tHead;
    if (!thead) { return; }
    let top = 0;
    for (const tr of thead.rows) {
      for (const th of tr.cells) { th.style.top = top + 'px'; }
      top += tr.offsetHeight;
    }
    const nRows = Number(table.dataset.rowLevels) || 0;
    if (!nRows || !thead.rows.length) { return; }
    const labelRow = thead.rows[thead.rows.length - 1];
    const lefts = [];
    let x = 0;
    for (let j = 0; j < nRows; j++) {
      const th = labelRow.cells[j];
      if (!th) { break; }
      lefts[j] = x;
      th.style.left = x + 'px';
      th.classList.add('is-sticky-left');
      x += th.offsetWidth;
    }
    const corner = thead.querySelector('.pvtCorner');
    if (corner) { corner.style.left = '0px'; corner.classList.add('is-sticky-left'); }
    table.querySelectorAll('tbody th.pvtRowLabel').forEach(th => {
      th.style.left = (lefts[th.dataset.level] || 0) + 'px';
    });
    const totalLabel = table.querySelector('th.pvtColTotalLabel');
    if (totalLabel) { totalLabel.style.left = '0px'; totalLabel.classList.add('is-sticky-left'); }
  }

  return { buildPivotData, renderTable, stick };
})();
