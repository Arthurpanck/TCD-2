/**
 * Catalogue des calculs (agrégateurs) proposés à pivotUI et libellés lisibles.
 * Les clés restent celles de la locale française de pivottable pour rester compatible
 * avec les configurations déjà enregistrées dans Grist.
 */
const TCDAggregators = (function () {
  const tpl = $.pivotUtilities.aggregatorTemplates;
  const subTpl = $.pivotUtilities.subtotalAggregatorTemplates;
  const frPct = $.pivotUtilities.numberFormat({ digitsAfterDecimal: 1, scaler: 100, suffix: ' %', thousandsSep: ' ', decimalSep: ',' });

  /** Moyenne pondérée (absente de pivottable), écrite comme ses modèles d'agrégateurs */
  function weightedAverage([val, coef] = []) {
    return () => ({
      sum: 0,
      weight: 0,
      push(rec) {
        const v = parseFloat(rec[val]), w = parseFloat(rec[coef]);
        if (isFinite(v) && isFinite(w)) { this.sum += v * w; this.weight += w; }
      },
      value() { return this.weight ? this.sum / this.weight : null; },
      format: x => String(x),
      numInputs: 2,
    });
  }

  const catalogue = Object.assign({}, $.pivotUtilities.locales.fr.aggregators, {
    'Moyenne pondérée': weightedAverage,
    // Le format est remplacé par celui de Grist (forUI)
    'Médiane': tpl.median(),
    'Variance': tpl.var(1),
    'Écart-type': tpl.stdev(1),
    // Proportions relatives au groupe parent : fournies par subtotal.js
    'Somme en proportion du groupe (lignes)': subTpl.fractionOf(tpl.sum(), 'row', frPct),
    'Somme en proportion du groupe (colonnes)': subTpl.fractionOf(tpl.sum(), 'col', frPct),
    'Nombre en proportion du groupe (lignes)': subTpl.fractionOf(tpl.count(), 'row', frPct),
    'Nombre en proportion du groupe (colonnes)': subTpl.fractionOf(tpl.count(), 'col', frPct),
  });

  const GROUPS = [
    ['Comptage', ['Nombre', 'Nombre de valeurs uniques', 'Liste de valeurs uniques']],
    ['Calcul', ['Somme', 'Moyenne', 'Moyenne pondérée', 'Médiane', 'Minimum', 'Maximum', 'Écart-type', 'Variance', 'Ratio de sommes', 'Premier', 'Dernier']],
    ['Répartition en %', [
      'Somme en proportion du totale', 'Somme en proportion de la ligne', 'Somme en proportion de la colonne',
      'Nombre en proportion du totale', 'Nombre en proportion de la ligne', 'Nombre en proportion de la colonne',
      'Somme en proportion du groupe (lignes)', 'Somme en proportion du groupe (colonnes)',
      'Nombre en proportion du groupe (lignes)', 'Nombre en proportion du groupe (colonnes)',
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
    'Somme en proportion du groupe (lignes)': 'Somme en % du groupe (lignes)',
    'Somme en proportion du groupe (colonnes)': 'Somme en % du groupe (colonnes)',
    'Nombre en proportion du groupe (lignes)': 'Nombre en % du groupe (lignes)',
    'Nombre en proportion du groupe (colonnes)': 'Nombre en % du groupe (colonnes)',
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

  // Calculs dont le résultat garde l'unité de la colonne : on lui applique le format de la colonne dans Grist
  const KEEPS_COLUMN_FORMAT = new Set(['Somme', 'Somme en entiers', 'Moyenne', 'Moyenne pondérée', 'Médiane',
    'Minimum', 'Maximum', 'Premier', 'Dernier', 'Écart-type']);

  /**
   * Agrégateurs transmis à pivotUI : ceux de la librairie, avec le format de nombre de la colonne Grist
   * (devise, pourcentage, décimales…) ou, à défaut, le format par défaut de Grist.
   * @param {(name: string) => string} colIdOf - nom de champ affiché → identifiant de colonne Grist
   */
  function forUI(colIdOf) {
    const out = {};
    for (const name of Object.keys(catalogue)) {
      const k = kind(name);
      out[name] = vals => {
        const base = catalogue[name](vals);
        if (k === 'percent' || k === 'list') { return base; }
        const formatter = TCDGrist.formatter(KEEPS_COLUMN_FORMAT.has(name) && vals && vals[0] ? colIdOf(vals[0]) : null);
        return (data, rowKey, colKey) => {
          const agg = base(data, rowKey, colKey);
          agg.format = formatter;
          return agg;
        };
      };
    }
    return out;
  }

  /** Description lisible du calcul, ex. « Somme de Montant » */
  function describe(name, vals) {
    const L = x => x;
    const v = (vals || []).filter(Boolean);
    const label = LABELS[name] || name;
    if (name === 'Nombre') { return 'Nombre de lignes'; }
    if (/^Nombre en proportion/.test(name)) {
      return label;
    }
    if (!v.length) { return label; }
    if (name === 'Moyenne pondérée' && v.length > 1) { return `Moyenne de ${L(v[0])} pondérée par ${L(v[1])}`; }
    if (name === 'Ratio de sommes' && v.length > 1) { return `${L(v[0])} / ${L(v[1])}`; }
    if (kind(name) === 'percent') { return `${label} (${L(v[0])})`; }
    return `${label} de ${L(v[0])}`;
  }

  return { GROUPS, LABELS, normalizeName, inputLabels, forUI, describe };
})();
