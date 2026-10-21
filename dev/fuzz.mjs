// Test de robustesse : enchaîne des actions au hasard sur le widget (configuration, aperçu, filtres,
// glisser-déposer, sélection, exports, données et options envoyées par Grist, taille, thème…) et vérifie
// après chacune : aucune erreur JavaScript, pas de débordement horizontal, un tableau ou un message affiché.
// Usage : npx http-server -p 8765 -c-1 . puis node dev/fuzz.mjs [graine] [nombre d'actions]
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mock = fs.readFileSync(path.join(here, 'mock-grist.js'), 'utf8');
const URL = process.env.WIDGET_URL || 'http://localhost:8765/index.html';
const seed = Number(process.argv[2] || 7);
const count = Number(process.argv[3] || 200);

let s = seed;
const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
const pick = a => a[Math.floor(rnd() * a.length)];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
page.setDefaultTimeout(3000);
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !/jsdelivr|cdnjs|ERR_FAILED/.test(m.text())) { errors.push(m.text()); } });
page.on('download', () => {});
await page.addInitScript(() => {
  window.__MOCK_OPTIONS__ = { settings: { rows: ['Region', 'Dispositif'], cols: ['Annee'], vals: ['Montant'], aggregatorName: 'Somme', rendererName: 'Carte de chaleur' } };
});
await page.route('**/grist-plugin-api.js', r => r.fulfill({ body: mock, contentType: 'application/javascript' }));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

const visible = sel => page.locator(sel).filter({ visible: true });
async function clickSome(sel) {
  const items = visible(sel);
  const n = await items.count();
  if (n) { await items.nth(Math.floor(rnd() * n)).click({ timeout: 2000 }); }
}

