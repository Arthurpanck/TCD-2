/**
 * Widget Tableau croisé dynamique pour Grist.
 * - Vue consultation par défaut (tableau seul, lisible)
 * - Configuration ouverte via le bouton « Ouvrir la configuration » du panneau Grist (onEditOptions)
 * - Réglages enregistrés dans les options du widget (clé `settings`, compatible avec les versions précédentes)
 */
const { el } = UI;
const { label } = TCDData;
const $id = id => document.getElementById(id);

const DEFAULTS = {
  rows: [],
  cols: [],
  vals: [],
  aggregatorName: 'Nombre',
  rendererName: 'Table',
  exclusions: {},
  rowOrder: 'key_a_to_z',
  colOrder: 'key_a_to_z',
  rowTotals: true,
  colTotals: true,
  subtotals: true,
  chartType: 'bar',
  decimals: 'auto',
  scale: 1,
  suffix: '',
  density: 'standard',
  fontScale: 1,
  accent: 'bleu',
};
const ORDERS = ['key_a_to_z', 'value_a_to_z', 'value_z_to_a'];
const DENSITIES = ['compact', 'standard', 'comfortable'];

const state = {
  settings: normalizeSettings(null),
  dataset: null,
  optionsLoaded: false,
  configOpen: false,
  snapshot: null,
  pd: null,
  cellInfo: new WeakMap(),
  // État d'affichage propre à la session (non enregistré) : groupes repliés, nombre de lignes affichées
  view: { collapsed: new Set(), rowLimit: 0 },
  aggLabel: '',
  saveTimer: null,
  savePending: false,
};

// ---------------------------------------------------------------------------
// Réglages
// ---------------------------------------------------------------------------

function normalizeSettings(raw, legacy = {}) {
  const s = Object.assign({}, DEFAULTS, raw || {});
  const list = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : []);
  s.rows = list(s.rows);
  s.cols = list(s.cols);
  s.vals = list(s.vals);
  s.aggregatorName = TCDAggregators.normalizeName(s.aggregatorName);
  const ex = {};
  for (const [k, v] of Object.entries(s.exclusions || {})) {
    if (Array.isArray(v) && v.length) { ex[k] = v.map(String); }
  }
  s.exclusions = ex;
  if (!ORDERS.includes(s.rowOrder)) { s.rowOrder = DEFAULTS.rowOrder; }
  if (!ORDERS.includes(s.colOrder)) { s.colOrder = DEFAULTS.colOrder; }
  s.rowTotals = s.rowTotals !== false;
  s.colTotals = s.colTotals !== false;
  s.subtotals = s.subtotals !== false;
  if (!TCDChart.TYPES.some(([t]) => t === s.chartType)) { s.chartType = DEFAULTS.chartType; }
  s.scale = [1, 1e3, 1e6].includes(Number(s.scale)) ? Number(s.scale) : 1;
  s.suffix = typeof s.suffix === 'string' ? s.suffix : '';
  if (!['auto', '0', '1', '2', 0, 1, 2].includes(s.decimals)) { s.decimals = 'auto'; }
  s.decimals = String(s.decimals);
  // Ancien réglage « Taille colonnes » (0.25x → 1.0x) converti en densité
  if ((!raw || raw.density === undefined) && legacy.columnSize) {
    s.density = parseFloat(legacy.columnSize) < 0.75 ? 'compact' : 'standard';
  }
  if (!DENSITIES.includes(s.density)) { s.density = DEFAULTS.density; }
  s.fontScale = Math.min(1.4, Math.max(0.8, Number(s.fontScale) || 1));
  return s;
}

function rendererOf(name) {
  switch (name) {
    case 'Carte de chaleur': case 'Heatmap': return { kind: 'heat', scope: 'all' };
    case 'Carte de chaleur par ligne': case 'Row Heatmap': return { kind: 'heat', scope: 'row' };
    case 'Carte de chaleur par colonne': case 'Col Heatmap': return { kind: 'heat', scope: 'col' };
    case 'Table avec barres': case 'Table Barchart': return { kind: 'bars', scope: 'all' };
    case 'Graphique': return { kind: 'chart', scope: 'all' };
    default: return { kind: 'table', scope: 'all' };
  }
}

