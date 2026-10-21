// API Grist simulée pour tester le widget hors de Grist (utilisée par dev/shoot.mjs et dev/demo.html)
(function () {
  const params = new URLSearchParams(location.search);
  const store = JSON.parse(localStorage.getItem('mockGristOptions') || 'null') || window.__MOCK_OPTIONS__ || {};
  let recordsCb = null, optionsCb = null;

  function seeded(seed) { return () => (seed = (seed * 16807) % 2147483647) / 2147483647; }
  function sampleData(n) {
    const rnd = seeded(42);
    const pick = a => a[Math.floor(rnd() * a.length)];
    const regions = {
      'Auvergne-Rhône-Alpes': ['Rhône', 'Isère', 'Puy-de-Dôme'],
      'Bretagne': ['Finistère', 'Ille-et-Vilaine'],
      'Grand Est': ['Bas-Rhin', 'Moselle', 'Marne'],
      'Hauts-de-France': ['Nord', 'Pas-de-Calais', 'Somme'],
      'Île-de-France': ['Paris', 'Seine-Saint-Denis', 'Hauts-de-Seine'],
      'Nouvelle-Aquitaine': ['Gironde', 'Landes'],
      'Occitanie': ['Haute-Garonne', 'Hérault'],
      "Provence-Alpes-Côte d'Azur": ['Bouches-du-Rhône', 'Var'],
    };
    const dispositifs = ['France Services', 'Petites villes de demain', 'Action cœur de ville', 'Fonds vert', 'Territoires d’industrie'];
    const statuts = ['Instruit', 'Engagé', 'Payé', 'Refusé'];
    const rows = [];
    for (let i = 1; i <= n; i++) {
      const region = pick(Object.keys(regions));
      rows.push({
        id: i,
        Region: region,
        Departement: pick(regions[region]),
        Dispositif: pick(dispositifs),
        Annee: pick([2022, 2023, 2024, 2025]),
        Statut: pick(statuts),
        Montant: Math.round(5000 + rnd() * 245000),
        Beneficiaires: Math.round(10 + rnd() * 990),
        Date_depot: new Date(Date.UTC(2022 + Math.floor(rnd() * 4), Math.floor(rnd() * 12), 1 + Math.floor(rnd() * 27))),
        Thematiques: rnd() > 0.5 ? ['Numérique', 'Mobilité'] : ['Transition écologique'],
      });
    }
    return rows;
  }
  const data = window.__MOCK_DATA__ || sampleData(Number(params.get('n') || 400));
  window.__mockGrist = {
    store, data, setLog: [], failSave: false,
    emitRecords: d => recordsCb && recordsCb(d || data),
    // Options envoyées par Grist (autre utilisateur, autre onglet…)
    emitOptions: o => optionsCb && optionsCb(o, {}),
  };

  window.grist = {
    ready(opts) { window.__mockGrist.readyOpts = opts; },
    onRecords(cb) { recordsCb = cb; setTimeout(() => cb(data), 30); },
    onRecord() {},
    onOptions(cb) { optionsCb = cb; setTimeout(() => cb(store, {}), 10); },
    async getOption(k) { return store[k]; },
    async setOption(k, v) {
      // Utilisateur sans droit d'édition : Grist refuse l'enregistrement
      if (window.__mockGrist.failSave) { throw new Error('Access denied'); }
      store[k] = v; window.__mockGrist.setLog.push([k, v]);
      try { localStorage.setItem('mockGristOptions', JSON.stringify(store)); } catch (e) {}
    },
    async getOptions() { return store; },
    async setOptions(o) { Object.assign(store, o); },
    widgetApi: {
      async getOption(k) { return store[k]; },
      async setOption(k, v) { return window.grist.setOption(k, v); },
    },
    // Métadonnées Grist : disponibles seulement si le test fournit __MOCK_META__ (accès complet),
    // sinon refus comme avec l'accès « lecture de la table »
    docApi: {
      async fetchTable(tableId) {
        const meta = window.__MOCK_META__;
        if (!meta) { throw new Error('Access denied'); }
        if (tableId === '_grist_Tables') { return { id: [1], tableId: ['Table1'] }; }
        if (tableId === '_grist_DocInfo') { return { id: [1], documentSettings: [JSON.stringify(meta.documentSettings || {})] }; }
        if (tableId === '_grist_Tables_column') {
          const cols = Object.entries(meta.columns || {});
          return {
            id: cols.map((_c, i) => i + 1),
            parentId: cols.map(() => 1),
            colId: cols.map(([c]) => c),
            label: cols.map(([c, o]) => o.label || c),
            type: cols.map(([, o]) => o.type || 'Any'),
            widgetOptions: cols.map(([, o]) => JSON.stringify(o.options || {})),
          };
        }
        throw new Error('Unknown table');
      },
    },
    async getSelectedTableId() { return 'Table1'; },
    setSelectedRows(ids) { window.__mockGrist.selected = ids; },
    // Simule le clic sur « Ouvrir la configuration » dans le panneau Grist
    __openConfig() { const o = window.__mockGrist.readyOpts; o && o.onEditOptions && o.onEditOptions(); },
  };
})();
