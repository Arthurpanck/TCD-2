/**
 * Rendus du tableau : ceux de subtotal.js (sous-totaux repliables, carte de chaleur, barres),
 * complétés d'une mise en forme : couleurs du thème Grist, en-têtes figés, libellés.
 */
const TCDRender = (function () {
  const { EMPTY } = TCDData;
  const subtotalTable = $.pivotUtilities.subtotal_renderers['Table With Subtotal'];

  /** Couleur d'une variable CSS du thème courant (rgb) */
  function themeRgb(name) {
    const probe = document.createElement('span');
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const m = getComputedStyle(probe).color.match(/[\d.]+/g) || [0, 0, 0];
    probe.remove();
    return m.slice(0, 3).map(Number);
  }

  // Couleurs foncées de la carte de chaleur, pour passer le texte en clair
  const strongColors = new Set();

  /** Échelle de couleur de la carte de chaleur (option `heatmap.colorScaleGenerator` de pivottable) */
  function colorScaleGenerator(values) {
    const surface = themeRgb('--surface'), accent = themeRgb('--accent-base');
    const min = Math.min(...values), max = Math.max(...values), range = max - min;
    return x => {
      const t = range ? (x - min) / range : 0.5;
      const p = t * 0.78 + 0.04;
      const color = `rgb(${surface.map((c, k) => Math.round(c + (accent[k] - c) * p)).join(', ')})`;
      if (t > 0.62) { strongColors.add(color); }
      return color;
    };
  }

  /**
   * Applique un post-traitement de pivottable (heatmap, barchart) aux seules cellules de détail :
   * sous-totaux et totaux sont mis de côté le temps du calcul pour ne pas écraser l'échelle.
   * Sans champ en colonnes, les valeurs sont dans la colonne « Total » : elles forment alors une série.
   */
  function onDetailCells(table, hasCols, post) {
    const series = hasCols ? [] : [...table.querySelectorAll('td.rowTotal:not(.pvtRowSubtotal)')];
    const held = [...table.querySelectorAll('td.pvtRowSubtotal, td.pvtColSubtotal, td.pvtTotal')].filter(td => !series.includes(td));
    const cells = [...held, ...series];
    const classes = cells.map(td => td.className);
    held.forEach(td => { td.className = 'tcd-held'; });
    series.forEach(td => { td.className = 'pvtVal row0'; });
    post($(table));
    cells.forEach((td, i) => { td.className = classes[i]; });
  }

  /**
   * Rendus proposés à pivotUI (noms de la locale française de pivottable, compatibles avec
   * les réglages existants).
   * @param {{onPivotData: Function, options: Function}} hooks - options dynamiques du widget
   */
  function renderers(hooks) {
    const make = post => (pd, opts) => {
      hooks.onPivotData(pd);
      const o = $.extend(true, {}, opts, hooks.options(), { heatmap: { colorScaleGenerator } });
      const table = subtotalTable(pd, o);
      if (post) { onDetailCells(table, pd.colAttrs.length > 0, $t => post($t, o)); }
      return table;
    };
    return {
      'Table': make(null),
      'Table avec barres': make($t => $t.barchart()),
      'Carte de chaleur': make(($t, o) => $t.heatmap('heatmap', o)),
      'Carte de chaleur par ligne': make(($t, o) => $t.heatmap('rowheatmap', o)),
      'Carte de chaleur par colonne': make(($t, o) => $t.heatmap('colheatmap', o)),
    };
  }

  /**
   * Mise en forme du tableau rendu par subtotal.js.
   * @param {HTMLTableElement} table
   * @param {{aggLabel: string, rowTotals: boolean, colTotals: boolean, rows: number, cols: number}} ctx
   */
  function decorate(table, ctx) {
    table.classList.add('tcd-table');
    table.classList.toggle('hide-row-totals', !ctx.rowTotals && ctx.cols > 0);
    table.classList.toggle('hide-col-totals', !ctx.colTotals && ctx.rows > 0);
    bars(table);
    table.dataset.rowLevels = ctx.rows;

    // Coin supérieur gauche : le calcul affiché
    const corner = table.tHead && table.tHead.rows[0] && table.tHead.rows[0].cells[0];
    if (corner && !corner.className && ctx.rows && ctx.cols) {
      corner.classList.add('pvtCorner');
      corner.textContent = ctx.aggLabel;
    }
    // Sans champ en colonnes, la colonne de valeurs porte le nom du calcul
    if (!ctx.cols) {
      const head = table.querySelector('thead th.pvtTotalLabel.rowTotal');
      if (head) { head.textContent = ctx.aggLabel; head.classList.add('pvtValueHeader'); }
    }
    table.querySelectorAll('th[data-rowheader], th[data-colheader]').forEach(th => {
      const text = th.getAttribute('data-rowheader') || th.getAttribute('data-colheader');
      if (text.trim() === EMPTY) { th.classList.add('is-empty'); }
      if (text.length > 28) { th.title = text.trim(); }
    });
    table.querySelectorAll('td[style*="background"]').forEach(td => {
      td.classList.add('is-heat');
      if (strongColors.has(td.style.backgroundColor)) { td.classList.add('is-heat-strong'); }
    });
    if (table.querySelectorAll('td').length > 3000) { table.classList.add('is-large'); }
  }

  /**
   * Barres de pivottable (barchart) : la hauteur calculée par la librairie devient une jauge
   * horizontale sous la valeur (--pct), plus lisible dans un tableau.
   */
  function bars(table) {
    table.querySelectorAll('td > div[style*="position: relative"]').forEach(wrapper => {
      const td = wrapper.parentElement;
      const [bar, text] = wrapper.children;
      // pivottable dessine la plus grande barre à 100 / 1,4 % de la hauteur de la cellule
      const pct = Math.min(1, parseFloat(bar.style.height) * 1.4 / 100) || 0;
      td.textContent = text.textContent;
      td.removeAttribute('style');
      td.style.setProperty('--pct', pct.toFixed(4));
      td.classList.add('has-bar');
      if (bar.style.backgroundColor === 'darkred') { td.classList.add('bar-neg'); }
    });
  }

  /**
   * En-têtes figés : calcule les décalages des lignes d'en-tête et des colonnes de libellés.
   * Toutes les mesures sont lues avant d'écrire les styles, pour ne provoquer qu'un seul calcul de mise en page.
   */
  function stick(table) {
    const thead = table.tHead;
    if (!thead || !thead.rows.length) { return; }
    const rows = [...thead.rows];
    const heights = rows.map(tr => tr.offsetHeight);
    const levels = Number(table.dataset.rowLevels) || 0;
    // Dernière ligne d'en-tête : noms des champs en lignes, un par niveau
    const axisCells = levels ? [...rows[rows.length - 1].cells].slice(0, levels) : [];
    const widths = axisCells.map(cell => cell.offsetWidth);

    let top = 0;
    rows.forEach((tr, i) => {
      for (const cell of tr.cells) { cell.style.top = top + 'px'; }
      top += heights[i];
    });
    let left = 0;
    axisCells.forEach((cell, j) => {
      cell.classList.add('pvtRowAxis');
      cell.style.left = left + 'px';
      table.style.setProperty(`--left-${j}`, left + 'px');
      left += widths[j];
    });
  }

  return { renderers, decorate, stick };
})();
