// Tests de bout en bout du widget avec une API Grist simulée.
// Usage : npx http-server -p 8765 . &  puis  node dev/test.mjs
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mock = fs.readFileSync(path.join(here, 'mock-grist.js'), 'utf8');
const URL = process.env.WIDGET_URL || 'http://localhost:8765/index.html';
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let failures = 0, passed = 0;

async function open(options, { width = 1280, height = 760, data, meta } = {}) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') { errors.push(m.text()); } });
  await page.addInitScript(([o, d, m]) => {
    window.__MOCK_OPTIONS__ = o;
    if (d) { window.__MOCK_DATA__ = d; }
    if (m) { window.__MOCK_META__ = m; }
  }, [options, data, meta]);
  await page.route('**/grist-plugin-api.js', r => r.fulfill({ body: mock, contentType: 'application/javascript' }));
  await page.goto(URL);
  await page.waitForTimeout(400);
  page.errors = errors;
  return page;
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures++;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}

function assert(cond, msg) { if (!cond) { throw new Error(msg); } }
const savedSettings = page => page.evaluate(() => {
  const log = window.__mockGrist.setLog.filter(([k]) => k === 'settings');
  return log.length ? log[log.length - 1][1] : null;
});
// Cellules de détail (hors sous-totaux et totaux) du rendu de subtotal.js
const LEAF = 'table.pvtTable tbody td.pvtVal:not(.pvtRowSubtotal):not(.pvtColSubtotal):not(.pvtTotal)';
const base = { rows: ['Region'], cols: ['Annee'], vals: ['Montant'], aggregatorName: 'Somme', rendererName: 'Table' };

console.log('Widget TCD — tests');

await test('affiche le tableau en consultation, sans erreur', async () => {
  const page = await open({ settings: base });
  assert(await page.locator('table.pvtTable').count() === 1, 'tableau absent');
  assert(await page.locator('#config').isHidden(), 'la configuration ne doit pas être ouverte par défaut');
  assert((await page.locator('td.pvtGrandTotal').textContent()) === '48283695', 'total général inattendu (format par défaut de Grist) : ' + await page.locator('td.pvtGrandTotal').textContent());
  assert(page.errors.length === 0, page.errors.join(' | '));
  await page.close();
});

await test('déclare onEditOptions (bouton « Ouvrir la configuration » de Grist) et ouvre le panneau', async () => {
  const page = await open({ settings: base });
  const opts = await page.evaluate(() => ({ ...window.__mockGrist.readyOpts, onEditOptions: typeof window.__mockGrist.readyOpts.onEditOptions }));
  assert(opts.onEditOptions === 'function', 'onEditOptions absent');
  assert(opts.requiredAccess === 'read table', 'accès requis inattendu');
  await page.evaluate(() => grist.__openConfig());
  await page.waitForTimeout(150);
  assert(await page.locator('#config').isVisible(), 'panneau non visible');
  await page.click('#cfg-done');
  assert(await page.locator('#config').isHidden(), 'panneau toujours visible après « Terminer »');
  await page.close();
});

await test("reprend les réglages des anciennes versions (anglais, taille colonnes)", async () => {
  const page = await open({ settings: { rows: ['Statut'], cols: [], vals: ['Montant', 'Beneficiaires'], aggregatorName: 'Weighted Average', rendererName: 'Heatmap' }, columnSize: '0.5' });
  assert(await page.evaluate(() => document.documentElement.dataset.density) === 'compact', 'densité compacte attendue');
  assert((await page.locator('#summary').textContent()).includes('pondérée'), 'moyenne pondérée non reconnue');
  assert(await page.locator('td.is-heat').count() > 0, 'carte de chaleur non appliquée');
  await page.close();
});

await test('message sans bouton quand le tableau n’est pas configuré (configuration via Grist uniquement)', async () => {
  const page = await open({});
  assert(await page.locator('.empty h3').textContent() === "Ce tableau croisé n'est pas encore configuré", 'message absent');
  assert((await page.locator('.empty p').textContent()).includes('Ouvrir la configuration'), 'le message doit renvoyer vers le bouton Grist');
  assert(await page.locator('.empty button').count() === 0, 'aucun bouton de configuration ne doit être affiché dans le widget');
  await page.evaluate(() => grist.__openConfig());
  assert(await page.locator('#config').isVisible(), 'le bouton Grist doit ouvrir la configuration');
  await page.close();
});