/** Réglages effectivement utilisables avec les données actuelles */
function effectiveSettings() {
  const s = state.settings;
  const known = new Set((state.dataset ? state.dataset.fields : []).map(f => f.name));
  const keep = a => known.has(a);
  const r = rendererOf(s.rendererName);
  const n = TCDAggregators.numInputs(s.aggregatorName);
  return { ...s, rows: s.rows.filter(keep), cols: s.cols.filter(keep), vals: s.vals.slice(0, n), renderer: r.kind, heatScope: r.scope };
}

function update(patch) {
  if (patch.rows && patch.rows.join('\0') !== state.settings.rows.join('\0')) {
    state.view.collapsed.clear();
  }
  state.settings = normalizeSettings({ ...state.settings, ...patch });
  applyAppearance();
  TCDConfig.refresh();
  scheduleRender();
  scheduleSave();
}

function scheduleSave() {
  clearTimeout(state.saveTimer);
  state.savePending = true;
  setSaveState('saving');
  state.saveTimer = setTimeout(saveNow, 350);
}

async function saveNow() {
  clearTimeout(state.saveTimer);
  if (!state.savePending) { return; }
  try {
    await grist.setOption('settings', state.settings);
    setSaveState('saved');
  } catch (e) {
    console.error('Enregistrement impossible :', e);
    setSaveState('error');
    UI.toast("Les modifications s'appliquent mais n'ont pas pu être enregistrées (droits d'édition requis).", 'error');
  } finally {
    state.savePending = false;
  }
}

function setSaveState(kind) {
  const node = $id('save-state');
  node.className = 'save-state is-' + kind;
  node.textContent = { saving: 'Enregistrement…', saved: 'Enregistré', error: 'Non enregistré' }[kind] || '';
}

function applyAppearance() {
  const s = state.settings;
  const root = document.documentElement;
  root.dataset.density = s.density;
  root.style.setProperty('--accent-base', TCDConfig.accentColor(s.accent));
  root.style.setProperty('--font-scale', s.fontScale);
}

// ---------------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------------

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) { return; }
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function isConfigured(s) {
  return s.rows.length > 0 || s.cols.length > 0;
}

function render() {
  if (!state.dataset || !state.optionsLoaded) { return; }
  const out = $id('output');
  const s = effectiveSettings();
  state.aggLabel = TCDAggregators.describe(s.aggregatorName, s.vals);
  state.pd = null;

  if (!state.dataset.records.length) {
    renderSummary(s);
    return showMessage('table', 'La table source est vide', "Ajoutez des lignes dans la table liée à ce widget : le tableau croisé se mettra à jour automatiquement.");
  }
  if (!isConfigured(s)) {
    renderSummary(s);
    if (state.configOpen) {
      return showMessage('grid', 'Construisez votre tableau', 'Glissez un champ dans « Lignes » ou « Colonnes », ou cliquez sur un champ pour choisir où le placer.');
    }
    return showMessage('grid', "Ce tableau croisé n'est pas encore configuré",
      'Cliquez sur « Ouvrir la configuration » dans le panneau de droite de Grist, ou directement ci-dessous.',
      { label: 'Configurer le tableau', onClick: openConfig });
  }

  if (s.renderer === 'chart') { return renderChart(s); }
  TCDChart.destroy();

  let table;
  try {
    const result = TCDRender.render(state.dataset, s, state.aggLabel, state.view);
    state.pd = result.pd;
    state.cellInfo = result.info;
    table = result.table;
  } catch (e) {
    console.error(e);
    renderSummary(s);
    return showMessage('info', 'Impossible de calculer ce tableau', String(e && e.message || e));
  }
  renderSummary(s);
  const { scrollTop, scrollLeft } = out;
  out.classList.remove('is-message');
  out.replaceChildren(table);
  out.scrollTop = scrollTop;
  out.scrollLeft = scrollLeft;
  TCDRender.stick(table);
  indexColumns(table);
}

function renderChart(s) {
  const out = $id('output');
  try {
    state.pd = TCDRender.buildPivotData(state.dataset, s);
  } catch (e) {
    console.error(e);
    renderSummary(s);
    return showMessage('info', 'Impossible de calculer ce tableau', String(e && e.message || e));
  }
  state.cellInfo = new WeakMap();
  renderSummary(s);
  out.classList.remove('is-message');
  const box = el('div', { class: 'chart-view' });
  out.replaceChildren(box);
  TCDChart.render(box, {
    pd: state.pd,
    settings: s,
    aggLabel: state.aggLabel,
    onSelect: cell => openDrawer(cell),
    onType: type => update({ chartType: type }),
  });
}

