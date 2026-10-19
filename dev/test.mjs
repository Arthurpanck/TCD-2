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

async function open(options, { width = 1280, height = 760, data } = {}) {
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') { errors.push(m.text()); } });
  await page.addInitScript(([o, d]) => { window.__MOCK_OPTIONS__ = o; if (d) { window.__MOCK_DATA__ = d; } }, [options, data]);
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
const base = { rows: ['Region'], cols: ['Annee'], vals: ['Montant'], aggregatorName: 'Somme', rendererName: 'Table' };

console.log('Widget TCD — tests');

await test('affiche le tableau en consultation, sans erreur', async () => {
  const page = await open({ settings: base });
  assert(await page.locator('table.pvtTable').count() === 1, 'tableau absent');
  assert(await page.locator('#config').isHidden(), 'la configuration ne doit pas être ouverte par défaut');
  assert((await page.locator('td.pvtGrandTotal').textContent()).replace(/\s/g, ' ') === '48 283 695', 'total général inattendu : ' + await page.locator('td.pvtGrandTotal').textContent());
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

await test('message et bouton quand le tableau n’est pas configuré', async () => {
  const page = await open({});
  assert(await page.locator('.empty h3').textContent() === "Ce tableau croisé n'est pas encore configuré", 'message absent');
  await page.click('.empty .btn-primary');
  assert(await page.locator('#config').isVisible(), 'le bouton doit ouvrir la configuration');
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
  await page.click('#zone-unused li.chip[data-attr="Statut"]');
  await page.click('.menu-item:has-text("Ajouter aux colonnes")');
  await page.waitForTimeout(600);
  const s = await savedSettings(page);
  assert(s && s.cols.join() === 'Annee,Statut', 'colonnes enregistrées : ' + JSON.stringify(s && s.cols));
  assert(await page.locator('#zone-cols li.chip').count() === 2, 'puce non ajoutée');
  await page.close();
});

await test('glisser-déposer d’un champ vers les lignes', async () => {
  const page = await open({ settings: base });
  await page.evaluate(() => grist.__openConfig());
  const src = page.locator('#zone-unused li.chip[data-attr="Dispositif"]');
  const dst = page.locator('#zone-rows');
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
  await page.click('#zone-rows li.chip');
  await page.click('.menu-item:has-text("Filtrer")');
  await page.locator('.fp-item', { hasText: 'Bretagne' }).locator('input').uncheck();
  await page.click('.fp-foot .btn-primary');
  await page.waitForTimeout(600);
  assert(await page.locator('th.pvtRowLabel', { hasText: 'Bretagne' }).count() === 0, 'Bretagne toujours affichée');
  assert((await page.locator('.sum-meta').textContent()).includes('/ 400'), 'résumé sans le nombre de lignes filtrées');
  const s = await savedSettings(page);
  assert(s && s.exclusions.Region && s.exclusions.Region[0] === 'Bretagne', 'filtre non enregistré');
  await page.close();
});

await test('détail d’une cellule et sélection transmise aux widgets liés', async () => {
  const page = await open({ settings: { ...base, cols: ['Statut'] } });
  await page.click('td.pvtVal.row0.col0');
  await page.waitForTimeout(250);
  assert(await page.locator('#drawer').isVisible(), 'panneau de détail absent');
  const n = await page.locator('.detail-table tbody tr').count();
  const ids = await page.evaluate(() => window.__mockGrist.selected);
  assert(Array.isArray(ids) && ids.length === n && n > 0, `sélection incohérente : ${ids && ids.length} vs ${n}`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  assert(await page.locator('#drawer').isHidden(), 'Échap doit fermer le détail');
  assert(await page.evaluate(() => window.__mockGrist.selected) === null, 'la sélection doit être réinitialisée');
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
