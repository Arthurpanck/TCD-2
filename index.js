/**
 * Widget Tableau croisé dynamique pour Grist.
 * - pivotUI (pivottable.js) gère la configuration et le calcul ; subtotal.js le rendu (sous-totaux repliables)
 * - Vue consultation par défaut : seul le tableau est visible
 * - Configuration ouverte via le bouton « Ouvrir la configuration » du panneau Grist (onEditOptions)
 * - Réglages enregistrés dans les options du widget (clé `settings`, compatible avec les versions précédentes)
 */
const { el } = UI;
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
  clickDetail: true,
  density: 'standard',
  fontScale: 1,
};
// Réglages des versions précédentes qui n'existent plus (graphique, format des nombres, couleur d'accent)
const OBSOLETE = ['chartType', 'decimals', 'scale', 'suffix', 'accent'];
const ORDERS = ['key_a_to_z', 'value_a_to_z', 'value_z_to_a'];
const RENDERERS = ['Table', 'Table avec barres', 'Carte de chaleur', 'Carte de chaleur par ligne', 'Carte de chaleur par colonne'];
const DENSITIES = ['compact', 'standard', 'comfortable'];

const state = {
  settings: normalizeSettings(null),
  rawRecords: null,
  dataset: null,
  optionsLoaded: false,
  configOpen: false,
  snapshot: null,
  // Options courantes de pivotUI et données calculées du dernier rendu
  pvt: null,
  pd: null,
  // Repli de tous les groupes demandé depuis le menu Affichage (non enregistré)
  collapseAll: false,
  aggLabel: '',
  saveTimer: null,
  savePending: false,
};
const $host = $('#app');

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
  s.rendererName = RENDERERS[RENDERERS.indexOf(s.rendererName)] || TCDConfig.rendererName(rendererOf(s.rendererName).kind, rendererOf(s.rendererName).scope);
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
  s.clickDetail = s.clickDetail !== false;
  OBSOLETE.forEach(k => { delete s[k]; });
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
    default: return { kind: 'table', scope: 'all' };
  }
}

/** Réglages modifiés depuis le panneau (hors pivotUI) */
function update(patch) {
  state.settings = normalizeSettings({ ...state.settings, ...patch });
  applyAppearance();
  scheduleSave();
  if (['subtotals', 'rowTotals', 'colTotals', 'density', 'fontScale'].some(k => k in patch)) { refreshPivot(); }
  else if (state.pvt) { TCDConfig.sync(state.pvt); }
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
    if (!state.saveErrorShown) {
      state.saveErrorShown = true;
      UI.toast("Affichage modifié pour vous seulement : l'enregistrement nécessite les droits d'édition du document.", 'error');
    }
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
  root.style.setProperty('--font-scale', s.fontScale);
}

// ---------------------------------------------------------------------------
// pivotUI
// ---------------------------------------------------------------------------

/** Options de rendu de subtotal.js qui dépendent des réglages du widget */
function rendererOptions() {
  const s = state.settings;
  return {
    table: {
      // Un seul gestionnaire d'événement : il renseigne la cellule sur demande (survol, clic, clavier)
      eventHandlers: { 'tcd-info': (e, value, filters, pivotData) => Object.assign(e.detail, { value, filters, pivotData }) },
    },
    arrowCollapsed: '▸',
    arrowExpanded: '▾',
    rowSubtotalDisplay: { disableSubtotal: !s.subtotals },
    colSubtotalDisplay: { disableSubtotal: !s.subtotals },
    collapseRowsAt: state.collapseAll ? 0 : null,
    localeStrings: { totals: 'Total' },
  };
}

