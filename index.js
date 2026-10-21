/**
 * Widget Tableau croisé dynamique pour Grist.
 * - pivotUI (pivottable.js) gère la configuration et le calcul ; subtotal.js le rendu (sous-totaux repliables)
 * - Vue consultation par défaut : seul le tableau est visible
 * - Configuration ouverte via le bouton « Ouvrir la configuration » du panneau Grist (onEditOptions)
 * - Réglages enregistrés dans les options du widget (clé `settings`, compatible avec les versions précédentes)
 */
const { el, $id } = UI;

const DEFAULTS = {
  title: '',
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
  density: 'standard',
  fontScale: 1,
  // Arrondi des valeurs (nombre de décimales), null : celui de la colonne dans Grist
  decimals: null,
};
// Réglages des versions précédentes qui n'existent plus (graphique, échelle, suffixe, couleur d'accent)
// (clickDetail : le panneau de détail a laissé place au seul filtrage des vues liées)
const OBSOLETE = ['chartType', 'scale', 'suffix', 'accent', 'clickDetail'];
const MAX_DECIMALS = 3;
// Nombre de lignes affichées avant le bouton « Afficher les lignes restantes »
const ROW_LIMIT = 1500;
const MENU_LIMIT = 1000;
const ORDERS = ['key_a_to_z', 'value_a_to_z', 'value_z_to_a'];

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
  // État d'affichage propre à la session (non enregistré) : groupes repliés, lignes affichées, case sélectionnée
  collapsed: { rows: [], cols: [] },
  rowLimit: ROW_LIMIT,
  selection: null,
  selectionCount: 0,
  // Au-delà, pivotUI ne construit pas la liste de filtre d'un champ (coûteux) : elle est construite à la demande
  menuLimit: MENU_LIMIT,
  aggLabel: '',
  building: false,
  saveTimer: null,
  savePending: false,
  saveErrorShown: false,
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
  s.title = typeof s.title === 'string' ? s.title.slice(0, 200) : '';
  s.aggregatorName = TCDAggregators.normalizeName(s.aggregatorName);
  s.rendererName = TCDRender.normalizeName(s.rendererName);
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
  OBSOLETE.forEach(k => { delete s[k]; });
  // Ancien réglage « Taille colonnes » (0.25x → 1.0x) converti en densité
  if ((!raw || raw.density === undefined) && legacy.columnSize) {
    s.density = parseFloat(legacy.columnSize) < 0.75 ? 'compact' : 'standard';
  }
  if (!TCDRender.DENSITIES.some(([d]) => d === s.density)) { s.density = DEFAULTS.density; }
  s.fontScale = Math.min(1.4, Math.max(0.8, Number(s.fontScale) || 1));
  // Arrondi : nombre de décimales ; « auto » et les valeurs vides des anciennes versions : celui de Grist
  const d = s.decimals === null || s.decimals === '' || s.decimals === 'auto' ? NaN : Number(s.decimals);
  s.decimals = Number.isInteger(d) && d >= 0 ? Math.min(d, MAX_DECIMALS) : null;
  return s;
}

