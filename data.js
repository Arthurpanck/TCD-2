/**
 * Préparation des données Grist pour pivotUI.
 * - Les champs portent le libellé de la colonne Grist (affiché tel quel par pivottable).
 * - Les valeurs Grist sont normalisées (listes, erreurs, booléens, valeurs vides).
 * - Les regroupements de dates (année, trimestre, mois) sont des `derivedAttributes`
 *   construits avec les dérivateurs de pivottable, triés avec `sortAs`.
 * Les réglages enregistrés gardent les identifiants de colonnes (toAttr / fromAttr).
 */
const TCDData = (function () {
  const EMPTY = '(vide)';
  const HIDDEN_FIELDS = new Set(['id', 'manualSort']);
  const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  const DERIVED_SEP = ' › ';
  const DERIVED = ['Année', 'Trimestre', 'Mois'];
  const { derivers, sortAs } = $.pivotUtilities;

  const asDate = v => (v instanceof Date && !isNaN(v.getTime()) ? v : null);

  function cellValue(v) {
    if (v === null || v === undefined || v === '') { return EMPTY; }
    if (typeof v === 'number' || typeof v === 'string') { return v; }
    if (typeof v === 'boolean') { return v ? 'Oui' : 'Non'; }
    if (Array.isArray(v)) {
      // Valeurs encodées Grist : ['L', ...] pour les listes de choix, ['E', ...] pour les erreurs
      if (v[0] === 'L') { return v.length > 1 ? v.slice(1).join(', ') : EMPTY; }
      if (v[0] === 'E') { return '#Erreur'; }
      return v.length ? v.join(', ') : EMPTY;
    }
    return String(v);
  }

  function detectType(rawRecords, name) {
    let numbers = 0, dates = 0, others = 0;
    for (const rec of rawRecords) {
      const v = rec[name];
      if (v === null || v === undefined || v === '') { continue; }
      if (typeof v === 'number') { numbers++; }
      else if (asDate(v)) { dates++; }
      else { others++; }
    }
    if (dates && dates >= numbers + others) { return 'date'; }
    if (numbers && !others && !dates) { return 'number'; }
    return 'text';
  }

  /**
   * Dérivateur appliqué uniquement aux dates d'origine : pivottable rappelle les dérivateurs sur
   * des enregistrements déjà dérivés, la valeur calculée au premier passage est alors conservée.
   */
  const fromDate = (attr, fn) => rec => {
    const v = rec[attr];
    if (v instanceof Date) { return fn(rec); }
    return v === null || v === undefined ? EMPTY : undefined;
  };

  /** Tri chronologique des dates « jj/mm/aaaa [hh:mm] » */
  function dayKey(s) {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})(?: (\d{2}):(\d{2}))?/.exec(s);
    return m ? +`${m[3]}${m[2]}${m[1]}${m[4] || '00'}${m[5] || '00'}` : Infinity;
  }
  const daySorter = (a, b) => dayKey(a) - dayKey(b) || (a < b ? -1 : a > b ? 1 : 0);

  const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });
  function frenchSort(a, b) {
    if (a === b) { return 0; }
    if (a === EMPTY) { return 1; }
    if (b === EMPTY) { return -1; }
    if (typeof a === 'number' && typeof b === 'number') { return a - b; }
    return collator.compare(String(a), String(b));
  }

  /**
   * @param {Array<Object>} rawRecords - enregistrements reçus de grist.onRecords
   * @returns {{records, fields, derivedAttributes, sorters, toAttr, fromAttr}}
   */
  function prepare(rawRecords) {
    rawRecords = rawRecords || [];
    const colIds = Object.keys(rawRecords[0] || {}).filter(n => !HIDDEN_FIELDS.has(n));

    // Nom affiché de chaque colonne : libellé Grist, sinon identifiant sans « _ » (unique)
    const names = new Map(), cols = new Map();
    for (const colId of colIds) {
      let name = TCDGrist.label(colId) || colId.replace(/_/g, ' ');
      if (cols.has(name) || name === 'id') { name = `${name} (${colId})`; }
      names.set(colId, name);
      cols.set(name, colId);
    }

    const fields = [];
    const derivedAttributes = {};
    const sorters = {};
    const dateCols = [];
    for (const colId of colIds) {
      const name = names.get(colId);
      const type = detectType(rawRecords, colId);
      fields.push({ name, colId, type });
      if (type !== 'date') { continue; }
      dateCols.push(colId);
      const [year, quarter, month] = DERIVED.map(d => name + DERIVED_SEP + d);
      fields.push(...[year, quarter, month].map(n => ({ name: n, colId, type: 'date', parent: name })));
      // Dérivés d'abord : ils lisent la date d'origine avant qu'elle ne soit remplacée par son libellé
      derivedAttributes[year] = fromDate(name, derivers.dateFormat(name, '%y', true));
      derivedAttributes[quarter] = fromDate(name, rec => `T${Math.floor(rec[name].getUTCMonth() / 3) + 1} ${rec[name].getUTCFullYear()}`);
      derivedAttributes[month] = fromDate(name, derivers.dateFormat(name, '%n %y', true, MONTHS));
      const withTime = rawRecords.some(r => { const d = asDate(r[colId]); return d && (d.getUTCHours() || d.getUTCMinutes()); });
      derivedAttributes[name] = fromDate(name, derivers.dateFormat(name, withTime ? '%d/%m/%y %H:%M' : '%d/%m/%y', true));
      sorters[name] = daySorter;
    }

    const records = new Array(rawRecords.length);
    const years = new Set();
    for (let i = 0; i < rawRecords.length; i++) {
      const src = rawRecords[i];
      const rec = { id: src.id };
      for (const colId of colIds) {
        const v = src[colId];
        if (dateCols.includes(colId)) {
          const d = asDate(v);
          rec[names.get(colId)] = d;
          if (d) { years.add(d.getUTCFullYear()); }
        } else {
          rec[names.get(colId)] = cellValue(v);
        }
      }
      records[i] = rec;
    }

    // Ordre chronologique des mois et trimestres (sortAs de pivottable)
    const yearList = [...years].sort((a, b) => a - b);
    const monthOrder = yearList.flatMap(y => MONTHS.map(m => `${m} ${y}`));
    const quarterOrder = yearList.flatMap(y => [1, 2, 3, 4].map(q => `T${q} ${y}`));
    for (const colId of dateCols) {
      const name = names.get(colId);
      sorters[name + DERIVED_SEP + 'Mois'] = sortAs(monthOrder);
      sorters[name + DERIVED_SEP + 'Trimestre'] = sortAs(quarterOrder);
    }

    // Autres champs : ordre français (accents, nombres dans le texte), valeurs vides en dernier
    for (const f of fields) { if (!sorters[f.name]) { sorters[f.name] = frenchSort; } }

    /** Identifiant enregistré (colonne ou « colonne › Année ») → nom affiché */
    const toAttr = key => {
      const [colId, ...suffix] = String(key).split(DERIVED_SEP);
      return names.has(colId) ? [names.get(colId), ...suffix].join(DERIVED_SEP) : null;
    };
    /** Nom affiché → identifiant enregistré */
    const fromAttr = name => {
      const field = fields.find(f => f.name === name);
      if (!field) { return name; }
      return field.parent ? field.colId + DERIVED_SEP + name.split(DERIVED_SEP).pop() : field.colId;
    };

    return { records, fields, derivedAttributes, sorters, toAttr, fromAttr };
  }

  return { EMPTY, prepare };
})();