/** (Re)construit pivotUI avec les réglages enregistrés */
function build() {
  if (!state.dataset || !state.optionsLoaded) { return; }
  const ds = state.dataset;
  const s = state.settings;
  const toAttrs = list => list.map(ds.toAttr).filter(Boolean);
  const exclusions = {};
  for (const [k, v] of Object.entries(s.exclusions)) {
    const attr = ds.toAttr(k);
    if (attr) { exclusions[attr] = v; }
  }

  UI.closePopover();
  // pivotUI remplace le contenu de son hôte : on met le widget de côté le temps de la construction
  $host.find('.pvtUiCell, .pvtRendererArea, .pvtFilterBox, .pvtRowOrder, .pvtColOrder').remove();
  const kids = $host.children().detach();
  state.building = true;
  $host.pivotUI(ds.records, {
    rows: toAttrs(s.rows),
    cols: toAttrs(s.cols),
    vals: toAttrs(s.vals),
    aggregatorName: s.aggregatorName,
    rendererName: s.rendererName,
    rowOrder: s.rowOrder,
    colOrder: s.colOrder,
    exclusions,
    dataClass: $.pivotUtilities.SubtotalPivotData,
    aggregators: TCDAggregators.forUI(name => ds.fromAttr(name).split(' › ')[0]),
    renderers: TCDRender.renderers({ onPivotData: pd => { state.pd = pd; }, options: rendererOptions }),
    derivedAttributes: ds.derivedAttributes,
    sorters: ds.sorters,
    hiddenAttributes: ['id'],
    menuLimit: 1000,
    unusedAttrsVertical: true,
    localeStrings: {
      selectAll: 'Tout cocher', selectNone: 'Tout décocher', filterResults: 'Rechercher une valeur…',
      apply: 'Appliquer', cancel: 'Annuler', totals: 'Total',
    },
    onRefresh,
  }, true, 'fr');
  $host.prepend(kids);
  TCDConfig.adopt($host);
}

/** Demande à pivotUI de recalculer avec l'état courant de son interface */
function refreshPivot() {
  $host.find('select.pvtRenderer').trigger('change');
}

/** Appelé par pivotUI après chaque calcul : enregistre les réglages et met en forme le tableau */
function onRefresh(pvt) {
  const ds = state.dataset;
  const exclusions = {};
  for (const [k, v] of Object.entries(pvt.exclusions || {})) { exclusions[ds.fromAttr(k)] = v.map(String); }
  const patch = {
    rows: pvt.rows.map(ds.fromAttr),
    cols: pvt.cols.map(ds.fromAttr),
    vals: pvt.vals.map(ds.fromAttr),
    aggregatorName: pvt.aggregatorName,
    rendererName: pvt.rendererName,
    rowOrder: pvt.rowOrder,
    colOrder: pvt.colOrder,
    exclusions,
  };
  const before = state.settings;
  const next = normalizeSettings({ ...before, ...patch });
  const changed = JSON.stringify(next) !== JSON.stringify(before);
  if (changed && ['rows', 'cols', 'exclusions', 'aggregatorName', 'vals'].some(k => JSON.stringify(next[k]) !== JSON.stringify(before[k]))) {
    clearSelection();
  }
  if (next.rows.join('\0') !== before.rows.join('\0')) { state.collapseAll = false; }
  state.settings = next;
  // La première passe suit la construction : elle reflète les réglages reçus, sans les réenregistrer
  if (changed && !state.building) { scheduleSave(); }
  state.building = false;
  state.pvt = pvt;
  TCDConfig.sync(pvt);
  showResult();
}

function isConfigured(s) {
  return s.rows.length > 0 || s.cols.length > 0;
}

/** Affiche le tableau calculé par pivotUI, ou un message d'aide */
function showResult() {
  const s = state.settings;
  const pvt = state.pvt;
  const out = $id('output');
  state.aggLabel = pvt ? TCDAggregators.describe(pvt.aggregatorName, pvt.vals) : '';
  out.classList.remove('is-loading');

  if (!state.dataset.records.length) {
    renderSummary(s);
    return showMessage('table', 'La table source est vide', "Ajoutez des lignes dans la table liée à ce widget : le tableau croisé se mettra à jour automatiquement.");
  }
  if (!pvt || !isConfigured(s)) {
    renderSummary(s);
    if (state.configOpen) {
      return showMessage('grid', 'Construisez votre tableau', 'Glissez un champ dans « Lignes » ou « Colonnes », ou cliquez sur un champ pour choisir où le placer.');
    }
    return showMessage('grid', "Ce tableau croisé n'est pas encore configuré",
      'Pour le construire, cliquez sur « Ouvrir la configuration » dans le panneau de droite de Grist (onglet du widget).');
  }
  const table = out.querySelector('.pvtRendererArea > table.pvtTable');
  if (!table) {
    renderSummary(s);
    return showMessage('info', 'Impossible de calculer ce tableau', $(out).find('.pvtRendererArea').text());
  }
  out.classList.remove('is-message');
  out.querySelectorAll(':scope > .empty').forEach(n => n.remove());
  TCDRender.decorate(table, { aggLabel: state.aggLabel, rowTotals: s.rowTotals, colTotals: s.colTotals, rows: pvt.rows.length, cols: pvt.cols.length });
  TCDRender.stick(table);
  indexColumns(table);
  renderSummary(s);
}

