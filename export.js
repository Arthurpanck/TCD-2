/**
 * Export du tableau croisé : copie et CSV (données brutes), classeur Excel mis en forme.
 * Tous les exports partent du même modèle, calculé avec les données de pivottable
 * (PivotData de subtotal.js), dans l'ordre et avec les réglages affichés à l'écran.
 */
const TCDExport = (function () {
  const EXCELJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js';

  /**
   * Lignes du tableau dans l'ordre d'affichage de subtotal.js : chaque groupe (dans l'ordre de
   * première apparition) suivi de ses lignes. Les groupes ne sont émis qu'avec les sous-totaux.
   */
  function walk(keys, level, n, withGroups, out) {
    if (level === n - 1) {
      keys.forEach(key => out.push({ kind: 'leaf', level, key }));
      return;
    }
    const groups = new Map();
    for (const key of keys) {
      const g = String(key[level]);
      if (!groups.has(g)) { groups.set(g, []); }
      groups.get(g).push(key);
    }
    for (const members of groups.values()) {
      if (withGroups) { out.push({ kind: 'group', level, key: members[0].slice(0, level + 1) }); }
      walk(members, level + 1, n, withGroups, out);
    }
  }

  /**
   * @param {{pd: Object, settings: Object}} ctx
   * @returns {{rowAttrs, colAttrs, colKeys, rows, withRowTotal}}
   */
  function model(ctx) {
    const { pd, settings } = ctx;
    const n = pd.rowAttrs.length;
    const colKeys = pd.getColKeys();
    const cks = colKeys.length ? colKeys : [[]];
    const withRowTotal = colKeys.length > 0 && settings.rowTotals;
    const value = (rk, ck) => pd.getAggregator(rk, ck).value();
    const rows = [];
    if (n) { walk(pd.getRowKeys(), 0, n, settings.subtotals && n > 1, rows); }
    if (settings.colTotals || !n) { rows.push({ kind: 'total', level: 0, key: [] }); }
    rows.forEach(r => {
      r.values = cks.map(ck => value(r.key, ck));
      if (withRowTotal) { r.total = value(r.key, []); }
    });
    return { rowAttrs: pd.rowAttrs, colAttrs: pd.colAttrs, colKeys, rows, withRowTotal };
  }

  // ---------------------------------------------------------------------------
  // Données brutes : une ligne par case de détail, pour la copie et le CSV
  // ---------------------------------------------------------------------------

  function matrix(ctx) {
    const m = model(ctx);
    const n = m.rowAttrs.length;
    const header = [...m.rowAttrs,
      ...(m.colKeys.length ? m.colKeys.map(k => k.join(' / ')) : [ctx.aggLabel]),
      ...(m.withRowTotal ? ['Total'] : [])];
    const body = m.rows.filter(r => r.kind !== 'group').map(r => [
      ...(r.kind === 'total' ? (n ? ['Total', ...Array(n - 1).fill('')] : []) : r.key),
      ...r.values,
      ...(m.withRowTotal ? [r.total] : []),
    ]);
    return [header, ...body];
  }

  function delimited(rows, sep) {
    const cell = v => {
      if (v === null || v === undefined) { return ''; }
      if (typeof v === 'number') { return isFinite(v) ? String(v).replace('.', ',') : ''; }
      const s = String(v);
      return /[";\t\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return rows.map(r => r.map(cell).join(sep)).join('\r\n');
  }

  async function copy(ctx) {
    const text = delimited(matrix(ctx), '\t');
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const ta = UI.el('textarea', { style: 'position:fixed;opacity:0' });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
  }

  function download(blob, name) {
    const a = UI.el('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  /** CSV compatible Excel français : séparateur « ; », virgule décimale, BOM UTF-8 */
  function csv(ctx) {
    download(new Blob(['﻿' + delimited(matrix(ctx), ';')], { type: 'text/csv;charset=utf-8' }), 'tableau-croise.csv');
  }

  // ---------------------------------------------------------------------------
  // Classeur Excel mis en forme (ExcelJS, chargé à la première utilisation)
  // ---------------------------------------------------------------------------

  let excelJs = null;
  function loadExcelJs() {
    if (!excelJs) {
      excelJs = new Promise((resolve, reject) => {
        if (window.ExcelJS) { return resolve(window.ExcelJS); }
        const script = document.createElement('script');
        script.src = EXCELJS_URL;
        script.onload = () => resolve(window.ExcelJS);
        script.onerror = () => { excelJs = null; reject(new Error('ExcelJS indisponible')); };
        document.head.append(script);
      });
    }
    return excelJs;
  }

  const argb = rgb => 'FF' + rgb.map(c => Math.round(c).toString(16).padStart(2, '0')).join('').toUpperCase();
  const FILL = color => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: color } });
  const THIN = { style: 'thin', color: { argb: 'FFD5DAE1' } };
  const STRONG = { style: 'thin', color: { argb: 'FF9AA3B0' } };

  /**
   * @param {Object} ctx - pd, settings, aggLabel, title, filters (texte), numFmt (format Excel des valeurs),
   *   collapsed (clés des groupes repliés), renderer {kind, scope}, accent (rgb)
   */
  async function xlsx(ctx) {
    const ExcelJS = await loadExcelJs();
    const m = model(ctx);
    const n = m.rowAttrs.length, depth = m.colAttrs.length;
    const labelCols = Math.max(n, 1);
    const valueCols = m.colKeys.length || 1;
    const lastCol = labelCols + valueCols + (m.withRowTotal ? 1 : 0);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Widget Tableau croisé dynamique (Grist)';
    const ws = wb.addWorksheet('Tableau croisé', { properties: { outlineProperties: { summaryBelow: false, summaryRight: false } } });

    // Titre et filtres
    ws.getCell(1, 1).value = ctx.title;
    ws.getCell(1, 1).font = { bold: true, size: 13 };
    if (ctx.filters) {
      ws.getCell(2, 1).value = ctx.filters;
      ws.getCell(2, 1).font = { italic: true, color: { argb: 'FF6B7280' } };
    }
    const top = 4;

    // En-têtes : un niveau par champ en colonnes, puis les noms des champs en lignes
    const headRows = Math.max(depth, 1) + (n && depth ? 1 : 0);
    const head = (r, c, v, extra = {}) => {
      const cell = ws.getCell(r, c);
      cell.value = v;
      cell.font = { bold: true, color: { argb: 'FF1F2937' } };
      cell.fill = FILL('FFF1F3F6');
      cell.border = { bottom: THIN, right: THIN };
      cell.alignment = { vertical: 'middle', horizontal: extra.align || 'left', wrapText: true };
      return cell;
    };
    for (let r = top; r < top + headRows; r++) {
      for (let c = 1; c <= lastCol; c++) { head(r, c, null); }
    }
    if (depth) {
      for (let j = 0; j < depth; j++) {
        const r = top + j;
        head(r, labelCols, `${m.colAttrs[j]} →`, { align: 'right' });
        let c = 0;
        while (c < m.colKeys.length) {
          let span = 1;
          const prefix = k => k.slice(0, j + 1).join('\u0000');
          while (c + span < m.colKeys.length && prefix(m.colKeys[c + span]) === prefix(m.colKeys[c])) { span++; }
          head(r, labelCols + 1 + c, m.colKeys[c][j], { align: 'right' });
          if (span > 1) { ws.mergeCells(r, labelCols + 1 + c, r, labelCols + c + span); }
          c += span;
        }
      }
      if (n) {
        // Les colonnes de valeurs du dernier niveau couvrent aussi la ligne des noms de champs
        for (let c = labelCols + 1; c <= labelCols + valueCols; c++) { ws.mergeCells(top + depth - 1, c, top + depth, c); }
      }
    }
    const nameRow = top + headRows - 1;
    if (n) { m.rowAttrs.forEach((a, i) => head(nameRow, i + 1, a)); }
    if (!depth) { head(nameRow, labelCols + 1, ctx.aggLabel, { align: 'right' }); }
    if (m.withRowTotal) {
      head(top, lastCol, 'Total', { align: 'right' });
      if (headRows > 1) { ws.mergeCells(top, lastCol, top + headRows - 1, lastCol); }
    }
    ws.getCell(top, 1).value = ws.getCell(top, 1).value || ctx.aggLabel;

    // Corps
    const collapsed = new Set(ctx.collapsed || []);
    const hiddenUnder = [];
    const leafRanges = [];
    let r = top + headRows;
    for (const row of m.rows) {
      const xrow = ws.getRow(r);
      const isGroup = row.kind === 'group', isTotal = row.kind === 'total';
      if (row.kind !== 'total') {
        // Chemin complet sur chaque ligne (filtres, tris, publipostage) ; les niveaux parents en gris
        row.key.forEach((label, i) => {
          const cell = xrow.getCell(i + 1);
          cell.value = label;
          const parent = i < row.key.length - 1;
          if (parent || label === TCDData.EMPTY) { cell.font = { italic: label === TCDData.EMPTY, color: { argb: parent ? 'FFA0A7B4' : 'FF8A93A3' } }; }
        });
        // Les lignes repliées dans le widget le sont aussi dans Excel (plan)
        if (settingsHasOutline(ctx, n)) { xrow.outlineLevel = row.level; }
        if (hiddenUnder.some(p => p.every((v, i) => row.key[i] === v) && row.key.length > p.length)) { xrow.hidden = true; }
        if (isGroup && collapsed.has(JSON.stringify(row.key))) { hiddenUnder.push(row.key); }
      } else {
        xrow.getCell(1).value = 'Total';
      }
      row.values.forEach((v, i) => setValue(xrow.getCell(labelCols + 1 + i), v, ctx.numFmt));
      if (m.withRowTotal) { setValue(xrow.getCell(lastCol), row.total, ctx.numFmt); }
      for (let c = 1; c <= lastCol; c++) {
        const cell = xrow.getCell(c);
        cell.border = { bottom: THIN, right: THIN, ...(isTotal ? { top: STRONG } : {}), ...(m.withRowTotal && c === lastCol ? { left: STRONG } : {}) };
        if (isGroup || isTotal) {
          cell.font = { ...(cell.font || {}), bold: true };
          cell.fill = FILL(isTotal || row.level === 0 ? 'FFE9EDF3' : 'FFF3F5F8');
        } else if (m.withRowTotal && c === lastCol) {
          cell.font = { ...(cell.font || {}), bold: true };
          cell.fill = FILL('FFF6F7F9');
        }
      }
      if (row.kind === 'leaf') { leafRanges.push(r); }
      r++;
    }

    styleValues(ws, ctx, leafRanges, labelCols, valueCols, m);

    // Largeurs et volets figés
    for (let c = 1; c <= lastCol; c++) {
      const col = ws.getColumn(c);
      if (c <= labelCols) {
        let w = 10;
        col.eachCell({ includeEmpty: false }, (cell, rowNumber) => { if (rowNumber >= top) { w = Math.max(w, String(cell.value || '').length + 2); } });
        col.width = Math.min(w, 42);
      } else {
        col.width = 16;
      }
    }
    ws.views = [{ state: 'frozen', xSplit: labelCols, ySplit: top + headRows - 1 }];

    const buffer = await wb.xlsx.writeBuffer();
    download(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'tableau-croise.xlsx');
    return wb;
  }

  const settingsHasOutline = (ctx, n) => ctx.settings.subtotals && n > 1;

  function setValue(cell, v, numFmt) {
    if (typeof v === 'number' && isFinite(v)) {
      cell.value = Number(v.toPrecision(12));
      if (numFmt) { cell.numFmt = numFmt; }
    } else if (v !== null && v !== undefined) {
      cell.value = String(v);
    }
    cell.alignment = { horizontal: 'right' };
  }

  /** Carte de chaleur et barres : mises en forme conditionnelles d'Excel, sur les cases de détail */
  function styleValues(ws, ctx, leafRows, labelCols, valueCols, m) {
    const kind = ctx.renderer.kind;
    if (kind === 'table') { return; }
    // Sans champ en colonnes, les valeurs de détail sont celles de la colonne « Total »
    const first = labelCols + 1, last = labelCols + valueCols;
    const colLetter = c => ws.getColumn(c).letter;
    const range = (r1, c1, r2, c2) => `${colLetter(c1)}${r1}:${colLetter(c2)}${r2}`;
    const accent = argb(ctx.accent);
    const rule = kind === 'heat'
      ? { type: 'colorScale', cfvo: [{ type: 'min' }, { type: 'max' }], color: [{ argb: 'FFFFFFFF' }, { argb: accent }] }
      : { type: 'dataBar', cfvo: [{ type: 'min' }, { type: 'max' }], color: { argb: accent }, gradient: false };
    const add = ref => ws.addConditionalFormatting({ ref, rules: [{ ...rule, priority: 1 }] });
    if (!leafRows.length) { return; }
    // Barres : une série par ligne, comme le rendu de pivottable
    if (kind === 'bars' || ctx.renderer.scope === 'row') {
      if (!m.colKeys.length) { add(leafRows.map(r => range(r, first, r, first)).join(' ')); return; }
      leafRows.forEach(r => add(range(r, first, r, last)));
    } else if (ctx.renderer.scope === 'col') {
      for (let c = first; c <= last; c++) { add(leafRows.map(r => range(r, c, r, c)).join(' ')); }
    } else {
      add(leafRows.map(r => range(r, first, r, last)).join(' '));
    }
  }

  return { matrix, copy, csv, xlsx };
})();
