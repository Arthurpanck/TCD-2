/**
 * Formats et libellés des colonnes, tels que définis dans Grist.
 *
 * Les métadonnées du document ne sont lisibles qu'avec l'accès « complet » du widget.
 * Avec l'accès « lecture de la table », on applique le format par défaut de Grist
 * (nombre brut, sans séparateur de milliers) et les identifiants de colonnes.
 * La logique de formatage reprend celle de Grist (app/common/NumberFormat.ts).
 */
const TCDGrist = (function () {
  const meta = { available: false, locale: undefined, currency: undefined, columns: {} };
  const cache = new Map();

  // Devise par défaut selon le pays de la langue du document, comme Grist (locale-currency)
  const CURRENCIES = { FR: 'EUR', BE: 'EUR', LU: 'EUR', DE: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR', PT: 'EUR', AT: 'EUR', IE: 'EUR', FI: 'EUR',
    CH: 'CHF', CA: 'CAD', US: 'USD', GB: 'GBP', MA: 'MAD', TN: 'TND', SN: 'XOF', CI: 'XOF', JP: 'JPY', BR: 'BRL' };

  async function load(tableId) {
    try {
      const [columns, tables, docInfo] = await Promise.all([
        grist.docApi.fetchTable('_grist_Tables_column'),
        grist.docApi.fetchTable('_grist_Tables'),
        grist.docApi.fetchTable('_grist_DocInfo'),
      ]);
      const tableRef = tables.id[tables.tableId.indexOf(tableId)];
      meta.columns = {};
      columns.id.forEach((_id, i) => {
        if (columns.parentId[i] !== tableRef) { return; }
        let options = {};
        try { options = JSON.parse(columns.widgetOptions[i] || '{}') || {}; } catch (e) { /* options illisibles : format par défaut */ }
        meta.columns[columns.colId[i]] = { label: columns.label[i], type: columns.type[i], options };
      });
      let settings = {};
      try { settings = JSON.parse((docInfo.documentSettings || [])[0] || '{}') || {}; } catch (e) { /* réglages par défaut */ }
      meta.locale = settings.locale;
      meta.currency = settings.currency;
      meta.available = true;
    } catch (e) {
      // Accès « lecture de la table » : pas de métadonnées, on garde le format par défaut de Grist
      meta.available = false;
    }
    cache.clear();
    return meta.available;
  }

  /** Langue du document Grist, sinon celle du navigateur ; une étiquette invalide est ignorée */
  function locale() {
    for (const candidate of [meta.locale, navigator.language, 'fr-FR']) {
      if (!candidate) { continue; }
      try { return Intl.getCanonicalLocales(candidate)[0]; } catch (e) { /* étiquette invalide, ex. « en-US@posix » */ }
    }
    return 'fr-FR';
  }

  function defaultCurrency() {
    const region = (locale().split('-')[1] || '').toUpperCase();
    return CURRENCIES[region] || 'USD';
  }

  const currencyDisplay = (function () {
    try {
      new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol' });
      return 'narrowSymbol';
    } catch (e) {
      return 'symbol';
    }
  })();

  function parseNumMode(numMode, currency) {
    switch (numMode) {
      case 'currency': return { style: 'currency', currency, currencyDisplay };
      case 'decimal': return { useGrouping: true };
      case 'percent': return { style: 'percent' };
      case 'scientific': return { notation: 'scientific' };
      default: return { useGrouping: false };
    }
  }

  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

  /** Équivalent de buildNumberFormat de Grist */
  function buildNumberFormat(options) {
    const currency = options.currency || meta.currency || defaultCurrency();
    const nf = parseNumMode(options.numMode, currency);
    if (options.decimals !== undefined && options.decimals !== null) {
      nf.minimumFractionDigits = clamp(Number(options.decimals), 0, 20);
    }
    const resolved = new Intl.NumberFormat(locale(), nf).resolvedOptions();
    if (options.maxDecimals !== undefined && options.maxDecimals !== null) {
      nf.maximumFractionDigits = clamp(Number(options.maxDecimals), resolved.minimumFractionDigits || 0, 20);
    } else if (!options.numMode) {
      nf.maximumFractionDigits = clamp(10, resolved.minimumFractionDigits || 0, 20);
    }
    return new Intl.NumberFormat(locale(), nf);
  }

  /**
   * Options de nombre d'une colonne Grist ({} : format par défaut), avec l'arrondi choisi dans le
   * widget (nombre de décimales, null : celui de la colonne) ; devise et séparateurs restent ceux de Grist.
   */
  function columnOptions(colId, decimals = null) {
    const col = meta.columns[colId];
    const options = col && (col.type === 'Numeric' || col.type === 'Int') ? col.options : {};
    return decimals === null ? options : { ...options, decimals, maxDecimals: decimals };
  }

  /**
   * Formateur de nombres d'une colonne (ou format par défaut de Grist si colId est vide).
   * @param {number|null} decimals - arrondi du widget
   * @returns {(x: any) => string}
   */
  function formatter(colId, decimals = null) {
    const key = `${colId || ''}|${decimals}`;
    if (cache.has(key)) { return cache.get(key); }
    const options = columnOptions(colId, decimals);
    const nf = buildNumberFormat(options);
    const parens = options.numSign === 'parens' && options.numMode !== 'scientific';
    const fn = x => {
      if (typeof x !== 'number' || !isFinite(x)) { return x === null || x === undefined ? '' : String(x); }
      // Gomme le bruit des additions en virgule flottante (126205.4000000001 → 126205.4)
      const v = Number(x.toPrecision(12));
      return parens && v < 0 ? `(${nf.format(-v)})` : nf.format(v);
    };
    cache.set(key, fn);
    return fn;
  }

  /**
   * Même format, traduit en format de nombre Excel (export .xlsx), à partir des options
   * résolues du formateur : décimales, séparateur de milliers, devise et sa position.
   */
  function excelFormat(colId, decimals = null) {
    const options = columnOptions(colId, decimals);
    const nf = buildNumberFormat(options);
    const r = nf.resolvedOptions();
    if (options.numMode === 'scientific') { return '0.00E+00'; }
    // Format par défaut de Grist sans décimales imposées : nombre brut
    if (!options.numMode && options.decimals == null && options.maxDecimals == null) { return 'General'; }
    const min = r.minimumFractionDigits || 0, max = Math.max(min, Math.min(r.maximumFractionDigits || 0, 10));
    const frac = max ? '.' + '0'.repeat(min) + '#'.repeat(max - min) : '';
    let fmt = (r.useGrouping ? '#,##0' : '0') + frac;
    if (r.style === 'percent') { fmt += '%'; }
    if (r.style === 'currency') {
      const parts = nf.formatToParts(1);
      const symbol = (parts.find(p => p.type === 'currency') || {}).value || r.currency;
      const before = parts.findIndex(p => p.type === 'currency') < parts.findIndex(p => p.type === 'integer');
      fmt = before ? `"${symbol}"${fmt}` : `${fmt} "${symbol}"`;
    }
    return options.numSign === 'parens' ? `${fmt};(${fmt})` : fmt;
  }

  /** Libellé Grist d'une colonne, ou null si inconnu */
  function label(colId) {
    const col = meta.columns[colId];
    return col && col.label ? col.label : null;
  }

  /** Empreinte des métadonnées, pour savoir si les libellés ou formats ont changé */
  const signature = () => JSON.stringify(meta);

  return { load, formatter, excelFormat, label, signature };
})();