function showMessage(icon, title, text, action) {
  TCDChart.destroy();
  const out = $id('output');
  out.classList.add('is-message');
  out.replaceChildren(el('div', { class: 'empty' },
    el('div', { class: 'empty-icon', html: Icons.svg(icon, 26) }),
    el('h3', {}, title),
    el('p', {}, text),
    action ? el('button', { type: 'button', class: 'btn btn-primary', onclick: action.onClick, html: Icons.svg('settings', 15) + `<span>${action.label}</span>` }) : null));
}

function renderSummary(s) {
  const box = $id('summary');
  const parts = [];
  if (isConfigured(s)) {
    parts.push(el('span', { class: 'sum-agg' }, state.aggLabel));
    const dims = [s.rows.map(label).join(', '), s.cols.map(label).join(', ')].filter(Boolean);
    if (dims.length) {
      parts.push(el('span', { class: 'sum-sep' }, 'par'));
      dims.forEach((d, i) => {
        if (i) { parts.push(el('span', { class: 'sum-x' }, '×')); }
        parts.push(el('span', { class: 'sum-dim' }, d));
      });
    }
  } else {
    parts.push(el('span', { class: 'sum-agg' }, 'Tableau croisé dynamique'));
  }
  const total = state.dataset ? state.dataset.records.length : 0;
  const shown = state.pd ? state.pd.tcdRecordCount : total;
  const meta = shown === total
    ? `${total.toLocaleString('fr-FR')} ligne${total > 1 ? 's' : ''}`
    : `${shown.toLocaleString('fr-FR')} / ${total.toLocaleString('fr-FR')} lignes`;
  parts.push(el('span', { class: 'sum-meta' }, meta));
  const filters = Object.entries(state.settings.exclusions);
  if (filters.length) {
    const btn = el('button', {
      type: 'button', class: 'sum-filters', 'aria-haspopup': 'true',
      html: Icons.svg('filter', 12) + `<span>${filters.length} filtre${filters.length > 1 ? 's' : ''}</span>`,
    });
    btn.addEventListener('click', () => {
      if (UI.isOpenFor(btn)) { return UI.closePopover(); }
      UI.openPopover(btn, el('div', { class: 'menu' },
        el('div', { class: 'menu-title' }, 'Filtres actifs'),
        el('div', { class: 'filter-list' }, filters.map(([a, v]) => TCDConfig.filterPill(a, v, true)))));
    });
    parts.push(btn);
  }
  box.replaceChildren(...parts);
  box.title = box.textContent;
}

// Colonnes indexées pour le surlignage en croix au survol
let colCells = new Map();
let hoverCol = null;
function indexColumns(table) {
  colCells = new Map();
  hoverCol = null;
  table.querySelectorAll('td.pvtVal, td.pvtSubtotal').forEach(td => {
    const j = td.dataset.col;
    if (j === undefined) { return; }
    if (!colCells.has(j)) { colCells.set(j, []); }
    colCells.get(j).push(td);
  });
}

// ---------------------------------------------------------------------------
// Interactions sur le tableau : survol, info-bulle, détail
// ---------------------------------------------------------------------------

function cellKeys(td) {
  return state.cellInfo.get(td) || null;
}

function criteriaFor(keys) {
  const pd = state.pd;
  const criteria = {};
  pd.rowAttrs.forEach((a, i) => { if (keys.rowKey[i] !== undefined) { criteria[a] = keys.rowKey[i]; } });
  pd.colAttrs.forEach((a, i) => { if (keys.colKey[i] !== undefined) { criteria[a] = keys.colKey[i]; } });
  return criteria;
}

const tooltip = $id('tooltip');
let tooltipTimer = null;

function setHoverCol(key) {
  if (hoverCol === key) { return; }
  if (hoverCol !== null) { (colCells.get(hoverCol) || []).forEach(td => td.classList.remove('is-col-hover')); }
  hoverCol = key;
  if (key !== null) { (colCells.get(key) || []).forEach(td => td.classList.add('is-col-hover')); }
}

