/**
 * Préparation des données Grist pour le moteur pivottable :
 * - détection du type de chaque champ (nombre, date, texte)
 * - normalisation des valeurs (dates lisibles, listes, valeurs vides, booléens)
 * - champs dérivés pour les dates (année, trimestre, mois)
 * - clés de tri pour que les dates et les mois se trient chronologiquement
 */
const TCDData = (function () {
  const EMPTY = '(vide)';
  const HIDDEN_FIELDS = new Set(['id', 'manualSort']);
  const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  const DERIVED_SEP = ' › ';

  const pad = n => String(n).padStart(2, '0');
  const asDate = v => (v instanceof Date && !isNaN(v.getTime()) ? v : null);

  function formatDate(d) {
    const date = `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
    if (d.getUTCHours() || d.getUTCMinutes()) {
      return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    return date;
  }

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
   * @param {Array<Object>} rawRecords - enregistrements reçus de grist.onRecords
   * @returns {{records: Array<Object>, fields: Array<Object>, sortKeys: Object<string, Map>}}
   */
  function prepare(rawRecords) {
    rawRecords = rawRecords || [];
    const names = Object.keys(rawRecords[0] || {}).filter(n => !HIDDEN_FIELDS.has(n));
    const fields = [];
    const sortKeys = {};
    const setKey = (attr, label, key) => {
      const m = sortKeys[attr] || (sortKeys[attr] = new Map());
      if (!m.has(label)) { m.set(label, key); }
    };

    for (const name of names) {
      const type = detectType(rawRecords, name);
      fields.push({ name, type });
      if (type === 'date') {
        fields.push({ name: name + DERIVED_SEP + 'Année', type: 'date', parent: name });
        fields.push({ name: name + DERIVED_SEP + 'Trimestre', type: 'date', parent: name });
        fields.push({ name: name + DERIVED_SEP + 'Mois', type: 'date', parent: name });
      }
    }

    const records = new Array(rawRecords.length);
    for (let i = 0; i < rawRecords.length; i++) {
      const src = rawRecords[i];
      const rec = { id: src.id };
      for (const f of fields) {
        if (f.parent) { continue; }
        const v = src[f.name];
        if (f.type !== 'date') {
          rec[f.name] = cellValue(v);
          continue;
        }
        const d = asDate(v);
        const yearAttr = f.name + DERIVED_SEP + 'Année';
        const quarterAttr = f.name + DERIVED_SEP + 'Trimestre';
        const monthAttr = f.name + DERIVED_SEP + 'Mois';
        if (!d) {
          rec[f.name] = rec[yearAttr] = rec[quarterAttr] = rec[monthAttr] = EMPTY;
          continue;
        }
        const y = d.getUTCFullYear(), m = d.getUTCMonth(), q = Math.floor(m / 3) + 1;
        const label = formatDate(d);
        rec[f.name] = label;
        setKey(f.name, label, d.getTime());
        rec[yearAttr] = y;
        const quarter = `T${q} ${y}`;
        rec[quarterAttr] = quarter;
        setKey(quarterAttr, quarter, y * 10 + q);
        const month = `${MONTHS[m]} ${y}`;
        rec[monthAttr] = month;
        setKey(monthAttr, month, y * 100 + m);
      }
      records[i] = rec;
    }
    return { records, fields, sortKeys };
  }

  const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });

  /** Fonction de tri par attribut, compatible avec l'option `sorters` de pivottable */
  function makeSorters(sortKeys) {
    return attr => {
      const keys = sortKeys[attr];
      return (a, b) => {
        if (a === b) { return 0; }
        if (a === EMPTY) { return 1; }
        if (b === EMPTY) { return -1; }
        if (keys) {
          const ka = keys.get(a), kb = keys.get(b);
          if (ka !== undefined && kb !== undefined) { return ka - kb; }
        }
        if (typeof a === 'number' && typeof b === 'number') { return a - b; }
        if (typeof a === 'number') { return -1; }
        if (typeof b === 'number') { return 1; }
        return collator.compare(a, b);
      };
    };
  }

  /** Nombre d'occurrences de chaque valeur d'un champ, trié */
  function valueCounts(records, attr, sorter) {
    const counts = new Map();
    for (const rec of records) {
      const v = rec[attr];
      counts.set(v, (counts.get(v) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => sorter(a[0], b[0]));
  }

  /** Libellé lisible d'un champ (les identifiants Grist utilisent des « _ ») */
  function label(attr) {
    return String(attr).replace(/_/g, ' ');
  }

  return { EMPTY, prepare, makeSorters, valueCounts, label };
})();
