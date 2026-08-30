// The app mirrors the active dictionary in localStorage so a returning visitor
// paints instantly. That mirror is written by the PREVIOUS visit, so after a
// release every string added since renders in English while the fetched copy,
// a moment behind, has the translation. Nothing re-read it, so the newest
// features were the ones stuck in English -- which is exactly how a French
// session showed "Search parks" and "Tap to change your group" with the rest
// of the page in French.
//
// Simulates that state directly: seed the mirror with a dictionary missing the
// newest keys, load the app, and require every one of them to end up
// translated without a second reload.
import { launchBrowser } from './browser.mjs';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const B = process.env.PP_BASE || 'http://127.0.0.1:9695';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };

// Strings written once and never rewritten -- the ones this bug hides in.
// Each is dropped from the mirror, so if the page does not retext it stays
// in English and reads exactly as the screenshot did.
const WRITE_ONCE = [
  'Search parks',
  'Tap to change your group',
  'Search rides…',
  'Ask Mila, your park fairy',
  'Plan my day',
  'Your group',
];
const LANG = 'fr';
const fresh = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'i18n', `${LANG}.json`), 'utf8'));
const missing = WRITE_ONCE.filter((k) => fresh[k] === undefined);
const stale = { ...fresh };
for (const k of WRITE_ONCE) delete stale[k];

const browser = await launchBrowser();

async function load(seedMirror) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 }, userAgent: UA, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.addInitScript(([lang, dict, seed]) => {
    localStorage.setItem('pp-onboarded', '1');
    localStorage.setItem('pp-lang', lang);
    localStorage.setItem('pp-park', 'magic-kingdom');
    localStorage.setItem('pp-profile', JSON.stringify({ party: 4, ages: ['adult', 'kid'], vibes: ['thrill'], onsite: false }));
    if (seed) localStorage.setItem('pp-dict-' + lang, JSON.stringify(dict));
  }, [LANG, stale, seedMirror]);
  const json = (b) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
  await page.route('**/api/waits/**', (r) => r.fulfill(json({
    park: 'Magic Kingdom', source: 'live', attribution: 's', updatedAt: new Date().toISOString(),
    rides: [{ name: 'Space Mountain', land: 'A', wait: 30, open: true, typical: 35 }],
  })));
  for (const p of ['**/api/ride-tags/**', '**/api/closures/**', '**/api/weather/**', '**/api/dining/**', '**/api/trip']) await page.route(p, (r) => r.fulfill(json({})));
  await page.goto(B + '/app', { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(4000);
  const seen = await page.evaluate(() => ({
    parkq: document.getElementById('parkq')?.placeholder ?? null,
    rideq: document.getElementById('search')?.placeholder ?? null,
    hint: document.getElementById('group-hint')?.textContent?.replace('←', '').trim() ?? null,
    wiz: document.getElementById('wiz')?.getAttribute('aria-label') ?? null,
    fab: document.getElementById('ppc-fab')?.getAttribute('aria-label') ?? null,
    planDay: document.getElementById('plan-day')?.textContent?.replace(/[^\p{L} ]/gu, '').trim() ?? null,
    dict: window.PP_T('Search parks'),
  }));
  await ctx.close();
  return { seen, errs };
}

console.log(`\n[the dictionary has every string this checks]`);
check('none of them is missing from the shipped French', missing.length === 0, missing.join(', '));

console.log('\n[a returning visitor, mirror one release behind]');
const { seen, errs } = await load(true);
console.log(`      ${JSON.stringify(seen, null, 2).replace(/\n/g, '\n      ')}`);
check('the fetched dictionary did arrive', seen.dict === fresh['Search parks'], seen.dict);
check('the park search is in French', seen.parkq === fresh['Search parks'], seen.parkq);
check('the ride search is in French', seen.rideq === fresh['Search rides…'], seen.rideq);
check('the group label is in French', seen.hint === fresh['Tap to change your group'], seen.hint);
check('the group sheet is labelled in French', seen.wiz === fresh['Your group'], seen.wiz);
if (seen.fab !== null) check("Mila's button is in French", seen.fab === fresh['Ask Mila, your park fairy'], seen.fab);
else console.log('  --   the chat widget did not mount here');
check('no page errors', errs.length === 0, errs[0]);

console.log('\n[a first visit, nothing mirrored]');
const first = await load(false);
check('everything is in French straight away', first.seen.parkq === fresh['Search parks'] && first.seen.hint === fresh['Tap to change your group'],
  `${first.seen.parkq} | ${first.seen.hint}`);
check('no page errors', first.errs.length === 0, first.errs[0]);

console.log('\n[the dictionary is fetched, not served from a stale worker cache]');
const sw = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
check('/i18n/ is network-first', /url\.pathname\.startsWith\('\/i18n\/'\)/.test(sw),
  'the worker still answers dictionaries from cache, so a new release takes two visits');

console.log(fail ? `\n=== ${fail} failures ===` : '\n=== a release-old mirror no longer leaves new strings in English ===');
await browser.close();
process.exit(fail ? 1 : 0);