function showTooltip(td, x, y) {
  const keys = cellKeys(td);
  if (!keys) { return; }
  const agg = keys.agg;
  const lines = Object.entries(criteriaFor(keys)).map(([a, v]) => el('div', { class: 'tt-line' }, el('span', {}, label(a)), el('b', {}, String(v))));
  tooltip.replaceChildren(
    ...(lines.length ? lines : [el('div', { class: 'tt-line' }, el('span', {}, 'Ensemble des données'))]),
    el('div', { class: 'tt-value' }, el('span', {}, state.aggLabel), el('b', {}, agg.format(agg.value()))),
    el('div', { class: 'tt-hint' }, 'Cliquez pour voir le détail'));
  tooltip.hidden = false;
  const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
  let left = x + 14, top = y + 16;
  if (left + tw > window.innerWidth - 8) { left = x - tw - 14; }
  if (top + th > window.innerHeight - 8) { top = y - th - 12; }
  tooltip.style.left = Math.max(8, left) + 'px';
  tooltip.style.top = Math.max(8, top) + 'px';
}

function hideTooltip() {
  clearTimeout(tooltipTimer);
  tooltip.hidden = true;
}

function setupTableInteractions() {
  const out = $id('output');
  out.addEventListener('mouseover', e => {
    const td = e.target.closest('td.pvtVal, td.pvtSubtotal');
    setHoverCol(td && td.dataset.col !== undefined ? td.dataset.col : null);
  });
  out.addEventListener('mousemove', e => {
    const td = e.target.closest('td.pvtVal, td.pvtSubtotal, td.pvtTotal, td.pvtGrandTotal');
    hideTooltip();
    if (!td || document.body.classList.contains('is-dragging')) { return; }
    tooltipTimer = setTimeout(() => showTooltip(td, e.clientX, e.clientY), 350);
  });
  out.addEventListener('mouseleave', () => { setHoverCol(null); hideTooltip(); });
  out.addEventListener('keydown', onTableKey);
  out.addEventListener('scroll', hideTooltip, { passive: true });
  out.addEventListener('click', e => {
    const toggle = e.target.closest('.grp-toggle');
    if (toggle) { return toggleGroup(toggle.dataset.group); }
    if (e.target.closest('[data-action="show-all"]')) {
      state.view.rowLimit = Infinity;
      return scheduleRender();
    }
    const td = e.target.closest('td.pvtVal, td.pvtSubtotal, td.pvtTotal, td.pvtGrandTotal');
    const keys = td && cellKeys(td);
    if (keys) { hideTooltip(); openDrawer(keys, td); }
  });

  // Recalcule les en-têtes figés quand la taille change (panneau Grist ouvert, redimensionnement…)
  let raf = null;
  new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const table = out.querySelector('table.pvtTable');
      if (table) { TCDRender.stick(table); }
    });
  }).observe(out);
}

function toggleGroup(key) {
  const c = state.view.collapsed;
  c.has(key) ? c.delete(key) : c.add(key);
  scheduleRender();
}

/** Replie (ou déplie) tous les groupes du premier niveau */
function setAllCollapsed(collapse) {
  state.view.collapsed = new Set();
  if (collapse && state.pd) {
    for (const key of state.pd.getRowKeys()) { state.view.collapsed.add(String(key[0])); }
  }
  scheduleRender();
}

const NAV_CELLS = 'td.pvtVal, td.pvtSubtotal, td.pvtTotal, td.pvtGrandTotal';

/** Navigation au clavier : flèches entre les cellules, Entrée pour le détail */
function onTableKey(e) {
  const table = $id('output').querySelector('table.pvtTable');
  if (!table || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', ' ', 'Home', 'End'].includes(e.key)) { return; }
  const current = document.activeElement && document.activeElement.matches && document.activeElement.matches(NAV_CELLS) ? document.activeElement : null;
  if (!current) {
    if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      focusCell(table.querySelector(NAV_CELLS));
    }
    return;
  }
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    const keys = cellKeys(current);
    if (keys) { openDrawer(keys, current); }
    return;
  }
  e.preventDefault();
  const cellsOf = tr => [...tr.querySelectorAll(NAV_CELLS)];
  const row = current.parentElement;
  const index = cellsOf(row).indexOf(current);
  let target = null;
  if (e.key === 'ArrowLeft') { target = cellsOf(row)[index - 1]; }
  if (e.key === 'ArrowRight') { target = cellsOf(row)[index + 1]; }
  if (e.key === 'Home') { target = cellsOf(row)[0]; }
  if (e.key === 'End') { target = cellsOf(row).pop(); }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    let tr = row;
    do { tr = e.key === 'ArrowUp' ? tr.previousElementSibling : tr.nextElementSibling; } while (tr && !cellsOf(tr).length);
    if (tr) { const cells = cellsOf(tr); target = cells[Math.min(index, cells.length - 1)]; }
  }
  focusCell(target);
}