function showMessage(icon, title, text, action) {
  const out = $id('output');
  out.classList.add('is-message');
  out.querySelectorAll(':scope > .empty').forEach(n => n.remove());
  out.append(el('div', { class: 'empty' },
    el('div', { class: 'empty-icon', html: Icons.svg(icon, 26) }),
    el('h3', {}, title),
    el('p', {}, text),
    action ? el('button', { type: 'button', class: 'btn btn-primary', onclick: action.onClick, html: Icons.svg('settings', 15) + `<span>${action.label}</span>` }) : null));
}

function renderSummary(s) {
  const box = $id('summary');
  const pvt = state.pvt;
  const parts = [];
  if (pvt && isConfigured(s)) {
    parts.push(el('span', { class: 'sum-agg' }, state.aggLabel));
    const dims = [pvt.rows.join(', '), pvt.cols.join(', ')].filter(Boolean);
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
  const filters = pvt ? Object.entries(pvt.exclusions || {}).filter(([, v]) => v.length) : [];
  const total = state.dataset ? state.dataset.records.length : 0;
  let shown = total;
  if (filters.length && state.pd) {
    shown = 0;
    state.pd.forEachMatchingRecord({}, () => { shown++; });
  }
  const meta = shown === total
    ? `${total.toLocaleString('fr-FR')} ligne${total > 1 ? 's' : ''}`
    : `${shown.toLocaleString('fr-FR')} / ${total.toLocaleString('fr-FR')} lignes`;
  parts.push(el('span', { class: 'sum-meta' }, meta));
  if (filters.length) {
    const btn = el('button', {
      type: 'button', class: 'sum-filters', 'aria-haspopup': 'true',
      html: Icons.svg('filter', 12) + `<span>${filters.length} filtre${filters.length > 1 ? 's' : ''}</span>`,
    });
    btn.addEventListener('click', () => {
      if (UI.isOpenFor(btn)) { return UI.closePopover(); }
      UI.openPopover(btn, el('div', { class: 'menu' },
        el('div', { class: 'menu-title' }, 'Filtres actifs'),
        el('div', { class: 'filter-list' }, filters.map(([a, v]) => TCDConfig.filterPill(a, v.length, true)))));
    });
    parts.push(btn);
  }
  box.replaceChildren(...parts);
  box.title = box.textContent;
}

// Cellules de valeurs : celles de subtotal.js (détail, sous-totaux, totaux)
const VALUE_CELLS = 'td.pvtVal, td.pvtTotal, td.pvtGrandTotal';
const isShown = td => td.style.display !== 'none' && td.offsetParent !== null;

// Colonnes indexées pour le surlignage en croix au survol
let colCells = new Map();
let hoverCol = null;
function indexColumns(table) {
  colCells = new Map();
  hoverCol = null;
  table.querySelectorAll('td.pvtVal[data-colnode]').forEach(td => {
    const j = td.dataset.colnode;
    if (!colCells.has(j)) { colCells.set(j, []); }
    colCells.get(j).push(td);
  });
}

// ---------------------------------------------------------------------------
// Interactions sur le tableau : survol, info-bulle, détail
// ---------------------------------------------------------------------------

/**
 * Valeur, critères et données d'une cellule, fournis par subtotal.js
 * (gestionnaire « tcd-info » déclaré dans les options de rendu).
 * @returns {{value: number, filters: Object, pivotData: Object}|null}
 */
function cellInfo(td) {
  const detail = {};
  td.dispatchEvent(new CustomEvent('tcd-info', { detail }));
  return detail.filters ? detail : null;
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
  const info = cellInfo(td);
  if (!info) { return; }
  const lines = Object.entries(info.filters).map(([a, v]) => el('div', { class: 'tt-line' }, el('span', {}, a), el('b', {}, String(v))));
  tooltip.replaceChildren(
    ...(lines.length ? lines : [el('div', { class: 'tt-line' }, el('span', {}, 'Ensemble des données'))]),
    el('div', { class: 'tt-value' }, el('span', {}, state.aggLabel), el('b', {}, td.textContent)),
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
    const td = e.target.closest('td.pvtVal[data-colnode]');
    setHoverCol(td ? td.dataset.colnode : null);
  });
  out.addEventListener('mousemove', e => {
    const td = e.target.closest(VALUE_CELLS);
    hideTooltip();
    if (!td || document.body.classList.contains('is-dragging')) { return; }
    tooltipTimer = setTimeout(() => showTooltip(td, e.clientX, e.clientY), 350);
  });
  out.addEventListener('mouseleave', () => { setHoverCol(null); hideTooltip(); });
  out.addEventListener('keydown', onTableKey);
  out.addEventListener('scroll', hideTooltip, { passive: true });
  out.addEventListener('click', e => {
    const td = e.target.closest(VALUE_CELLS);
    const info = td && cellInfo(td);
    if (info) { hideTooltip(); selectCell(info, td); }
    // Un groupe replié ou déplié par subtotal.js change la largeur des colonnes figées
    if (e.target.closest('th')) { requestAnimationFrame(restick); }
  });

  // Recalcule les en-têtes figés quand la taille change (panneau Grist ouvert, redimensionnement…)
  let raf = null;
  new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(restick);
  }).observe(out);
}