/** Réglages modifiés depuis le panneau (hors pivotUI) */
function update(patch) {
  state.settings = normalizeSettings({ ...state.settings, ...patch });
  applyAppearance();
  scheduleSave();
  if (['subtotals', 'rowTotals', 'colTotals', 'decimals'].some(k => k in patch)) { refreshPivot(); return; }
  if ('title' in patch) { applyTitle(); renderSummary(state.settings); }
  if (state.pvt) { TCDConfig.sync(state.pvt); }
  if ('density' in patch || 'fontScale' in patch) { requestAnimationFrame(restick); }
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
    // Cas attendu pour un utilisateur sans droit d'édition : on prévient une fois, sans erreur
    console.warn('Enregistrement impossible :', e.message || e);
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

/**
 * Titre choisi par l'utilisateur : affiché dans la barre de résumé, et légende (caption) du tableau,
 * masquée à l'écran mais lue par les lecteurs d'écran (variante fr-table--no-caption du DSFR)
 */
function applyTitle() {
  const out = $id('output');
  const title = state.settings.title.trim();
  const table = out.querySelector('table.pvtTable');
  if (!table) { return; }
  let caption = table.querySelector(':scope > caption');
  if (!title) { if (caption) { caption.remove(); } return; }
  if (!caption) { caption = table.insertBefore(document.createElement('caption'), table.firstChild); }
  caption.textContent = title;
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
    aggregators: TCDAggregators.forUI(name => ds.fromAttr(name).split(' › ')[0], () => state.settings.decimals),
    renderers: TCDRender.renderers({ onPivotData: pd => { state.pd = pd; }, options: rendererOptions }),
    derivedAttributes: ds.derivedAttributes,
    sorters: ds.sorters,
    hiddenAttributes: ['id'],
    menuLimit: state.menuLimit,
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
  const before = state.settings;
  // Champs absents des données reçues (table vide, liste filtrée par un widget lié, colonne masquée) :
  // pivotUI ne les connaît pas, mais ils restent dans les réglages pour revenir avec les données
  const absent = key => !ds.toAttr(key);
  const exclusions = Object.fromEntries(Object.entries(before.exclusions).filter(([k]) => absent(k)));
  for (const [k, v] of Object.entries(pvt.exclusions || {})) { exclusions[ds.fromAttr(k)] = v.map(String); }
  const patch = {
    rows: [...pvt.rows.map(ds.fromAttr), ...before.rows.filter(absent)],
    cols: [...pvt.cols.map(ds.fromAttr), ...before.cols.filter(absent)],
    vals: pvt.vals.length ? pvt.vals.map(ds.fromAttr) : before.vals.filter(absent),
    aggregatorName: pvt.aggregatorName,
    rendererName: pvt.rendererName,
    rowOrder: pvt.rowOrder,
    colOrder: pvt.colOrder,
    exclusions,
  };
  const next = normalizeSettings({ ...before, ...patch });
  const changed = JSON.stringify(next) !== JSON.stringify(before);
  if (changed && ['rows', 'cols', 'exclusions', 'aggregatorName', 'vals'].some(k => JSON.stringify(next[k]) !== JSON.stringify(before[k]))) {
    clearSelection();
  }
  if (next.rows.join('\0') !== before.rows.join('\0') || next.cols.join('\0') !== before.cols.join('\0')) {
    state.collapsed = { rows: [], cols: [] };
    state.rowLimit = ROW_LIMIT;
  }
  state.settings = next;
  // La première passe suit la construction : elle reflète les réglages reçus, sans les réenregistrer
  if (changed && !state.building) { scheduleSave(); }
  state.building = false;
  state.pvt = pvt;
  TCDConfig.sync(pvt);
  showResult();
}

/** Tableau construit : au moins un champ en lignes ou en colonnes parmi ceux des données reçues */
const isConfigured = pvt => Boolean(pvt) && (pvt.rows.length > 0 || pvt.cols.length > 0);

/** Affiche le tableau calculé par pivotUI, ou un message d'aide */
function showResult() {
  const s = state.settings;
  const pvt = state.pvt;
  const out = $id('output');
  state.aggLabel = pvt ? TCDAggregators.describe(pvt.aggregatorName, pvt.vals) : '';
  out.classList.remove('is-loading');

  if (!state.dataset.records.length) {
    renderSummary(s);
    return showMessage('fr-icon-table-line', 'La table source est vide', "Ajoutez des lignes dans la table liée à ce widget : le tableau croisé se mettra à jour automatiquement.");
  }
  if (!isConfigured(pvt)) {
    renderSummary(s);
    if (state.configOpen) {
      return showMessage('fr-icon-layout-grid-line', 'Construisez votre tableau', 'Glissez un champ dans « Lignes » ou « Colonnes », ou cliquez sur un champ pour choisir où le placer.');
    }
    return showMessage('fr-icon-layout-grid-line', "Ce tableau croisé n'est pas encore configuré",
      'Pour le construire, cliquez sur « Ouvrir la configuration » dans le panneau de droite de Grist (onglet du widget).');
  }
  if (out.querySelector('.pvtRendererArea > .tcd-no-data')) {
    renderSummary(s);
    return showMessage('fr-icon-filter-line', 'Aucune ligne ne correspond aux filtres',
      'Modifiez ou supprimez les filtres (bouton « filtres » de la barre ci-dessus, ou dans la configuration).');
  }
  const table = out.querySelector('.pvtRendererArea > table.pvtTable');
  if (!table) {
    renderSummary(s);
    return showMessage('fr-icon-information-line', 'Impossible de calculer ce tableau', $(out).find('.pvtRendererArea').text());
  }
  out.classList.remove('is-message');
  out.querySelectorAll(':scope > .empty').forEach(n => n.remove());
  TCDRender.decorate(table, { aggLabel: state.aggLabel, rowTotals: s.rowTotals, colTotals: s.colTotals, subtotals: s.subtotals, rows: pvt.rows.length, cols: pvt.cols.length });
  applyTitle();
  if (table.dataset.styleSkipped) { UI.toast('Tableau trop grand : la carte de chaleur et les barres sont désactivées.', 'info'); }
  restoreCollapsed(table);
  applyRowLimit(table);
  TCDRender.stick(table);
  indexColumns(table);
  restoreSelection(table);
  renderSummary(s);
}

function showMessage(icon, title, text) {
  const out = $id('output');
  out.classList.add('is-message');
  out.querySelectorAll(':scope > .empty').forEach(n => n.remove());
  out.append(el('div', { class: 'empty' },
    el('div', { class: `fr-callout ${icon}` },
      el('h3', { class: 'fr-callout__title fr-h6' }, title),
      text ? el('p', { class: 'fr-callout__text fr-text--md' }, text) : null)));
}

function renderSummary(s) {
  const box = $id('summary');
  const pvt = state.pvt;
  const parts = [];
  if (isConfigured(pvt)) {
    const dims = [pvt.rows.join(', '), pvt.cols.join(', ')].filter(Boolean);
    const title = s.title.trim();
    if (title) {
      // Le titre remplace la description automatique, gardée en info-bulle
      parts.push(el('span', { class: 'sum-agg', title: [state.aggLabel, dims.join(' × ')].filter(Boolean).join(' par ') }, title));
    } else {
      parts.push(el('span', { class: 'sum-agg' }, state.aggLabel));
      if (dims.length) {
        parts.push(el('span', { class: 'sum-sep' }, 'par'));
        dims.forEach((d, i) => {
          if (i) { parts.push(el('span', { class: 'sum-x' }, '×')); }
          parts.push(el('span', { class: 'sum-dim' }, d));
        });
      }
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
  parts.push(el('span', { class: 'sum-meta fr-badge fr-badge--sm' }, meta));
  if (filters.length) {
    const btn = el('button', {
      type: 'button', class: 'sum-filters fr-tag fr-tag--sm fr-tag--icon-left fr-icon-filter-line', 'aria-haspopup': 'true',
    }, `${filters.length} filtre${filters.length > 1 ? 's' : ''}`);
    btn.addEventListener('click', () => {
      if (UI.isOpenFor(btn)) { return UI.closePopover(); }
      UI.openPopover(btn, el('div', { class: 'menu' },
        el('div', { class: 'menu-title' }, 'Filtres actifs'),
        el('div', { class: 'filter-list' }, filters.map(([a, v]) => TCDConfig.filterPill(a, v.length, true)))));
    });
    parts.push(btn);
  }
  if (state.selection) {
    const criteria = Object.values(JSON.parse(state.selection));
    const n = state.selectionCount;
    const text = `Sélection : ${criteria.length ? criteria.join(' · ') : 'tout'} — ${n.toLocaleString('fr-FR')} ligne${n > 1 ? 's' : ''}`;
    // Tag supprimable du DSFR : un clic désélectionne
    parts.push(el('button', {
      type: 'button', class: 'sum-selection fr-tag fr-tag--sm fr-tag--dismiss',
      title: 'Lignes envoyées aux widgets Grist liés à ce tableau. Cliquer pour désélectionner (Échap).',
      'aria-label': `Retirer la sélection ${criteria.join(' · ')}`, onclick: clearSelection,
    }, el('span', { class: 'sum-selection-text' }, text)));
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
// Interactions sur le tableau : survol, info-bulle, sélection
// ---------------------------------------------------------------------------

/**
 * Valeur, critères et données d'une cellule, fournis par subtotal.js
 * (gestionnaire « tcd-info » déclaré dans les options de rendu).
 * @returns {{value: number, filters: Object, pivotData: Object}|null}
 */
function cellInfo(td) {
  const detail = {};
  td.dispatchEvent(new CustomEvent('tcd-info', { detail }));
  if (detail.filters) { return detail; }
  // subtotal.js ne pose pas de gestionnaire sur les cases « Total » des lignes : critères de la ligne
  const path = td.classList.contains('rowTotal') && rowPath(td.parentElement);
  if (!path || !state.pd) { return null; }
  const filters = {};
  path.forEach((v, i) => { filters[state.pd.rowAttrs[i]] = v; });
  return { value: parseFloat(td.dataset.value), filters, pivotData: state.pd };
}

// Chemin (valeurs typées des champs en lignes) de chaque ligne du tableau, calculé une fois par rendu
let rowPaths = new WeakMap();
let rowPathsTable = null;

/** Chemin d'une ligne : libellés des groupes qui la couvrent, retrouvés avec leur type d'origine */
function rowPath(tr) {
  const table = tr.closest('table');
  if (table !== rowPathsTable) {
    rowPathsTable = table;
    indexRowPaths(table);
  }
  return rowPaths.get(tr) || null;
}

function indexRowPaths(table) {
  rowPaths = new WeakMap();
  const pd = state.pd;
  if (!pd || !pd.rowAttrs.length) { return; }
  // Valeur d'origine (nombre ou texte) de chaque libellé, par niveau
  const typed = pd.rowAttrs.map(() => new Map());
  for (const key of pd.getRowKeys()) { key.forEach((v, i) => typed[i].set(String(v), v)); }
  const current = [];
  for (const tr of table.tBodies[0].rows) {
    const labels = tr.querySelectorAll(':scope > th.pvtRowLabel');
    if (!labels.length) { continue; }
    let level = 0;
    labels.forEach(th => {
      level = Number([...th.classList].find(c => /^rowcol\d+$/.test(c)).slice(6));
      current[level] = typed[level].get(TCDRender.headerText(th));
    });
    current.length = level + 1;
    rowPaths.set(tr, current.slice());
  }
}

const tooltip = $id('tooltip');
let tooltipTimer = null;

function setHoverCol(key) {
  if (hoverCol === key) { return; }
  if (hoverCol !== null) { (colCells.get(hoverCol) || []).forEach(td => td.classList.remove('is-col-hover')); }
  hoverCol = key;
  if (key !== null) { (colCells.get(key) || []).forEach(td => td.classList.add('is-col-hover')); }
}

/** Info-bulle du DSFR (fr-tooltip), au-dessus de la case ou en dessous faute de place, flèche sur la case */
function showTooltip(td) {
  const info = cellInfo(td);
  if (!info) { return; }
  const lines = Object.entries(info.filters).map(([a, v]) => el('div', { class: 'tt-line' }, el('span', {}, a), el('b', {}, String(v))));
  tooltip.replaceChildren(
    ...(lines.length ? lines : [el('div', { class: 'tt-line' }, el('span', {}, 'Ensemble des données'))]),
    el('div', { class: 'tt-value' }, el('span', {}, state.aggLabel), el('b', {}, td.textContent)),
    el('div', { class: 'tt-hint' }, td.classList.contains('is-selected') ? 'Cliquez pour tout réafficher dans les vues liées' : 'Cliquez pour filtrer les vues liées'));
  const r = td.getBoundingClientRect();
  tooltip.className = 'tooltip fr-tooltip fr-placement fr-placement--top fr-tooltip--shown';
  tooltip.hidden = false;
  const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
  const below = r.top - th < 8;
  tooltip.classList.toggle('fr-placement--top', !below);
  tooltip.classList.toggle('fr-placement--bottom', below);
  const center = r.left + r.width / 2;
  const left = Math.max(8, Math.min(center - tw / 2, window.innerWidth - tw - 8));
  tooltip.style.setProperty('--arrow-x', (center - left - tw / 2) + 'px');
  tooltip.style.left = left + 'px';
  tooltip.style.top = (below ? r.bottom : r.top - th) + 'px';
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
    tooltipTimer = setTimeout(() => showTooltip(td), 350);
  });
  out.addEventListener('mouseleave', () => { setHoverCol(null); hideTooltip(); });
  out.addEventListener('keydown', onTableKey);
  // La zone qui défile est le conteneur du tableau DSFR (fr-table__container)
  out.addEventListener('scroll', hideTooltip, { passive: true, capture: true });
  out.addEventListener('click', e => {
    if (e.target.closest('.show-more')) { return showAllRows(); }
    const td = e.target.closest(VALUE_CELLS);
    const info = td && cellInfo(td);
    if (info) { hideTooltip(); selectCell(info, td); }
    // Groupe replié ou déplié par subtotal.js : on mémorise l'état et on recale les colonnes figées
    if (e.target.closest('th') && e.isTrusted) {
      requestAnimationFrame(() => {
        const table = out.querySelector('table.pvtTable');
        if (table) { saveCollapsed(table); TCDRender.stick(table); }
      });
    }
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

// ---------------------------------------------------------------------------
// Groupes repliés : subtotal.js repart tout déplié à chaque calcul, on rejoue les replis mémorisés
// ---------------------------------------------------------------------------

/** Clé d'un groupe en lignes : son chemin */
function rowGroupKey(th) {
  const path = rowPath(th.parentElement);
  return path ? JSON.stringify(path) : null;
}

/** Clé d'un groupe en colonnes : critères de son total de colonne */
function colGroupKey(th, table) {
  const td = table.querySelector(`td.colTotal[data-colnode="${th.dataset.colnode}"]`);
  const info = td && cellInfo(td);
  return info ? JSON.stringify(info.filters) : null;
}

function saveCollapsed(table) {
  state.collapsed = {
    rows: [...table.querySelectorAll('tbody th.pvtRowLabel.rowcollapsed')].map(rowGroupKey).filter(Boolean),
    cols: [...table.querySelectorAll('thead th.pvtColLabel.colcollapsed')].map(th => colGroupKey(th, table)).filter(Boolean),
  };
}

function restoreCollapsed(table) {
  const rows = new Set(state.collapsed.rows), cols = new Set(state.collapsed.cols);
  if (rows.size) {
    table.querySelectorAll('tbody th.pvtRowLabel.rowexpanded').forEach(th => { if (rows.has(rowGroupKey(th))) { th.click(); } });
  }
  if (cols.size) {
    table.querySelectorAll('thead th.pvtColLabel.colexpanded').forEach(th => { if (cols.has(colGroupKey(th, table))) { th.click(); } });
  }
}

// ---------------------------------------------------------------------------
// Limite d'affichage : au-delà de ROW_LIMIT lignes, les suivantes sont masquées jusqu'à demande
// ---------------------------------------------------------------------------

function applyRowLimit(table) {
  const rows = [...table.tBodies[0].rows].filter(tr => !tr.querySelector('th.pvtTotalLabel.colTotal'));
  if (rows.length <= state.rowLimit) { return; }
  rows.slice(state.rowLimit).forEach(tr => tr.classList.add('tcd-over'));
  rows[state.rowLimit].before(el('tr', { class: 'tcd-more' }, el('td', { colspan: 1000 },
    el('button', { type: 'button', class: 'fr-btn fr-btn--secondary fr-btn--sm show-more' },
      `Afficher les ${(rows.length - state.rowLimit).toLocaleString('fr-FR')} lignes restantes`))));
}

function showAllRows() {
  state.rowLimit = Infinity;
  const table = $id('output').querySelector('table.pvtTable');
  table.querySelectorAll('tr.tcd-over').forEach(tr => tr.classList.remove('tcd-over'));
  table.querySelectorAll('tr.tcd-more').forEach(tr => tr.remove());
  restick();
}

/** Navigation au clavier : flèches entre les cellules, Entrée pour sélectionner */
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
  showTooltip(td);
}

// ---------------------------------------------------------------------------
// Sélection : comme un point sur le widget Carte, la case cliquée filtre les vues liées
// (« Sélectionner par » ce widget). Elle est conservée d'un calcul à l'autre.
// ---------------------------------------------------------------------------

function selectCell(info, td) {
  const key = JSON.stringify(info.filters);
  // Second clic sur la même case : les vues liées réaffichent toutes les lignes
  if (state.selection === key) { return clearSelection(); }
  state.selection = key;
  markSelected(td);
  sendSelection(info);
}

function markSelected(td) {
  $id('output').querySelectorAll('td.is-selected').forEach(c => c.classList.remove('is-selected'));
  if (td) { td.classList.add('is-selected'); }
}

/** Transmet aux vues liées les lignes de la case (identifiants Grist des enregistrements) */
function sendSelection(info) {
  const ids = [];
  info.pivotData.forEachMatchingRecord(info.filters, rec => { if (typeof rec.id === 'number') { ids.push(rec.id); } });
  state.selectionCount = ids.length;
  selectRows(ids);
  renderSummary(state.settings);
}

/** Après un calcul : retrouve la case sélectionnée et renvoie ses lignes (les données ont pu changer) */
function restoreSelection(table) {
  if (!state.selection) { return; }
  for (const td of table.querySelectorAll(VALUE_CELLS)) {
    const info = cellInfo(td);
    if (info && JSON.stringify(info.filters) === state.selection) {
      markSelected(td);
      sendSelection(info);
      return;
    }
  }
  clearSelection();
}

/** Désélectionne : les widgets liés affichent de nouveau toutes les lignes */
function clearSelection() {
  if (!state.selection) { return; }
  state.selection = null;
  markSelected(null);
  selectRows(null);
  renderSummary(state.settings);
}

function selectRows(ids) {
  try {
    if (typeof grist.setSelectedRows === 'function') {
      Promise.resolve(grist.setSelectedRows(ids)).catch(() => {});
    }
  } catch (e) { /* widget non lié : rien à faire */ }
}

// ---------------------------------------------------------------------------
// Barre de consultation : export
// ---------------------------------------------------------------------------

/** Ce que les exports doivent savoir du tableau affiché */
function exportContext() {
  const pvt = state.pvt;
  const ds = state.dataset;
  const f = TCDAggregators.formatOf(pvt.aggregatorName, pvt.vals, name => ds.fromAttr(name).split(' › ')[0]);
  const filters = Object.entries(pvt.exclusions || {}).filter(([, v]) => v.length)
    .map(([a, v]) => `${a} sans ${v.slice(0, 5).join(', ')}${v.length > 5 ? '…' : ''}`);
  return {
    pd: state.pd,
    settings: state.settings,
    aggLabel: state.aggLabel,
    title: state.settings.title.trim() || ($id('summary').querySelector('.sum-agg') ? [...$id('summary').querySelectorAll('.sum-agg, .sum-sep, .sum-dim, .sum-x')].map(n => n.textContent).join(' ') : state.aggLabel),
    filters: filters.length ? 'Filtres : ' + filters.join(' ; ') : '',
    numFmt: TCDAggregators.excelFormatOf(f, state.settings.decimals),
    collapsed: state.collapsed.rows,
    renderer: TCDRender.kindOf(state.settings.rendererName),
    accent: TCDRender.themeRgb('--background-action-high-blue-france'),
  };
}

async function exportXlsx() {
  UI.toast('Préparation du classeur Excel…', 'info');
  try {
    await TCDExport.xlsx(exportContext());
  } catch (e) {
    console.error(e);
    UI.toast("Export Excel impossible (bibliothèque non chargée). Utilisez l'export CSV.", 'error');
  }
}

function openExportMenu(anchor) {
  if (UI.isOpenFor(anchor)) { return UI.closePopover(); }
  if (!state.pd) { return UI.toast("Rien à exporter : configurez d'abord le tableau.", 'info'); }
  UI.openPopover(anchor, UI.menu([
    { icon: 'fr-icon-file-download-line', label: 'Excel mis en forme (.xlsx)', onClick: exportXlsx },
    { icon: 'fr-icon-download-line', label: 'CSV, données brutes', onClick: () => TCDExport.csv(exportContext()) },
    { icon: 'fr-icon-clipboard-line', label: 'Copier (données brutes)', onClick: () => TCDExport.copy(exportContext()).then(() => UI.toast('Tableau copié : collez-le dans un tableur ou un courriel.', 'success')) },
  ], 'Exporter le tableau'), { align: 'end' });
}

// ---------------------------------------------------------------------------
// Ouverture / fermeture de la configuration
// ---------------------------------------------------------------------------

function openConfig() {
  // Recharge les formats et libellés : ils ont pu changer dans Grist depuis l'ouverture
  const before = TCDGrist.signature();
  loadColumns().then(() => {
    if (TCDGrist.signature() !== before && state.rawRecords) { loadRecords(state.rawRecords); }
  });
  if (!state.configOpen) {
    state.configOpen = true;
    state.snapshot = JSON.parse(JSON.stringify(state.settings));
  }
  $id('config').hidden = false;
  document.body.classList.add('is-config');
  setSaveState(state.savePending ? 'saving' : 'saved');
  if (state.pvt) { showResult(); restick(); }
}

function closeConfig() {
  closePreview();
  state.configOpen = false;
  state.snapshot = null;
  UI.closePopover();
  TCDConfig.closeFilters();
  $id('config').hidden = true;
  document.body.classList.remove('is-config');
  saveNow();
  if (state.pvt) { showResult(); restick(); }
}

// Aperçu pendant la configuration : la barre de résumé et le tableau passent dans une modale du DSFR
// (ouverte sans le JavaScript du DSFR : classe fr-modal--opened), puis reprennent leur place
const previewOpen = () => document.body.classList.contains('is-preview');

function openPreview() {
  $id('preview-content').append($id('viewbar'), $id('stage'));
  $id('preview').setAttribute('open', '');
  $id('preview').classList.add('fr-modal--opened');
  document.body.classList.add('is-preview');
  $id('preview-close').focus();
}

function closePreview() {
  if (!previewOpen()) { return; }
  UI.closePopover();
  hideTooltip();
  const dialog = $id('preview');
  dialog.classList.remove('fr-modal--opened');
  dialog.removeAttribute('open');
  document.body.classList.remove('is-preview');
  dialog.before($id('viewbar'), $id('stage'));
  if (state.configOpen) { $id('cfg-preview').focus(); }
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

/** Formats et libellés des colonnes de la table liée (accès complet uniquement) */
function loadColumns() {
  return Promise.resolve(grist.getSelectedTableId ? grist.getSelectedTableId() : null).then(tableId => TCDGrist.load(tableId));
}

function loadRecords(records) {
  state.rawRecords = records;
  state.dataset = TCDData.prepare(records);
  build();
}

/** Construit les listes de filtre de tous les champs, même très longues, puis rouvre celle demandée */
function showAllFilterValues(attr) {
  state.menuLimit = Infinity;
  build();
  TCDConfig.openFilter(attr);
}

const app = {
  showAllFilterValues,
  settings: () => state.settings,
  fields: () => (state.dataset ? state.dataset.fields : []),
  update,
  refreshPivot,
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
  $id('btn-export').addEventListener('click', e => openExportMenu(e.currentTarget));
  $id('cfg-preview').addEventListener('click', openPreview);
  $id('preview-close').addEventListener('click', closePreview);
  $id('preview').addEventListener('mousedown', e => { if (e.target === e.currentTarget) { closePreview(); } });
  // Échap ferme ce qui est ouvert, du plus proche au plus lointain : menu, fenêtre de filtre, aperçu ;
  // sinon il désélectionne la case
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') { return; }
    if (!$id('popover').hidden) { UI.closePopover(); }
    else if (TCDConfig.closeFilters()) { /* fenêtre de filtre fermée */ }
    else if (previewOpen()) { closePreview(); }
    else { clearSelection(); }
  });

  showMessage('fr-icon-table-line', 'Chargement des données…', '');
  $id('output').classList.add('is-loading');

  TCDConfig.init(app);
  applyAppearance();
  setupTableInteractions();

  grist.ready({
    requiredAccess: 'read table',
    allowSelectBy: true,
    onEditOptions: openConfig,
  });

  // Thème clair/sombre de Grist (ou, hors de Grist, celui du système) appliqué au DSFR ;
  // les couleurs calculées de la carte de chaleur sont alors rafraîchies
  const dark = window.matchMedia('(prefers-color-scheme: dark)');
  const syncTheme = () => {
    const grist = document.documentElement.getAttribute('data-grist-appearance');
    const theme = grist ? (grist === 'dark' ? 'dark' : 'light') : (dark.matches ? 'dark' : 'light');
    if (document.documentElement.getAttribute('data-fr-theme') !== theme) {
      document.documentElement.setAttribute('data-fr-theme', theme);
      if (state.pvt) { refreshPivot(); }
    }
  };
  syncTheme();
  dark.addEventListener('change', syncTheme);
  new MutationObserver(syncTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-grist-appearance'] });

  grist.onOptions(handleOptions);
  // Si Grist n'envoie pas d'options (widget neuf), on affiche quand même
  setTimeout(() => { if (!state.optionsLoaded) { state.optionsLoaded = true; build(); } }, 1500);

  let columnsLoaded = null;
  grist.onRecords(async records => {
    // Formats et libellés des colonnes Grist (une fois, avant le premier affichage)
    columnsLoaded = columnsLoaded || loadColumns();
    await columnsLoaded;
    loadRecords(records);
  });
}

start();