function focusCell(td) {
  if (!td) { return; }
  td.tabIndex = -1;
  td.focus({ preventScroll: false });
  td.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const r = td.getBoundingClientRect();
  showTooltip(td, r.right - 8, r.bottom - 4);
}

let selectedTd = null;

/** Détail d'une cellule : keys = { rowKey, colKey, agg } ; td = cellule du tableau à mettre en évidence */
function openDrawer(keys, td) {
  const criteria = criteriaFor(keys);
  const records = [];
  state.pd.forEachMatchingRecord(criteria, rec => { records.push(rec); });
  const agg = keys.agg;

  if (selectedTd) { selectedTd.classList.remove('is-selected'); }
  selectedTd = td || null;
  if (td) { td.classList.add('is-selected'); }

  $id('drawer-value').textContent = agg.format(agg.value()) || '—';
  $id('drawer-sub').textContent = `${state.aggLabel} · ${records.length.toLocaleString('fr-FR')} ligne${records.length > 1 ? 's' : ''}`;
  const entries = Object.entries(criteria);
  $id('drawer-filters').replaceChildren(...(entries.length
    ? entries.map(([a, v]) => el('span', { class: 'crit' }, el('span', {}, label(a)), el('b', {}, String(v))))
    : [el('span', { class: 'crit' }, el('b', {}, 'Toutes les lignes'))]));

  const LIMIT = 300;
  const fields = state.dataset.fields.filter(f => !f.parent);
  const body = $id('drawer-body');
  body.replaceChildren(el('table', { class: 'detail-table' },
    el('thead', {}, el('tr', {}, fields.map(f => el('th', { class: f.type === 'number' ? 'num' : '' }, label(f.name))))),
    el('tbody', {}, records.slice(0, LIMIT).map(rec => el('tr', {}, fields.map(f => {
      const v = rec[f.name];
      return el('td', { class: (f.type === 'number' ? 'num' : '') + (v === TCDData.EMPTY ? ' is-empty' : '') },
        typeof v === 'number' ? v.toLocaleString('fr-FR', { useGrouping: Math.abs(v) >= 1e4 }) : String(v));
    }))))));
  if (records.length > LIMIT) {
    body.append(el('p', { class: 'hint' }, `Seules les ${LIMIT} premières lignes sont affichées.`));
  }

  const ids = records.map(r => r.id).filter(id => typeof id === 'number');
  $id('drawer-select').onclick = () => {
    selectRows(ids);
    UI.toast(`${ids.length.toLocaleString('fr-FR')} ligne(s) transmise(s) aux widgets liés.`, 'success');
  };
  selectRows(ids);

  $id('drawer').hidden = false;
  $id('drawer-backdrop').hidden = false;
  requestAnimationFrame(() => document.body.classList.add('drawer-open'));
  $id('drawer-close').focus({ preventScroll: true });
}

function closeDrawer() {
  if ($id('drawer').hidden) { return; }
  document.body.classList.remove('drawer-open');
  if (selectedTd) { selectedTd.classList.remove('is-selected'); selectedTd = null; }
  setTimeout(() => { $id('drawer').hidden = true; $id('drawer-backdrop').hidden = true; }, 180);
  selectRows(null);
}

/** Transmet la sélection aux widgets Grist liés (« Sélectionner par » ce widget) */
function selectRows(ids) {
  try {
    if (typeof grist.setSelectedRows === 'function') {
      Promise.resolve(grist.setSelectedRows(ids)).catch(() => {});
    }
  } catch (e) { /* widget non lié : rien à faire */ }
}