function restick() {
  const table = $id('output').querySelector('table.pvtTable');
  if (table) { TCDRender.stick(table); }
}

/** Replie (ou déplie) tous les groupes du premier niveau (option collapseRowsAt de subtotal.js) */
function setAllCollapsed(collapse) {
  state.collapseAll = collapse;
  refreshPivot();
}

/** Navigation au clavier : flèches entre les cellules, Entrée pour le détail */
function onTableKey(e) {
  const table = $id('output').querySelector('table.pvtTable');
  if (!table || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', ' ', 'Home', 'End'].includes(e.key)) { return; }
  const current = document.activeElement && document.activeElement.matches && document.activeElement.matches(VALUE_CELLS) ? document.activeElement : null;
  const cellsOf = tr => [...tr.querySelectorAll(VALUE_CELLS)].filter(isShown);
  if (!current) {
    if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      focusCell([...table.querySelectorAll(VALUE_CELLS)].find(isShown));
    }
    return;
  }
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    const info = cellInfo(current);
    if (info) { selectCell(info, current); }
    return;
  }
  e.preventDefault();
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

/** Colonnes utiles au détail : celles regroupées (lignes, colonnes) et celles calculées (valeurs) */
function detailFields() {
  const pvt = state.pvt;
  const byName = new Map(state.dataset.fields.map(f => [f.name, f]));
  const names = [...pvt.rows, ...pvt.cols, ...pvt.vals]
    .map(n => (byName.get(n) && byName.get(n).parent) || n)
    .filter((n, i, all) => byName.has(n) && all.indexOf(n) === i);
  return names.map(n => byName.get(n));
}

/**
 * Clic sur une cellule : met la cellule en évidence et transmet ses lignes aux widgets Grist liés
 * (« Sélectionner par » ce widget). Le panneau de détail s'ouvre si le réglage est actif.
 */
function selectCell(info, td) {
  const records = [];
  info.pivotData.forEachMatchingRecord(info.filters, rec => { records.push(rec); });
  if (selectedTd) { selectedTd.classList.remove('is-selected'); }
  selectedTd = td || null;
  if (td) { td.classList.add('is-selected'); }
  selectRows(records.map(r => r.id).filter(id => typeof id === 'number'));
  if (state.settings.clickDetail) { openDrawer(info, td, records); }
}

/** Panneau de détail d'une cellule */
function openDrawer(info, td, records) {
  $id('drawer-value').textContent = td.textContent || '—';
  $id('drawer-sub').textContent = `${state.aggLabel} · ${records.length.toLocaleString('fr-FR')} ligne${records.length > 1 ? 's' : ''}`;
  const entries = Object.entries(info.filters);
  $id('drawer-filters').replaceChildren(...(entries.length
    ? entries.map(([a, v]) => el('span', { class: 'crit' }, el('span', {}, a), el('b', {}, String(v))))
    : [el('span', { class: 'crit' }, el('b', {}, 'Toutes les lignes'))]));

  const LIMIT = 300;
  const fields = detailFields();
  const body = $id('drawer-body');
  body.replaceChildren(el('table', { class: 'detail-table' },
    el('thead', {}, el('tr', {}, fields.map(f => el('th', { class: f.type === 'number' ? 'num' : '' }, f.name)))),
    el('tbody', {}, records.slice(0, LIMIT).map(rec => el('tr', {}, fields.map(f => {
      const v = rec[f.name];
      return el('td', { class: (f.type === 'number' ? 'num' : '') + (v === TCDData.EMPTY ? ' is-empty' : '') },
        typeof v === 'number' ? TCDGrist.formatter(f.colId)(v) : String(v));
    }))))));
  if (records.length > LIMIT) {
    body.append(el('p', { class: 'hint' }, `Seules les ${LIMIT} premières lignes sont affichées.`));
  }

  $id('drawer').hidden = false;
  $id('drawer-backdrop').hidden = false;
  requestAnimationFrame(() => document.body.classList.add('drawer-open'));
  $id('drawer-close').focus({ preventScroll: true });
}

