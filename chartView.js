/**
 * Vue graphique du tableau croisé (Chart.js, chargé à la demande).
 * Lignes du TCD = catégories, colonnes du TCD = séries.
 * Palette catégorielle à ordre fixe, validée pour le daltonisme en clair et en sombre.
 */
const TCDChart = (function () {
  const SRC = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';
  const PALETTE = {
    light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
    dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
  };
  const MAX_SERIES = PALETTE.light.length;
  const MAX_CATEGORIES = 80;
  const TYPES = [['bar', 'Colonnes'], ['stacked', 'Empilées'], ['hbar', 'Barres'], ['line', 'Courbes']];
  let loading = null;
  let chart = null;

  function load() {
    if (window.Chart) { return Promise.resolve(); }
    if (!loading) {
      loading = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = SRC;
        script.onload = resolve;
        script.onerror = () => { loading = null; reject(new Error('La bibliothèque de graphiques n’a pas pu être chargée.')); };
        document.head.append(script);
      });
    }
    return loading;
  }

  function token(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  /** Construit catégories et séries à partir du PivotData */
  function model(pd, aggLabel) {
    const n = pd.rowAttrs.length, m = pd.colAttrs.length;
    const colKeys = m ? pd.getColKeys() : [];
    let categories, series;
    if (!n) {
      // Seulement des colonnes : chaque colonne devient une catégorie d'une série unique
      categories = colKeys.map(ck => ({ label: ck.join(' · '), rowKey: [], colKey: ck }));
      series = [{ label: aggLabel, cells: categories.map(c => ({ rowKey: [], colKey: c.colKey, agg: pd.getAggregator([], c.colKey) })) }];
    } else {
      categories = pd.getRowKeys().map(rk => ({ label: rk.join(' · '), rowKey: rk }));
      const keys = m ? colKeys : [[]];
      series = keys.map(ck => ({
        label: m ? ck.join(' · ') : aggLabel,
        cells: categories.map(c => ({ rowKey: c.rowKey, colKey: ck, agg: pd.getAggregator(c.rowKey, ck) })),
      }));
    }
    const hiddenSeries = Math.max(0, series.length - MAX_SERIES);
    const hiddenCategories = Math.max(0, categories.length - MAX_CATEGORIES);
    series = series.slice(0, MAX_SERIES).map(sr => ({ ...sr, cells: sr.cells.slice(0, MAX_CATEGORIES) }));
    return { categories: categories.slice(0, MAX_CATEGORIES), series, hiddenSeries, hiddenCategories };
  }

  const truncate = (text, max) => (text.length > max ? text.slice(0, max - 1) + '…' : text);

  /** Coupe un libellé en lignes courtes pour l'axe horizontal (3 lignes au plus) */
  function wrap(text, width = 14) {
    const lines = [];
    let line = '';
    for (const word of String(text).split(/(?<=[\s-])/)) {
      if (line && (line + word).trim().length > width) { lines.push(line.trim()); line = ''; }
      line += word;
    }
    if (line.trim()) { lines.push(line.trim()); }
    return lines.length > 3 ? [...lines.slice(0, 2), truncate(lines.slice(2).join(' '), width)] : lines;
  }

  function destroy() {
    if (chart) { chart.destroy(); chart = null; }
  }

  /**
   * @param {HTMLElement} container
   * @param {Object} opts - { pd, settings, aggLabel, onSelect(cell), onType(type) }
   */
  async function render(container, { pd, settings, aggLabel, onSelect, onType }) {
    destroy();
    const type = TYPES.some(t => t[0] === settings.chartType) ? settings.chartType : 'bar';
    const toolbar = UI.el('div', { class: 'chart-toolbar' },
      UI.el('div', { class: 'segmented' }, TYPES.map(([v, l]) =>
        UI.el('button', { type: 'button', class: v === type ? 'is-active' : '', onclick: () => onType(v) }, l))));
    const note = UI.el('div', { class: 'chart-note' });
    const canvasBox = UI.el('div', { class: 'chart-canvas' }, UI.el('canvas', { role: 'img', 'aria-label': `Graphique : ${aggLabel}` }));
    container.replaceChildren(toolbar, canvasBox, note);

    const data = model(pd, aggLabel);
    const notes = [];
    if (data.hiddenSeries) { notes.push(`${data.hiddenSeries} série(s) non affichée(s) : le graphique se limite aux ${MAX_SERIES} premières colonnes.`); }
    if (data.hiddenCategories) { notes.push(`${data.hiddenCategories} catégorie(s) non affichée(s).`); }
    note.textContent = notes.join(' ');
    note.hidden = !notes.length;

    try {
      await load();
    } catch (e) {
      canvasBox.replaceChildren(UI.el('p', { class: 'hint' }, e.message + ' Le tableau reste disponible.'));
      return;
    }
    if (!container.isConnected) { return; }

    const dark = getComputedStyle(document.documentElement).colorScheme === 'dark';
    const colors = PALETTE[dark ? 'dark' : 'light'];
    const single = data.series.length === 1;
    const surface = token('--surface');
    const text = token('--text'), muted = token('--text-muted'), grid = token('--border');
    const accent = token('--accent');
    const compact = new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 });
    const isLine = type === 'line', horizontal = type === 'hbar', stacked = type === 'stacked';

    const datasets = data.series.map((sr, i) => {
      const color = single ? accent : colors[i];
      const values = sr.cells.map(c => {
        const v = c.agg.value();
        return typeof v === 'number' && isFinite(v) ? v : null;
      });
      return isLine
        ? { label: sr.label, data: values, borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: data.categories.length > 24 ? 0 : 3, pointHoverRadius: 5, pointBorderColor: surface, pointBorderWidth: 2, tension: 0, spanGaps: true }
        : { label: sr.label, data: values, backgroundColor: color, borderColor: surface, borderWidth: stacked ? 1 : 0, borderRadius: stacked ? 0 : 4, borderSkipped: 'start', maxBarThickness: 24, categoryPercentage: 0.72, barPercentage: 0.9 };
    });

    const valueAxis = {
      stacked,
      beginAtZero: true,
      grid: { color: grid, lineWidth: 1, drawTicks: false },
      border: { display: false },
      ticks: { color: muted, padding: 8, callback: v => compact.format(v) },
    };
    const categoryAxis = {
      stacked,
      grid: { display: false },
      border: { color: grid },
      ticks: {
        color: muted, padding: 6, maxRotation: 0,
        autoSkip: data.categories.length > 24,
        callback(v) { return horizontal ? truncate(this.getLabelForValue(v), 32) : wrap(this.getLabelForValue(v)); },
      },
    };

    chart = new window.Chart(canvasBox.querySelector('canvas'), {
      type: isLine ? 'line' : 'bar',
      data: { labels: data.categories.map(c => c.label), datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: horizontal ? 'y' : 'x',
        animation: { duration: 250 },
        font: { family: token('--font') },
        interaction: isLine ? { mode: 'index', intersect: false } : { mode: 'nearest', intersect: true },
        scales: horizontal ? { x: valueAxis, y: categoryAxis } : { x: categoryAxis, y: valueAxis },
        plugins: {
          legend: {
            display: !single,
            position: 'top',
            align: 'start',
            labels: { color: text, usePointStyle: true, pointStyle: isLine ? 'circle' : 'rectRounded', boxWidth: 10, boxHeight: 10, padding: 14 },
          },
          tooltip: {
            backgroundColor: dark ? '#eef1f6' : '#1b2130',
            titleColor: dark ? '#1b2130' : '#eef1f6',
            bodyColor: dark ? '#1b2130' : '#eef1f6',
            padding: 10,
            cornerRadius: 8,
            boxPadding: 4,
            usePointStyle: true,
            callbacks: {
              label: ctx => {
                const cell = data.series[ctx.datasetIndex].cells[ctx.dataIndex];
                return ` ${single ? aggLabel : ctx.dataset.label} : ${cell.agg.format(cell.agg.value())}`;
              },
              footer: () => 'Cliquez pour voir le détail',
            },
            footerColor: dark ? '#5b6577' : '#a9b1bf',
            footerFont: { weight: 'normal', size: 11 },
          },
        },
        onHover: (e, els) => { e.native.target.style.cursor = els.length ? 'pointer' : 'default'; },
        onClick: (_e, els) => {
          if (!els.length) { return; }
          const { datasetIndex, index } = els[0];
          onSelect(data.series[datasetIndex].cells[index]);
        },
      },
    });
  }

  return { render, destroy, load, TYPES };
})();