await test('message quand la table source est vide', async () => {
  const page = await open({ settings: base }, { data: [] });
  assert((await page.locator('.empty h3').textContent()).includes('vide'), 'message table vide absent');
  await page.close();
});

await test('ajout d’un champ par clic puis enregistrement dans Grist', async () => {
  const page = await open({ settings: base });
  await page.evaluate(() => grist.__openConfig());
  await page.click('#slot-unused li.chip[data-attr="Statut"]');
  await page.click('.menu-item:has-text("Ajouter aux colonnes")');
  await page.waitForTimeout(600);
  const s = await savedSettings(page);
  assert(s && s.cols.join() === 'Annee,Statut', 'colonnes enregistrées : ' + JSON.stringify(s && s.cols));
  assert(await page.locator('#slot-cols li.chip').count() === 2, 'puce non ajoutée');
  await page.close();
});

await test('glisser-déposer d’un champ vers les lignes', async () => {
  const page = await open({ settings: base });
  await page.evaluate(() => grist.__openConfig());
  const src = page.locator('#slot-unused li.chip[data-attr="Dispositif"]');
  const dst = page.locator('#slot-rows td.pvtRows');
  const a = await src.boundingBox(), b = await dst.boundingBox();
  await page.mouse.move(a.x + 20, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + 30, a.y + 20, { steps: 4 });
  await page.mouse.move(b.x + 60, b.y + b.height - 6, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  const s = await savedSettings(page);
  assert(s && s.rows.includes('Dispositif'), 'lignes enregistrées : ' + JSON.stringify(s && s.rows));
  await page.close();
});

await test('filtre de valeurs : exclusion, résumé et enregistrement', async () => {
  const page = await open({ settings: base });
  await page.evaluate(() => grist.__openConfig());
  await page.click('#slot-rows li.chip');
  await page.click('.menu-item:has-text("Filtrer")');
  const box = page.locator('#filter-layer .pvtFilterBox:visible');
  await box.locator('label', { hasText: 'Bretagne' }).locator('input').uncheck();
  await box.locator('.btn-primary').click();
  await page.waitForTimeout(600);
  assert(await page.locator('th.pvtRowLabel', { hasText: 'Bretagne' }).count() === 0, 'Bretagne toujours affichée');
  assert((await page.locator('.sum-meta').textContent()).includes('/ 400'), 'résumé sans le nombre de lignes filtrées');
  const s = await savedSettings(page);
  assert(s && s.exclusions.Region && s.exclusions.Region[0] === 'Bretagne', 'filtre non enregistré');
  await page.close();
});

await test('détail d’une cellule et sélection transmise aux widgets liés', async () => {
  const page = await open({ settings: { ...base, cols: ['Statut'] } });
  await page.locator(LEAF).first().click();
  await page.waitForTimeout(250);
  assert(await page.locator('#drawer').isVisible(), 'panneau de détail absent');
  const n = await page.locator('.detail-table tbody tr').count();
  const ids = await page.evaluate(() => window.__mockGrist.selected);
  assert(Array.isArray(ids) && ids.length === n && n > 0, `sélection incohérente : ${ids && ids.length} vs ${n}`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  assert(await page.locator('#drawer').isHidden(), 'Échap doit fermer le détail');
  assert((await page.evaluate(() => window.__mockGrist.selected) || []).length === n, 'la sélection doit rester active pour les vues liées');
  await page.close();
});

await test('sous-totaux par groupe, repli et dépli', async () => {
  const page = await open({ settings: { ...base, rows: ['Region', 'Dispositif'] } });
  const groups = page.locator('tbody th.pvtRowLabel.rowcol0');
  assert(await groups.count() === 8, 'un sous-total par région attendu');
  const first = groups.first();
  assert((await first.textContent()).includes('Auvergne'), 'premier groupe inattendu : ' + await first.textContent());
  const sub = await page.locator('tbody tr').first().locator('td.rowTotal').textContent();
  assert(sub === '5372983', 'sous-total inattendu : ' + sub);
  const leaves = page.locator('tbody th.pvtRowLabel.rowcol1:visible');
  assert(await leaves.count() === 40, 'lignes de détail : ' + await leaves.count());
  await first.click();
  await page.waitForTimeout(100);
  assert(await page.locator('tbody th.pvtRowLabel.rowcol0.rowcollapsed').count() === 1, 'groupe non replié');
  assert(await leaves.count() === 35, 'lignes du groupe replié encore visibles');
  await first.click();
  await page.waitForTimeout(100);
  assert(await leaves.count() === 40, 'groupe non déplié');
  await page.evaluate(() => setAllCollapsed(true));
  await page.waitForTimeout(150);
  assert(await leaves.count() === 0, '« Tout replier » doit replier chaque région');
  await page.close();
});

await test('tri par valeur décroissante (pivottable) : les groupes restent regroupés', async () => {
  const page = await open({ settings: { ...base, rows: ['Region', 'Dispositif'], rowOrder: 'value_z_to_a' } });
  const firsts = await page.locator('tbody th.pvtRowLabel.rowcol0').allTextContents();
  assert(firsts.length === 8, `chaque région doit apparaître une seule fois (${firsts.length})`);
  // pivottable trie les lignes de détail par valeur : le groupe de la plus forte ligne arrive en tête
  assert(firsts[0].includes('Bretagne'), 'la région de la plus forte ligne doit être en tête : ' + firsts[0]);
  const values = await page.locator('tbody tr').nth(1).locator('td.rowTotal').textContent();
  assert(Number(values) >= Number(await page.locator('tbody tr').nth(2).locator('td.rowTotal').textContent()), 'lignes non triées par valeur décroissante');
  await page.close();
});

await test('navigation au clavier dans le tableau', async () => {
  const page = await open({ settings: base });
  await page.focus('#output');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  const focused = await page.evaluate(() => document.activeElement.matches('td.pvtVal') && document.activeElement.dataset.colnode);
  assert(focused === '1', 'cellule active inattendue : ' + focused);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  assert(await page.locator('#drawer').isVisible(), 'Entrée doit ouvrir le détail');
  await page.close();
});

await test('filtres rapides depuis la barre de résumé', async () => {
  const page = await open({ settings: { ...base, exclusions: { Region: ['Bretagne'] } } });
  await page.click('.sum-filters');
  await page.click('.popover .filter-pill-main');
  await page.waitForTimeout(150);
  const filter = page.locator('#filter-layer .pvtFilterBox:visible');
  const box = await filter.boundingBox();
  const anchor = await page.locator('.sum-filters').boundingBox();
  assert(Math.abs(box.y - (anchor.y + anchor.height + 6)) < 4, `fenêtre de filtre mal positionnée (y=${box.y})`);
  await filter.locator('label', { hasText: 'Bretagne' }).locator('input').check();
  await filter.locator('.btn-primary').click();
  await page.waitForTimeout(500);
  assert(await page.locator('.sum-filters').count() === 0, 'le filtre doit être retiré');
  await page.close();
});

await test('données hétérogènes : vides, booléens, listes et erreurs Grist', async () => {
  const data = [
    { id: 1, Nom_service: 'A', Actif: true, Tags: ['L', 'x', 'y'], Valeur: 10, Erreur: ['E', 'ZeroDivisionError'] },
    { id: 2, Nom_service: '', Actif: false, Tags: ['L'], Valeur: null, Erreur: 1 },
    { id: 3, Nom_service: null, Actif: null, Tags: null, Valeur: 5, Erreur: 2 },
    { id: 4, Nom_service: 'A', Actif: true, Tags: ['L', 'x', 'y'], Valeur: 'n/a', Erreur: 3 },
  ];
  const page = await open({ settings: { rows: ['Nom_service', 'Actif'], cols: ['Tags'], vals: ['Valeur'], aggregatorName: 'Somme' } }, { data });
  const labels = await page.locator('th.pvtRowLabel').allTextContents();
  assert(labels.some(t => t.includes('(vide)')), 'valeurs vides non regroupées : ' + labels.join('|'));
  assert(labels.some(t => t.includes('Oui')) && labels.some(t => t.includes('Non')), 'booléens non traduits');
  const cols = await page.locator('th.pvtColLabel').allTextContents();
  assert(cols.includes('x, y'), 'liste de choix non lisible : ' + cols.join('|'));
  assert(await page.locator('th.pvtAxisLabel', { hasText: 'Nom service' }).count() === 1, 'libellé de champ non embelli');
  assert(page.errors.length === 0, page.errors.join(' | '));
  await page.evaluate(() => { state.settings = normalizeSettings({ ...state.settings, rows: [], cols: ['Erreur'] }); build(); });
  await page.waitForTimeout(150);
  assert((await page.locator('th.pvtColLabel').allTextContents()).includes('#Erreur'), 'erreur de formule non signalée');
  assert(page.errors.length === 0, page.errors.join(' | '));
  await page.close();
});

await test('accès complet : format et libellés des colonnes repris de Grist', async () => {
  const meta = {
    documentSettings: { locale: 'fr-FR', currency: 'EUR' },
    columns: {
      Montant: { label: 'Montant engagé', type: 'Numeric', options: { numMode: 'currency', decimals: 0, maxDecimals: 0 } },
      Region: { label: 'Région', type: 'Text' },
    },
  };
  const page = await open({ settings: base }, { meta });
  const total = (await page.locator('td.pvtGrandTotal').textContent()).replace(/\s/g, ' ');
  assert(total === '48 283 695 €', 'format devise de la colonne non repris : ' + total);
  assert((await page.locator('#summary').textContent()).includes('Somme de Montant engagé'), 'libellé Grist non repris');
  assert(await page.locator('th.pvtAxisLabel', { hasText: 'Région' }).count() === 1, 'libellé de colonne non repris dans le tableau');
  await page.evaluate(() => grist.__openConfig());
  assert((await page.locator('#format-hint').textContent()).includes('format de la colonne'), 'indication de format absente');
  await page.close();
});

await test('format par défaut : pas de bruit de virgule flottante dans les totaux', async () => {
  const data = [0.1, 0.2, 0.3].map((v, i) => ({ id: i + 1, Groupe: 'A', Valeur: v }));
  const page = await open({ settings: { rows: ['Groupe'], cols: [], vals: ['Valeur'], aggregatorName: 'Somme' } }, { data });
  const total = await page.locator('td.pvtGrandTotal').textContent();
  assert(total === '0,6' || total === '0.6', 'total attendu 0,6 : ' + total);
  await page.close();
});

await test('lecture seule : format par défaut de Grist et indication pour l’accès complet', async () => {
  const page = await open({ settings: base });
  await page.evaluate(() => grist.__openConfig());
  assert((await page.locator('#format-hint').textContent()).includes('accès complet'), 'indication accès complet absente');
  assert(await page.locator('#decimals, #scale, #suffix, #accent-swatches').count() === 0, 'les anciens réglages de format/couleur doivent avoir disparu');
  assert(await page.locator('#renderer-seg button[data-value="chart"]').count() === 0, 'le mode graphique doit avoir disparu');
  await page.close();
});

await test('anciens réglages graphique / format / couleur ignorés et nettoyés', async () => {
  const page = await open({ settings: { ...base, rendererName: 'Graphique', chartType: 'line', scale: 1000, suffix: '€', accent: 'vert' } });
  assert(await page.locator('table.pvtTable').count() === 1, 'un ancien réglage « Graphique » doit afficher le tableau');
  await page.evaluate(() => update({ density: 'compact' }));
  await page.waitForTimeout(500);
  const s = await savedSettings(page);
  assert(s && !('chartType' in s) && !('scale' in s) && !('suffix' in s) && !('accent' in s), 'réglages obsolètes encore enregistrés : ' + JSON.stringify(s));
  await page.close();
});

await test('clic : détail limité aux colonnes du tableau, sélection gardée pour les vues liées', async () => {
  const page = await open({ settings: { ...base, cols: ['Statut'] } });
  await page.locator(LEAF).first().click();
  await page.waitForTimeout(250);
  const heads = await page.locator('.detail-table th').allTextContents();
  assert(heads.join('|') === 'Region|Statut|Montant', 'colonnes du détail : ' + heads.join('|'));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  const kept = await page.evaluate(() => window.__mockGrist.selected);
  assert(Array.isArray(kept) && kept.length > 0, 'la sélection doit rester après fermeture du détail');
  await page.keyboard.press('Escape');
  assert(await page.evaluate(() => window.__mockGrist.selected) === null, 'second Échap : la sélection doit être effacée');
  await page.evaluate(() => update({ clickDetail: false }));
  await page.waitForTimeout(100);
  await page.locator(LEAF).nth(5).click();
  await page.waitForTimeout(250);
  assert(await page.locator('#drawer').isHidden(), 'détail désactivé : le panneau ne doit pas s’ouvrir');
  assert((await page.evaluate(() => window.__mockGrist.selected) || []).length > 0, 'détail désactivé : la sélection doit quand même être transmise');
  await page.close();
});

await test('export : la matrice reprend les totaux du tableau', async () => {
  const page = await open({ settings: base });
  const rows = await page.evaluate(() => exportMatrix());
  assert(rows[0].join('|') === 'Region|2022|2023|2024|2025|Total', 'en-tête : ' + rows[0].join('|'));
  const last = rows[rows.length - 1];
  assert(last[0] === 'Total' && last[last.length - 1] === 48283695, 'ligne total : ' + last.join('|'));
  await page.close();
});

await test('mise à jour des données Grist sans perdre la configuration', async () => {
  const page = await open({ settings: base });
  await page.evaluate(() => window.__mockGrist.emitRecords(window.__mockGrist.data.slice(0, 100)));
  await page.waitForTimeout(150);
  assert((await page.locator('.sum-meta').textContent()).startsWith('100'), 'données non rafraîchies');
  assert(await page.locator('th.pvtAxisLabel', { hasText: 'Region' }).count() === 1, 'configuration perdue');
  await page.close();
});

await test('« Annuler » restaure la configuration d’ouverture', async () => {
  const page = await open({ settings: base });
  await page.evaluate(() => grist.__openConfig());
  await page.click('#swap-axes');
  await page.waitForTimeout(100);
  await page.click('#cfg-revert');
  await page.waitForTimeout(500);
  const s = await savedSettings(page);
  assert(s && s.rows[0] === 'Region' && s.cols[0] === 'Annee', 'configuration non restaurée : ' + JSON.stringify(s));
  await page.close();
});

await test('ordre français des valeurs (accents) et valeurs vides en dernier', async () => {
  const page = await open({ settings: { ...base, cols: [] } });
  const regions = (await page.locator('tbody th.pvtRowLabel').allTextContents()).map(t => t.trim());
  assert(regions.indexOf('Île-de-France') === regions.indexOf('Hauts-de-France') + 1, 'Île-de-France doit suivre Hauts-de-France : ' + regions.join('|'));
  await page.close();
});

await test('filtre : « seulement » ne garde qu’une valeur', async () => {
  const page = await open({ settings: base });
  await page.evaluate(() => grist.__openConfig());
  await page.locator('#slot-rows .pvtTriangle').first().click();
  const box = page.locator('#filter-layer .pvtFilterBox:visible');
  const label = box.locator('label', { hasText: 'Bretagne' });
  await label.hover();
  await label.locator('.fp-only').click();
  await box.locator('.btn-primary').click();
  await page.waitForTimeout(500);
  const rows = await page.locator('tbody th.pvtRowLabel').allTextContents();
  assert(rows.length === 1 && rows[0].includes('Bretagne'), 'lignes : ' + rows.join('|'));
  const s = await savedSettings(page);
  assert(s && s.exclusions.Region.length === 7, 'exclusions : ' + JSON.stringify(s && s.exclusions));
  await page.close();
});

await test('densité : pas de recalcul du tableau', async () => {
  const page = await open({ settings: base });
  const before = await page.evaluate(() => { window.__t = document.querySelector('table.pvtTable'); update({ density: 'compact' }); return 1; });
  await page.waitForTimeout(300);
  assert(await page.evaluate(() => document.querySelector('table.pvtTable') === window.__t), 'le tableau ne doit pas être recalculé');
  await page.close();
});

for (const width of [360, 600, 1024]) {
  await test(`pas de débordement horizontal de la page à ${width}px (consultation et configuration)`, async () => {
    const page = await open({ settings: { ...base, rows: ['Region', 'Dispositif'] } }, { width, height: 700 });
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(await overflow() <= 0, 'débordement en consultation');
    await page.evaluate(() => grist.__openConfig());
    await page.waitForTimeout(150);
    assert(await overflow() <= 0, 'débordement en configuration');
    assert(page.errors.length === 0, page.errors.join(' | '));
    await page.close();
  });
}

await browser.close();
console.log(`\n${passed} réussi(s), ${failures} échec(s)`);
process.exit(failures ? 1 : 0);