// ---------------------------------------------------------------------------
// Barre de consultation : affichage et export
// ---------------------------------------------------------------------------

function openDisplayMenu(anchor) {
  if (UI.isOpenFor(anchor)) { return UI.closePopover(); }
  const s = state.settings;
  const r = rendererOf(s.rendererName);
  // Rouvre le menu pour refléter le nouveau réglage
  const reopen = () => { UI.closePopover(); openDisplayMenu(anchor); };
  const seg = (items, current, onPick) => el('div', { class: 'segmented' }, items.map(([v, l]) =>
    el('button', { type: 'button', class: v === current ? 'is-active' : '', onclick: () => { onPick(v); reopen(); } }, l)));
  const root = el('div', { class: 'menu display-menu' },
    el('div', { class: 'menu-title' }, 'Mise en forme'),
    seg([['table', 'Tableau'], ['heat', 'Chaleur'], ['bars', 'Barres'], ['chart', 'Graphique']], r.kind,
      v => update({ rendererName: TCDConfig.rendererName(v, r.scope) })),
    s.subtotals && s.rows.length > 1 ? el('div', { class: 'menu-title' }, 'Groupes') : null,
    s.subtotals && s.rows.length > 1 ? el('div', { class: 'segmented' },
      el('button', { type: 'button', onclick: () => { setAllCollapsed(true); UI.closePopover(); } }, 'Tout replier'),
      el('button', { type: 'button', onclick: () => { setAllCollapsed(false); UI.closePopover(); } }, 'Tout déplier')) : null,
    el('div', { class: 'menu-title' }, 'Densité'),
    seg([['compact', 'Compacte'], ['standard', 'Standard'], ['comfortable', 'Aérée']], s.density, v => update({ density: v })),
    el('div', { class: 'menu-title' }, 'Taille du texte'),
    el('div', { class: 'stepper' },
      el('button', { type: 'button', class: 'btn btn-ghost', title: 'Réduire', onclick: () => { update({ fontScale: +(s.fontScale - 0.1).toFixed(2) }); reopen(); } }, 'A−'),
      el('span', {}, Math.round(s.fontScale * 100) + ' %'),
      el('button', { type: 'button', class: 'btn btn-ghost', title: 'Agrandir', onclick: () => { update({ fontScale: +(s.fontScale + 0.1).toFixed(2) }); reopen(); } }, 'A+')));
  UI.openPopover(anchor, root, { align: 'end' });
}

function exportMatrix() {
  const pd = state.pd;
  if (!pd) { return null; }
  const rowKeys = pd.getRowKeys(), colKeys = pd.getColKeys();
  const cks = colKeys.length ? colKeys : [[]];
  const withRowTotal = colKeys.length > 0 && state.settings.rowTotals;
  const value = (rk, ck) => pd.getAggregator(rk, ck).value();
  const header = [...pd.rowAttrs.map(label),
    ...(colKeys.length ? colKeys.map(k => k.join(' / ')) : [state.aggLabel]),
    ...(withRowTotal ? ['Total'] : [])];
  const rows = [header];
  for (const rk of (rowKeys.length ? rowKeys : [[]])) {
    if (!pd.rowAttrs.length) { break; }
    rows.push([...rk, ...cks.map(ck => value(rk, ck)), ...(withRowTotal ? [value(rk, [])] : [])]);
  }
  if (state.settings.colTotals || !pd.rowAttrs.length) {
    const label0 = pd.rowAttrs.length ? ['Total', ...pd.rowAttrs.slice(1).map(() => '')] : [];
    rows.push([...label0, ...cks.map(ck => value([], ck)), ...(withRowTotal ? [value([], [])] : [])]);
  }
  return rows;
}