/** Ferme le panneau ; la cellule reste sélectionnée pour les widgets liés */
function closeDrawer() {
  if ($id('drawer').hidden) { return false; }
  document.body.classList.remove('drawer-open');
  setTimeout(() => { $id('drawer').hidden = true; $id('drawer-backdrop').hidden = true; }, 180);
  return true;
}

/** Désélectionne la cellule : les widgets liés affichent de nouveau toutes les lignes */
function clearSelection() {
  if (!selectedTd) { return; }
  selectedTd.classList.remove('is-selected');
  selectedTd = null;
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
    seg([['table', 'Tableau'], ['heat', 'Chaleur'], ['bars', 'Barres']], r.kind,
      v => TCDConfig.setRenderer(TCDConfig.rendererName(v, r.scope))),
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
  const header = [...pd.rowAttrs,
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
  // Recharge les formats et libellés : ils ont pu changer dans Grist depuis l'ouverture
  const before = TCDGrist.signature();
  Promise.resolve(grist.getSelectedTableId ? grist.getSelectedTableId() : null)
    .then(tableId => TCDGrist.load(tableId))
    .then(() => {
      if (TCDGrist.signature() !== before && state.rawRecords) {
        state.dataset = TCDData.prepare(state.rawRecords);
        build();
      }
    });
  if (!state.configOpen) {
    state.configOpen = true;
    state.snapshot = JSON.parse(JSON.stringify(state.settings));
  }
  closeDrawer();
  $id('config').hidden = false;
  document.body.classList.add('is-config');
  setSaveState(state.savePending ? 'saving' : 'saved');
  if (state.pvt) { showResult(); restick(); }
}

function closeConfig() {
  state.configOpen = false;
  state.snapshot = null;
  UI.closePopover();
  TCDConfig.closeFilters();
  $id('config').hidden = true;
  document.body.classList.remove('is-config');
  saveNow();
  if (state.pvt) { showResult(); restick(); }
}

function revert() {
  if (!state.snapshot) { return; }
  state.settings = normalizeSettings(JSON.parse(JSON.stringify(state.snapshot)));
  applyAppearance();
  scheduleSave();
  build();
  UI.toast('Modifications annulées.', 'info');
}

// ---------------------------------------------------------------------------
// Liaison avec Grist
// ---------------------------------------------------------------------------

const app = {
  settings: () => state.settings,
  fields: () => (state.dataset ? state.dataset.fields : []),
  update,
  refreshPivot,
  rendererOf,
  closeConfig,
  revert,
};

function handleOptions(options) {
  options = options || {};
  const incoming = normalizeSettings(options.settings, { columnSize: options.columnSize });
  const first = !state.optionsLoaded;
  state.optionsLoaded = true;
  // Ignore l'écho de nos propres enregistrements
  if (!first && (state.savePending || JSON.stringify(incoming) === JSON.stringify(state.settings))) { return; }
  state.settings = incoming;
  applyAppearance();
  build();
}

function start() {
  $id('btn-display').innerHTML = Icons.svg('sliders', 17);
  $id('btn-export').innerHTML = Icons.svg('download', 17);
  $id('drawer-close').innerHTML = Icons.svg('x', 18);
  $id('btn-display').addEventListener('click', e => openDisplayMenu(e.currentTarget));
  $id('btn-export').addEventListener('click', e => openExportMenu(e.currentTarget));
  $id('drawer-close').addEventListener('click', closeDrawer);
  $id('drawer-backdrop').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && $id('popover').hidden && !closeDrawer()) { clearSelection(); }
  });

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
  new MutationObserver(() => { if (state.pvt) { refreshPivot(); } }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-grist-appearance'] });

  grist.onOptions(handleOptions);
  // Si Grist n'envoie pas d'options (widget neuf), on affiche quand même
  setTimeout(() => { if (!state.optionsLoaded) { state.optionsLoaded = true; build(); } }, 1500);

  let columnsLoaded = null;
  grist.onRecords(async records => {
    // Formats et libellés des colonnes Grist (une fois, avant le premier affichage)
    if (!columnsLoaded) {
      columnsLoaded = Promise.resolve(grist.getSelectedTableId ? grist.getSelectedTableId() : null)
        .then(tableId => TCDGrist.load(tableId));
    }
    await columnsLoaded;
    state.rawRecords = records;
    state.dataset = TCDData.prepare(records);
    build();
  });
}

start();
