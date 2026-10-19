/**
 * Catalogue des calculs (agrégateurs) proposés, libellés lisibles et format des nombres.
 * Les clés restent celles de la locale française de pivottable pour rester compatible
 * avec les configurations déjà enregistrées dans Grist.
 */
const TCDAggregators = (function () {
  const tpl = $.pivotUtilities.aggregatorTemplates;
  const frFmt = $.pivotUtilities.numberFormat({ thousandsSep: ' ', decimalSep: ',' });

  function wavg(n) {
    if (!n) { return; }
    n = n.filter(([note]) => typeof (note) === 'number');
    if (n.length) { return n.map(([note, coef]) => note * coef).reduce((a, b) => a + b) / n.map(([_note, coef]) => coef).reduce((a, b) => a + b); }
  }

  function weightedAverage([val, coef]) {
    return (_data, _rowKey, _colKey) => ({
      values: [],
      push: function (rec) { this.values.push([rec[val], rec[coef]]); },
      value: function () { return wavg(this.values); },
      format: function (x) { return (Math.round(x * 100) / 100).toFixed(2); },
      numInputs: 2
    });
  }

  const catalogue = Object.assign({}, $.pivotUtilities.locales.fr.aggregators, {
    'Moyenne pondérée': weightedAverage,
    'Médiane': tpl.median(frFmt),
    'Variance': tpl.var(1, frFmt),
    'Écart-type': tpl.stdev(1, frFmt),
  });

  const GROUPS = [
    ['Comptage', ['Nombre', 'Nombre de valeurs uniques', 'Liste de valeurs uniques']],
    ['Calcul', ['Somme', 'Moyenne', 'Moyenne pondérée', 'Médiane', 'Minimum', 'Maximum', 'Écart-type', 'Variance', 'Ratio de sommes', 'Premier', 'Dernier']],
    ['Répartition en %', [
      'Somme en proportion du totale', 'Somme en proportion de la ligne', 'Somme en proportion de la colonne',
      'Nombre en proportion du totale', 'Nombre en proportion de la ligne', 'Nombre en proportion de la colonne',
    ]],
  ];

  const LABELS = {
    'Nombre': 'Nombre de lignes',
    'Somme en entiers': 'Somme (arrondie)',
    'Somme en proportion du totale': 'Somme en % du total',
    'Somme en proportion de la ligne': 'Somme en % de la ligne',
    'Somme en proportion de la colonne': 'Somme en % de la colonne',
    'Nombre en proportion du totale': 'Nombre en % du total',
    'Nombre en proportion de la ligne': 'Nombre en % de la ligne',
    'Nombre en proportion de la colonne': 'Nombre en % de la colonne',
  };

  const INPUT_LABELS = {
    'Moyenne pondérée': ['Valeur', 'Pondération'],
    'Ratio de sommes': ['Numérateur', 'Dénominateur'],
    'Borne supérieure 80%': ['Numérateur', 'Dénominateur'],
    'Borne inférieure 80%': ['Numérateur', 'Dénominateur'],
  };

  // Noms enregistrés par les versions précédentes (anglais ou ancien libellé)
  const LEGACY = {
    'Weighted Average': 'Moyenne pondérée',
    'Count': 'Nombre',
    'Count Unique Values': 'Nombre de valeurs uniques',
    'List Unique Values': 'Liste de valeurs uniques',
    'Sum': 'Somme',
    'Integer Sum': 'Somme en entiers',
    'Average': 'Moyenne',
    'Median': 'Médiane',
    'Sample Variance': 'Variance',
    'Sample Standard Deviation': 'Écart-type',
    'First': 'Premier',
    'Last': 'Dernier',
    'Sum over Sum': 'Ratio de sommes',
    'Sum as Fraction of Total': 'Somme en proportion du totale',
    'Sum as Fraction of Rows': 'Somme en proportion de la ligne',
    'Sum as Fraction of Columns': 'Somme en proportion de la colonne',
    'Count as Fraction of Total': 'Nombre en proportion du totale',
    'Count as Fraction of Rows': 'Nombre en proportion de la ligne',
    'Count as Fraction of Columns': 'Nombre en proportion de la colonne',
  };

  function normalizeName(name) {
    if (name && catalogue[name]) { return name; }
    return LEGACY[name] || 'Nombre';
  }

  function numInputs(name) {
    try { return catalogue[name]([])().numInputs || 0; } catch (e) { return 0; }
  }

  /** 'percent' | 'list' | 'count' | 'value' : détermine quel format de nombre appliquer */
  function kind(name) {
    if (/proportion/.test(name)) { return 'percent'; }
    if (/^Liste/.test(name)) { return 'list'; }
    if (/^Nombre/.test(name)) { return 'count'; }
    return 'value';
  }

  function inputLabels(name) {
    const n = numInputs(name);
    return INPUT_LABELS[name] || Array.from({ length: n }, (_, i) => (n > 1 ? `Champ ${i + 1}` : 'Champ'));
  }

  /**
   * Formateur de nombres français : décimales auto/fixes, échelle (k, M) et unité.
   */
  function numberFormatter({ decimals = 'auto', scale = 1, suffix = '' } = {}) {
    scale = Number(scale) || 1;
    const digits = decimals === 'auto' ? null : Number(decimals);
    const nf = new Intl.NumberFormat('fr-FR', digits === null
      ? { maximumFractionDigits: scale > 1 ? 1 : 2 }
      : { minimumFractionDigits: digits, maximumFractionDigits: digits });
    const unit = (scale === 1e3 ? 'k' : scale === 1e6 ? 'M' : '') + (suffix || '');
    return x => {
      if (typeof x !== 'number' || !isFinite(x)) { return x === null || x === undefined ? '' : String(x); }
      const s = nf.format(x / scale);
      return unit ? `${s} ${unit}` : s;
    };
  }

  /**
   * Construit l'agrégateur pivottable, avec le format de nombres choisi par l'utilisateur.
   */
  function build(name, vals, fmt) {
    const base = catalogue[name](vals);
    const k = kind(name);
    if (k === 'percent' || k === 'list') { return base; }
    const formatter = k === 'count' ? numberFormatter() : fmt;
    return (data, rowKey, colKey) => {
      const agg = base(data, rowKey, colKey);
      agg.format = formatter;
      return agg;
    };
  }

  /** Description lisible du calcul, ex. « Somme de Montant » */
  function describe(name, vals) {
    const L = TCDData.label;
    const v = (vals || []).filter(Boolean);
    const label = LABELS[name] || name;
    if (name === 'Nombre') { return 'Nombre de lignes'; }
    if (name === 'Nombre en proportion du totale' || name === 'Nombre en proportion de la ligne' || name === 'Nombre en proportion de la colonne') {
      return label;
    }
    if (!v.length) { return label; }
    if (name === 'Moyenne pondérée' && v.length > 1) { return `Moyenne de ${L(v[0])} pondérée par ${L(v[1])}`; }
    if (name === 'Ratio de sommes' && v.length > 1) { return `${L(v[0])} / ${L(v[1])}`; }
    if (kind(name) === 'percent') { return `${label} (${L(v[0])})`; }
    return `${label} de ${L(v[0])}`;
  }

  return { catalogue, GROUPS, LABELS, normalizeName, numInputs, inputLabels, kind, numberFormatter, build, describe };
})();
