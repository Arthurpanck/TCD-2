/**
 * Calcul et rendu du tableau croisé.
 * Le calcul utilise le moteur pivottable (PivotData) ; le tableau est construit ici pour
 * proposer des sous-totaux repliables, un en-tête compact et des cellules annotées
 * (info-bulle, détail, carte de chaleur, barres).
 */
const TCDRender = (function () {
  const { label, EMPTY } = TCDData;
  const SEP = '\u0000';
  const DEFAULT_ROW_LIMIT = 1500;

  function buildPivotData(dataset, s, rows = s.rows) {
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
      rows,
      cols: s.cols,
      vals: s.vals,
      aggregator: TCDAggregators.build(s.aggregatorName, s.vals),
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

  const groupKey = (key, level) => key.slice(0, level + 1).join(SEP);

  function compareValues(a, b) {
    const fa = typeof a === 'number' && isFinite(a), fb = typeof b === 'number' && isFinite(b);
    if (fa && fb) { return a - b; }
    if (fa) { return -1; }
    if (fb) { return 1; }
    return 0;
  }

  /** Tri par valeur qui garde les groupes ensemble (chaque niveau est trié selon son sous-total) */
  function sortByGroupValue(rowKeys, n, levelValue, desc) {
    const dir = desc ? -1 : 1;
    return rowKeys.slice().sort((a, b) => {
      for (let L = 0; L < n; L++) {
        if (a[L] === b[L]) { continue; }
        const c = compareValues(levelValue(a, L), levelValue(b, L));
        return c ? dir * c : 0;
      }
      return 0;
    });
  }

  /**
   * Liste des lignes affichées : lignes de données et lignes de sous-total,
   * en tenant compte des groupes repliés.
   */
  function displayRows(rowKeys, n, withSubtotals, collapsed) {
    const rows = [];
    for (let i = 0; i < rowKeys.length; i++) {
      const key = rowKeys[i], next = rowKeys[i + 1];
      let folded = -1;
      if (withSubtotals) {
        for (let L = 0; L < n - 1; L++) {
          if (collapsed.has(groupKey(key, L))) { folded = L; break; }
        }
      }
      if (folded === -1) { rows.push({ type: 'data', key, index: i }); }
      if (!withSubtotals) { continue; }
      let same = 0;
      if (next) { while (same < n && next[same] === key[same]) { same++; } }
      for (let L = n - 2; L >= 0; L--) {
        const groupEnds = !next || same <= L;
        if (!groupEnds || (folded !== -1 && folded < L)) { continue; }
        rows.push({ type: 'sub', level: L, key: key.slice(0, L + 1), collapsed: folded === L });
      }
    }
    return rows;
  }

  /** Une ligne affichée porte-t-elle un libellé au niveau `level` (fusionné verticalement) ? */
  const hasLevel = (row, level) => row.type === 'data' || level < row.level;

  function th(cls, text, attrs) {
    const node = document.createElement('th');
    if (cls) { node.className = cls; }
    if (text !== undefined && text !== null) { node.textContent = text; }
    for (const [k, v] of Object.entries(attrs || {})) { if (v !== undefined) { node.setAttribute(k, v); } }
    return node;
  }

  function valueCell(cls, agg, info, rowKey, colKey) {
    const td = document.createElement('td');
    td.className = cls;
    const v = agg.value();
    td.textContent = agg.format(v);
    td.setAttribute('data-value', v);
    info.set(td, { rowKey, colKey, agg });
    return td;
  }

  /**
   * @param {Object} dataset - données préparées (TCDData.prepare)
   * @param {Object} s - réglages effectifs
   * @param {string} aggLabel - description du calcul
   * @param {{collapsed: Set<string>, rowLimit: number}} view - état d'affichage non enregistré
   */
  function render(dataset, s, aggLabel, view) {
    const pd = buildPivotData(dataset, s);
    const rowAttrs = pd.rowAttrs, colAttrs = pd.colAttrs;
    const n = rowAttrs.length, m = colAttrs.length;
    const colKeys = m ? pd.getColKeys() : [[]];
    let rowKeys = n ? pd.getRowKeys() : [];
    const showRowTotal = s.rowTotals && m > 0;
    const showColTotal = s.colTotals || n === 0;
    const withSubtotals = s.subtotals && n > 1;
    const valueSort = s.rowOrder !== 'key_a_to_z';

    // Tableaux intermédiaires pour les sous-totaux (et le tri par valeur qui respecte les groupes)
    const levelPd = [];
    if (n > 1 && (withSubtotals || valueSort)) {
      for (let L = 0; L < n - 1; L++) { levelPd[L] = buildPivotData(dataset, s, s.rows.slice(0, L + 1)); }
    }
    if (n > 1 && valueSort) {
      const levelValue = (key, L) => (L === n - 1 ? pd : levelPd[L]).getAggregator(key.slice(0, L + 1), []).value();
      rowKeys = sortByGroupValue(rowKeys, n, levelValue, s.rowOrder === 'value_z_to_a');
    }

    const info = new WeakMap();
    const table = document.createElement('table');
    table.className = 'pvtTable tcd-table';
    table.dataset.rowLevels = n;
    const labelCols = Math.max(n, 1);

    // ---- En-tête
    const thead = table.createTHead();
    if (m) {
      for (let j = 0; j < m; j++) {
        const tr = thead.insertRow();
        const axis = th('pvtAxisLabel pvtColAxis', null, { colspan: labelCols });
        if (j === 0 && n) { axis.append(Object.assign(document.createElement('span'), { className: 'corner-agg', textContent: aggLabel })); }
        axis.append(Object.assign(document.createElement('span'), { className: 'axis-name', textContent: label(colAttrs[j]) + ' →', title: colAttrs[j] }));
        tr.append(axis);
        for (let c = 0; c < colKeys.length; c++) {
          if (c > 0 && colKeys[c].slice(0, j + 1).join(SEP) === colKeys[c - 1].slice(0, j + 1).join(SEP)) { continue; }
          let span = 1;
          while (c + span < colKeys.length && colKeys[c + span].slice(0, j + 1).join(SEP) === colKeys[c].slice(0, j + 1).join(SEP)) { span++; }
          const text = colKeys[c][j];
          tr.append(th('pvtColLabel' + (text === EMPTY ? ' is-empty' : '') + (j < m - 1 ? ' is-group' : ''), text,
            { colspan: span > 1 ? span : undefined, rowspan: j === m - 1 && n ? 2 : undefined }));
        }
        if (j === 0 && showRowTotal) {
          tr.append(th('pvtTotalLabel pvtRowTotalLabel', 'Total', { rowspan: m + (n ? 1 : 0) }));
        }
      }
      if (n) {
        const tr = thead.insertRow();
        rowAttrs.forEach(a => tr.append(th('pvtAxisLabel pvtRowAxis', label(a), { title: a })));
      }
    } else {
      const tr = thead.insertRow();
      if (n) { rowAttrs.forEach(a => tr.append(th('pvtAxisLabel pvtRowAxis', label(a), { title: a }))); }
      else { tr.append(th('pvtAxisLabel')); }
      tr.append(th('pvtTotalLabel pvtValueHeader', aggLabel));
    }

    // ---- Corps
    const tbody = table.createTBody();
    const rows = displayRows(rowKeys, n, withSubtotals, view.collapsed);
    const limit = view.rowLimit || DEFAULT_ROW_LIMIT;
    const shown = Math.min(rows.length, limit);
    for (let d = 0; d < shown; d++) {
      const row = rows[d], prev = rows[d - 1];
      const tr = tbody.insertRow();
      tr.className = row.type === 'sub' ? `pvtSubtotalRow level-${row.level}` + (row.collapsed ? ' is-collapsed' : '') : 'pvtDataRow';

      const lastLevel = row.type === 'data' ? n : row.level;
      for (let L = 0; L < lastLevel; L++) {
        const starts = !prev || !hasLevel(prev, L) || groupKey(prev.key, L) !== groupKey(row.key, L);
        if (!starts) { continue; }
        let span = 1;
        while (d + span < shown && hasLevel(rows[d + span], L) && groupKey(rows[d + span].key, L) === groupKey(row.key, L)) { span++; }
        const text = row.key[L];
        const cell = th('pvtRowLabel' + (text === EMPTY ? ' is-empty' : ''), null, {
          rowspan: span, 'data-level': L, title: String(text).length > 28 ? text : undefined,
        });
        if (withSubtotals && L < n - 1) {
          cell.append(toggleButton(groupKey(row.key, L), false));
        }
        cell.append(text);
        tr.append(cell);
        if (L === 0 && d > 0 && n > 1) { tr.classList.add('group-start'); }
      }

      if (row.type === 'data') {
        colKeys.forEach((ck, j) => {
          const td = valueCell('pvtVal', pd.getAggregator(row.key, ck), info, row.key, ck);
          td.dataset.row = row.index;
          td.dataset.col = j;
          tr.append(td);
        });
        if (showRowTotal) { tr.append(valueCell('pvtTotal rowTotal', pd.getAggregator(row.key, []), info, row.key, [])); }
      } else {
        const lpd = levelPd[row.level];
        const text = row.key[row.level];
        const cell = th('pvtRowLabel pvtSubtotalLabel', null, { colspan: n - row.level, 'data-level': row.level });
        cell.append(toggleButton(groupKey(row.key, row.level), row.collapsed));
        cell.append(row.collapsed ? text : `Total ${text}`);
        if (text === EMPTY) { cell.classList.add('is-empty'); }
        tr.append(cell);
        if (row.collapsed && row.level === 0 && d > 0) { tr.classList.add('group-start'); }
        colKeys.forEach((ck, j) => {
          const td = valueCell('pvtSubtotal', lpd.getAggregator(row.key, ck), info, row.key, ck);
          td.dataset.col = j;
          tr.append(td);
        });
        if (showRowTotal) { tr.append(valueCell('pvtSubtotal rowTotal', lpd.getAggregator(row.key, []), info, row.key, [])); }
      }
    }

    if (rows.length > shown) {
      const tr = tbody.insertRow();
      tr.className = 'pvtMoreRow';
      const td = tr.insertCell();
      td.colSpan = labelCols + colKeys.length + (showRowTotal ? 1 : 0);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-ghost show-more';
      btn.dataset.action = 'show-all';
      btn.textContent = `Afficher les ${(rows.length - shown).toLocaleString('fr-FR')} lignes restantes`;
      td.append(btn);
    }

    if (showColTotal) {
      const tr = tbody.insertRow();
      tr.className = 'pvtTotalsRow';
      tr.append(th('pvtTotalLabel pvtColTotalLabel', n ? 'Total' : aggLabel, { colspan: labelCols }));
      colKeys.forEach((ck, j) => {
        const isGrand = !m;
        const td = valueCell(isGrand ? 'pvtGrandTotal' : 'pvtTotal colTotal', pd.getAggregator([], ck), info, [], ck);
        td.dataset.col = j;
        tr.append(td);
      });
      if (showRowTotal) { tr.append(valueCell('pvtGrandTotal', pd.getAggregator([], []), info, [], [])); }
    }

    if (rows.length * colKeys.length > 3000) { table.classList.add('is-large'); }
    if (s.renderer === 'heat') { heatmap(table, m ? s.heatScope : 'all'); }
    if (s.renderer === 'bars') { bars(table); }
    return { table, pd, info, rowCount: rows.length };
  }

  function toggleButton(key, collapsed) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'grp-toggle';
    b.dataset.group = key;
    b.setAttribute('aria-expanded', String(!collapsed));
    b.title = collapsed ? 'Déplier le groupe' : 'Replier le groupe';
    return b;
  }

  /** Couleurs du thème courant, lues une fois par rendu (rgb) */
  function themeRgb(name) {
    const probe = document.createElement('span');
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const m = getComputedStyle(probe).color.match(/[\d.]+/g) || [0, 0, 0];
    probe.remove();
    return m.slice(0, 3).map(Number);
  }

  function heatGroup(cells, palette) {
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
      // Mélange surface → accent calculé ici : bien plus rapide qu'un color-mix() CSS par cellule
      const p = t * 0.78 + 0.04;
      const rgb = palette.surface.map((x, k) => Math.round(x + (palette.accent[k] - x) * p));
      c.style.backgroundColor = `rgb(${rgb.join(',')})`;
      c.classList.add('is-heat');
      if (t > 0.62) { c.classList.add('is-heat-strong'); }
    });
  }

  /** Cellules de valeurs ; sans champ en lignes, ce sont les totaux de colonnes qui portent les valeurs */
  function valueCells(table) {
    const cells = [...table.querySelectorAll('td.pvtVal')];
    return cells.length ? cells : [...table.querySelectorAll('td.colTotal')];
  }

  function heatmap(table, scope) {
    const cells = valueCells(table);
    const palette = { surface: themeRgb('--surface'), accent: themeRgb('--accent-base') };
    const heat = group => heatGroup(group, palette);
    if (scope === 'row' || scope === 'col') {
      const groups = new Map();
      for (const c of cells) {
        const k = c.dataset[scope];
        if (!groups.has(k)) { groups.set(k, []); }
        groups.get(k).push(c);
      }
      groups.forEach(heat);
    } else {
      heat(cells);
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

  /**
   * En-têtes figés : calcule les décalages des lignes d'en-tête et des colonnes de libellés.
   * Toutes les mesures sont lues avant d'écrire les styles, pour ne provoquer qu'un seul calcul de mise en page.
   */
  function stick(table) {
    const thead = table.tHead;
    if (!thead) { return; }
    const heights = [...thead.rows].map(tr => tr.offsetHeight);
    const axisCells = [...table.querySelectorAll('thead th.pvtRowAxis')];
    const widths = axisCells.map(cell => cell.offsetWidth);

    const lefts = [];
    widths.reduce((x, w, j) => { lefts[j] = x; return x + w; }, 0);
    let top = 0;
    [...thead.rows].forEach((tr, i) => {
      const value = top + 'px';
      for (const cell of tr.cells) { cell.style.top = value; }
      top += heights[i];
    });
    axisCells.forEach((cell, j) => { cell.style.left = lefts[j] + 'px'; });
    // Les libellés de lignes reçoivent leur décalage via une variable CSS par niveau
    lefts.forEach((x, j) => table.style.setProperty(`--left-${j}`, x + 'px'));
  }

  return { buildPivotData, render, stick };
})();