function toDelimited(rows, sep) {
  const cell = v => {
    if (v === null || v === undefined) { return ''; }
    if (typeof v === 'number') { return isFinite(v) ? String(v).replace('.', ',') : ''; }
    const s = String(v);
    return /[";\t\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map(r => r.map(cell).join(sep)).join('\r\n');
}

async function copyTable() {
  const rows = exportMatrix();
  if (!rows) { return; }
  const text = toDelimited(rows, '\t');
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const ta = el('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  UI.toast('Tableau copié : collez-le dans un tableur ou un courriel.', 'success');
}

function downloadCsv() {
  const rows = exportMatrix();
  if (!rows) { return; }
  const blob = new Blob(['﻿' + toDelimited(rows, ';')], { type: 'text/csv;charset=utf-8' });
  const a = el('a', { href: URL.createObjectURL(blob), download: 'tableau-croise.csv' });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function openExportMenu(anchor) {
  if (UI.isOpenFor(anchor)) { return UI.closePopover(); }
  if (!state.pd) { return UI.toast("Rien à exporter : configurez d'abord le tableau.", 'info'); }
  UI.openPopover(anchor, UI.menu([
    { icon: 'copy', label: 'Copier (pour Excel / LibreOffice)', onClick: copyTable },
    { icon: 'download', label: 'Télécharger en CSV', onClick: downloadCsv },
    { icon: 'printer', label: 'Imprimer', onClick: () => window.print() },
  ], 'Exporter le tableau'), { align: 'end' });
}

// ---------------------------------------------------------------------------
// Ouverture / fermeture de la configuration
// ---------------------------------------------------------------------------

function openConfig() {
  if (!state.configOpen) {
    state.configOpen = true;
    state.snapshot = JSON.parse(JSON.stringify(state.settings));
  }
  closeDrawer();
  $id('config').hidden = false;
  document.body.classList.add('is-config');
  setSaveState(state.savePending ? 'saving' : 'saved');
  TCDConfig.refresh();
  scheduleRender();
}

function closeConfig() {
  state.configOpen = false;
  state.snapshot = null;
  UI.closePopover();
  $id('config').hidden = true;
  document.body.classList.remove('is-config');
  saveNow();
  scheduleRender();
}

function revert() {
  if (!state.snapshot) { return; }
  update(JSON.parse(JSON.stringify(state.snapshot)));
  UI.toast('Modifications annulées.', 'info');
}

// ---------------------------------------------------------------------------
// Liaison avec Grist
// ---------------------------------------------------------------------------

const app = {
  settings: () => state.settings,
  fields: () => (state.dataset ? state.dataset.fields : []),
  dataset: () => state.dataset || { records: [], fields: [], sortKeys: {} },
  update,
  rendererOf,
  closeConfig,
  revert,
};

function handleOptions(options) {
  options = options || {};
  const incoming = normalizeSettings(options.settings, { columnSize: options.columnSize });
  state.optionsLoaded = true;
  // Ignore l'écho de nos propres enregistrements
  if (state.savePending || JSON.stringify(incoming) === JSON.stringify(state.settings)) {
    scheduleRender();
    return;
  }
  state.settings = incoming;
  applyAppearance();
  TCDConfig.refresh();
  scheduleRender();
}

function start() {
  $id('btn-display').innerHTML = Icons.svg('sliders', 17);
  $id('btn-export').innerHTML = Icons.svg('download', 17);
  $id('drawer-close').innerHTML = Icons.svg('x', 18);
  $id('btn-display').addEventListener('click', e => openDisplayMenu(e.currentTarget));
  $id('btn-export').addEventListener('click', e => openExportMenu(e.currentTarget));
  $id('drawer-close').addEventListener('click', closeDrawer);
  $id('drawer-backdrop').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && $id('popover').hidden) { closeDrawer(); } });

  showMessage('table', 'Chargement des données…', '');
  $id('output').classList.add('is-loading');

  TCDConfig.init(app);
  applyAppearance();
  setupTableInteractions();

  grist.ready({
    requiredAccess: 'read table',
    allowSelectBy: true,
    onEditOptions: openConfig,
  });

  // Changement de thème Grist (clair/sombre) : les couleurs calculées doivent être rafraîchies
  new MutationObserver(scheduleRender).observe(document.documentElement, { attributes: true, attributeFilter: ['data-grist-appearance'] });

  grist.onOptions(handleOptions);
  // Si Grist n'envoie pas d'options (widget neuf), on affiche quand même
  setTimeout(() => { if (!state.optionsLoaded) { state.optionsLoaded = true; scheduleRender(); } }, 1500);

  grist.onRecords(records => {
    state.dataset = TCDData.prepare(records);
    $id('output').classList.remove('is-loading');
    if (state.configOpen) { TCDConfig.refresh(); }
    scheduleRender();
  });
}

start();