const fields = ['Region', 'Departement', 'Dispositif', 'Annee', 'Statut', 'Montant', 'Date_depot', 'Date_depot › Mois', 'Thematiques', 'Inconnu'];
const actions = {
  openConfig: () => page.evaluate(() => grist.__openConfig()),
  done: () => clickSome('#cfg-done'),
  revert: () => clickSome('#cfg-revert'),
  preview: () => clickSome('#cfg-preview'),
  closePreview: () => clickSome('#preview-close'),
  backdrop: async () => { if (await page.locator('#preview[open]').count()) { await page.mouse.click(4, 380); } },
  escape: () => page.keyboard.press('Escape'),
  chipMenu: async () => { await clickSome('li.chip span.pvtAttr'); await clickSome('.popover .menu-item'); },
  removeChip: () => clickSome('.chip-remove'),
  drag: async () => {
    const chips = visible('li.chip'), zones = visible('td.pvtAxisContainer');
    const n = await chips.count(), z = await zones.count();
    if (!n || !z) { return; }
    const a = await chips.nth(Math.floor(rnd() * n)).boundingBox(), b = await zones.nth(Math.floor(rnd() * z)).boundingBox();
    if (!a || !b) { return; }
    await page.mouse.move(a.x + 10, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 });
    await page.mouse.up();
  },
  filter: async () => {
    await clickSome('li.chip .pvtTriangle');
    const box = page.locator('#filter-layer .pvtFilterBox:visible');
    if (!(await box.count())) { return; }
    const r = rnd();
    if (r < 0.3) { await clickSome('#filter-layer .pvtFilterBox:visible .fr-checkbox-group label'); }
    else if (r < 0.5) { await box.locator(':scope > p').first().locator('button').nth(1).click(); }
    else if (r < 0.7) { const g = box.locator('.fr-checkbox-group').first(); await g.hover(); await g.locator('.fp-only').click(); }
    else if (r < 0.8) { await box.locator('input.pvtSearch').fill(pick(['a', 'zz', 'é', ''])); }
    await (rnd() < 0.7 ? box.locator(':scope > p:last-child .fr-btn').first().click() : page.keyboard.press('Escape'));
  },
  clearFilters: () => clickSome('#clear-filters, .filter-pill-clear'),
  order: () => clickSome('a.order-btn'),
  swap: () => clickSome('#swap-axes'),
  style: () => clickSome('#renderer-seg label'),
  heatScope: async () => { if (await visible('#heat-scope').count()) { await page.selectOption('#heat-scope', pick(['all', 'row', 'col'])); } },
  toggle: () => clickSome('.fr-toggle__label'),
  density: () => clickSome('#density-seg label'),
  font: () => clickSome('#font-up:not([disabled]), #font-down:not([disabled])'),
  title: async () => { if (await visible('#table-title').count()) { await page.fill('#table-title', pick(['', 'Titre', '<b>gras</b>', 'é'.repeat(250), '  '])); } },
  aggregator: async () => {
    if (!(await visible('#agg-select').count())) { return; }
    const values = await page.locator('#agg-select option').evaluateAll(o => o.map(x => x.value));
    await page.selectOption('#agg-select', pick(values));
  },
  valField: async () => {
    const sel = visible('select.pvtAttrDropdown');
    if (!(await sel.count())) { return; }
    const values = await sel.first().locator('option').evaluateAll(o => o.map(x => x.value).filter(Boolean));
    if (values.length) { await sel.first().selectOption(pick(values)); }
  },
  fieldSearch: async () => { if (await visible('#field-search').count()) { await page.fill('#field-search', pick(['', 'date', 'xyz', 'Mo'])); } },
  cell: () => clickSome('#output td.pvtVal, #output td.pvtTotal, #output td.pvtGrandTotal'),
  group: () => clickSome('#output tbody th.rowexpanded, #output tbody th.rowcollapsed, #output thead th.pvtRowAxis'),
  keys: async () => { await clickSome('#output td.pvtVal'); for (let i = 0; i < 4; i++) { await page.keyboard.press(pick(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'])); } },
  selectionPill: () => clickSome('.sum-selection'),
  summaryFilters: async () => { await clickSome('.sum-filters'); await clickSome('.popover .filter-pill-main'); },
  showMore: () => clickSome('.show-more'),
  exportCsv: async () => { await clickSome('#btn-export'); await clickSome('.popover .menu-item:has-text("CSV")'); },
  exportCopy: async () => { await clickSome('#btn-export'); await clickSome('.popover .menu-item:has-text("Copier")'); },
  records: () => page.evaluate(k => {
    const d = window.__mockGrist.data;
    window.__mockGrist.emitRecords(k < 0.2 ? [] : k < 0.6 ? d.slice(0, Math.floor(k * d.length)) : d);
  }, rnd()),
  options: () => page.evaluate(([rows, cols, agg]) => window.__mockGrist.emitOptions({ settings: { rows, cols, vals: ['Montant'], aggregatorName: agg } }),
    [[pick(fields)], rnd() < 0.5 ? [] : [pick(fields)], pick(['Somme', 'Nombre', 'Moyenne', 'Somme en proportion du totale', 'Inconnu'])]),
  resize: () => page.setViewportSize(pick([{ width: 1200, height: 760 }, { width: 700, height: 500 }, { width: 360, height: 640 }, { width: 1600, height: 400 }])),
  theme: () => page.evaluate(t => document.documentElement.setAttribute('data-grist-appearance', t), pick(['light', 'dark'])),
};

const names = Object.keys(actions);
const log = [];
let failures = 0;
for (let i = 0; i < count; i++) {
  const name = pick(names);
  log.push(name);
  try {
    await actions[name]();
  } catch (e) {
    // Élément disparu entre la recherche et le clic : action sans effet, pas un défaut du widget
    if (!/Timeout|not attached|detached|outside of the viewport|intercepts pointer|not visible|not an HTMLSelectElement|not enabled/.test(e.message)) {
      errors.push(`action ${name} : ${e.message.split('\n')[0]}`);
    }
  }
  await page.waitForTimeout(60);
  const check = await page.evaluate(() => {
    const out = document.getElementById('output');
    const shown = out && out.getClientRects().length > 0;
    return {
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      content: !shown || Boolean(out.querySelector('table.pvtTable, .fr-callout')),
      summary: document.getElementById('summary').textContent.length > 0,
    };
  });
  if (check.overflow) { errors.push(`débordement horizontal après ${name}`); }
  if (!check.content) { errors.push(`ni tableau ni message après ${name}`); }
  if (errors.length) {
    failures++;
    console.log(`✗ action ${i + 1} (${name}) — ${errors.join(' | ')}\n  dernières actions : ${log.slice(-8).join(' → ')}`);
    errors.length = 0;
    if (failures >= 5) { break; }
  }
}
console.log(`graine ${seed} : ${count} actions, ${failures} anomalie(s)`);
await browser.close();
process.exit(failures ? 1 : 0);
