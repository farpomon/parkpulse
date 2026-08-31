// Everything a non-English reader actually sees, read back off the screen.
//
// Spot-checking screenshots finds one leak at a time. This drives the app in
// Portuguese, walks every tab and opens every sheet, and reports each visible
// string that is still English -- both the ones that HAVE a translation nobody
// wired up, and the ones that were never translatable in the first place.
//
//   node test/i18n-audit.mjs            # against a server on :9695
//   node test/i18n-audit.mjs --lang ja
// playwright-core is a developer tool, not a dependency of the app -- resolve
// it from wherever it is installed rather than pinning it into package.json.
import { launchBrowser } from './browser.mjs';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const B = process.env.PP_BASE || 'http://127.0.0.1:9695';
const LANG = (process.argv.includes('--lang') ? process.argv[process.argv.indexOf('--lang') + 1] : 'pt');
const DICT = JSON.parse(fs.readFileSync(path.join(ROOT, `public/i18n/${LANG}.json`), 'utf8'));
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

// --- fixtures ---------------------------------------------------------------
// Deliberately un-English ride and restaurant names. Real ones ("Pirates of the
// Caribbean") are English by nature and would drown the report in false alarms;
// keeping the fixture's proper nouns out of the way means anything English on
// screen is chrome, which is the thing being audited.
const RIDES = Array.from({ length: 14 }, (_, i) => ({
  name: `Atracao ${i + 1}`, land: ['Fantasia', 'Aventura'][i % 2],
  wait: 15 + (i % 8) * 12, open: i % 9 !== 0, typical: 25 + (i % 8) * 12,
}));
const DINING = {
  park: 'Magic Kingdom',
  reserve: { url: 'https://example.test/dining/', scoped: true, note: 'Reservations open 60 days ahead at 6:00 AM ET' },
  list: [
    { name: 'Restaurante Um', type: 'table', price: '$$$', blurb: 'Cozinha francesa dentro do castelo.', mustBook: true },
    { name: 'Restaurante Dois', type: 'quick', price: '$', blurb: 'Sanduiches rapidos perto da entrada.', mustBook: false },
    { name: 'Restaurante Tres', type: 'character', price: '$$', blurb: 'Cafe da manha com personagens.', mustBook: true },
  ],
};

// Names the app is right to leave alone: products, brands, people, and the
// language menu, which lists every language in its own words on purpose.
const PROPER = [
  'ParkPulse', 'Mila', 'Pip', 'Lightning Lane', 'Multi Pass', 'Premier Pass', 'Express Pass',
  'WhatsApp', 'Magic Kingdom', 'Walt Disney World', 'Disney', 'Universal', 'Google', 'Apple',
  'OpenStreetMap', 'Queue-Times', 'Stripe', 'iPhone', 'Android', 'Fastpass', 'FastPass',
  // Third-party attribution the app is not free to reword.
  'Leaflet', 'A JavaScript library for interactive maps',
  ...RIDES.map((r) => r.name), ...DINING.list.map((r) => r.name), 'Atracao', 'Fantasia', 'Aventura',
];
// Whole-word English words, deliberately wide. The list alone is not the
// detector: "a", "no", "in" and "or" are English AND Portuguese, and the first
// version of this duly reported three perfectly good Portuguese sentences as
// leaks. A detector that cries wolf on correct translations is worse than
// none, because the real findings stop being read.
//
// So the list is narrowed per language, automatically, by throwing away every
// word that actually occurs in that language's own translations. "the" and
// "your" survive a Portuguese run; "a" and "no" do not. In German the same
// rule quietly drops "an" and "park". No hand-maintained exception list, and
// it re-tunes itself whenever a dictionary grows.
const EN_CANDIDATES = `the and or of to in for with your you our we us is are was were be at on a an this that these those it its from by when what which how why not no yes all any each every more most less
open opens opening ahead early book booking service table quick wait waits line lines day days time times park parks ride rides show shows plan plans pass passes trip trips
free new next first last best worth save saved minutes hours choices reflects completed staying destination dates forecast expects lightest library interactive maps dining character hotel site chat magical fairy`
  .split(/\s+/).filter(Boolean);

// Every word used anywhere in this language's translations, so the detector
// can tell "English word" from "word this language also happens to use".
const NATIVE = new Set(
  Object.values(DICT).join(' ').toLowerCase().match(/[\p{L}]+/gu) || [],
);
const EN_WORDS = EN_CANDIDATES.filter((w) => !NATIVE.has(w));
const EN_RE = new RegExp(`\\b(${EN_WORDS.join('|')})\\b`, 'gi');

const rules = [];
function classify(text) {
  const s = text.trim().replace(/\s+/g, ' ');
  if (s.length < 4) return null;
  if (!/[A-Za-z]/.test(s)) return null;                       // numbers, emoji, punctuation
  if (/^[\d\s.,:/–—$€£¥%·+×-]+$/.test(s)) return null;         // price bands, clock times
  // A string that IS a dictionary key and HAS a different translation is the
  // clearest possible finding: someone translated it and nobody wired it up.
  if (Object.prototype.hasOwnProperty.call(DICT, s) && DICT[s] !== s) {
    return { kind: 'untranslated', detail: `dictionary has: ${DICT[s]}` };
  }
  // Otherwise fall back to reading it. Strip the proper nouns first.
  let stripped = s;
  for (const p of PROPER) stripped = stripped.split(p).join(' ');
  const hits = [...new Set((stripped.match(EN_RE) || []).map((w) => w.toLowerCase()))];
  if (hits.length >= 2) return { kind: 'english', detail: `reads as English (${hits.slice(0, 5).join(', ')})` };
  return null;
}

// --- the sweep --------------------------------------------------------------
// One text unit per element that owns text directly, so a sentence is judged
// whole rather than word by word.
const VISIBLE_TEXT = () => {
  const out = [];
  const seen = new Set();
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      const tag = el.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'svg') continue;
      const box = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || (!box.width && !box.height)) continue;
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ').trim();
      const bits = [own, el.getAttribute('placeholder') || '', el.getAttribute('title') || '', el.getAttribute('aria-label') || ''];
      for (const b of bits) {
        const t = String(b).trim();
        if (!t || seen.has(t)) continue;
        seen.add(t);
        out.push({ text: t, where: el.id ? '#' + el.id : (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : tag) });
      }
    }
  };
  walk(document);
  return out;
};

const findings = new Map(); // text -> { kind, detail, screens:Set, where }
function record(screen, items) {
  for (const { text, where } of items) {
    const verdict = classify(text);
    if (!verdict) continue;
    const prev = findings.get(text);
    if (prev) prev.screens.add(screen);
    else findings.set(text, { ...verdict, where, screens: new Set([screen]) });
  }
}

const browser = await launchBrowser();
const ctx = await browser.newContext({ viewport: { width: 390, height: 900 }, userAgent: UA, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.addInitScript((l) => {
  localStorage.setItem('pp-onboarded', '1');
  localStorage.setItem('pp-park', 'magic-kingdom');
  localStorage.setItem('pp-name', 'Luis');
  localStorage.setItem('pp-lang', l);
}, LANG);
const json = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
await page.route('**/api/waits/**', (r) => r.fulfill(json({ park: 'x', source: 'live', attribution: 'Queue-Times', updatedAt: new Date().toISOString(), rides: RIDES })));
await page.route('**/api/ride-tags/**', (r) => r.fulfill(json({ tags: {} })));
await page.route('**/api/closures/**', (r) => r.fulfill(json({ closed: [] })));
await page.route('**/api/weather/**', (r) => r.fulfill(json({ unavailable: true })));
await page.route('**/api/dining/**', (r) => r.fulfill(json(DINING)));
await page.route('**/api/geo/**', (r) => r.fulfill(json({ status: 'sparse', rides: [] })));
await page.route('**/api/consultant', (r) => r.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: 'event: delta\ndata: {"text":"Um comentario da Mila."}\n\nevent: done\ndata: {}\n\n' }));

await page.goto(B + '/app', { waitUntil: 'domcontentloaded', timeout: 25000 });
await page.waitForTimeout(2600);
const closeOverlays = () => page.evaluate(() => {
  for (const id of ['onboard', 'onboard-bg', 'acct-sheet', 'acct-bg', 'gate', 'sheet', 'sheet-bg', 'll-sheet', 'trip-sheet']) {
    document.getElementById(id)?.classList.remove('open');
  }
});

const screens = [];
const visit = async (name, fn, settle = 700) => {
  try { await fn(); } catch (e) { console.log(`  (could not reach ${name}: ${e.message.split('\n')[0]})`); return; }
  await page.waitForTimeout(settle);
  const items = await page.evaluate(VISIBLE_TEXT);
  record(name, items);
  screens.push(`${name} (${items.length} strings)`);
};

// The onboarding sheet is the first thing a new visitor reads.
await visit('onboarding', async () => { await page.evaluate(() => document.getElementById('onboard')?.classList.add('open')); });
await closeOverlays();
await visit('attractions', async () => { await page.evaluate(() => document.querySelector('.tabbar button[data-tab="today"]')?.click()); });
await visit('dining', async () => { await page.evaluate(() => document.querySelector('.tabbar button[data-tab="dining"]')?.click()); }, 1500);
await visit('map', async () => { await page.evaluate(() => document.getElementById('map-toggle')?.click()); }, 1200);
await visit('attractions (back)', async () => { await page.evaluate(() => document.getElementById('map-toggle')?.click()); });
await visit('alert sheet', async () => {
  await page.evaluate(() => document.querySelector('#rides .bell, #rides .alert, #rides button[title]')?.click());
});
await closeOverlays();
await visit('plan (empty)', async () => { await page.evaluate(() => document.querySelector('.tabbar button[data-tab="plan"]')?.click()); });
await visit('plan (built)', async () => {
  await page.evaluate(() => document.querySelector('.tabbar button[data-tab="today"]')?.click());
  await page.waitForTimeout(200);
  await page.evaluate(() => document.querySelectorAll('#rides input[type=checkbox][data-name]').forEach((c) => { if (!c.disabled && !c.checked) c.click(); }));
  await page.evaluate(() => document.querySelector('.tabbar button[data-tab="plan"]')?.click());
  await page.waitForTimeout(300);
  await page.evaluate(() => (document.getElementById('plan-hero-btn') || document.getElementById('build'))?.click());
}, 3000);
// The two screens a visitor gets on the day Mila is broken. Both are written
// by the SERVER, in English, and handed straight to the panel -- the money
// gate ("Mila is having a little rest") and the upstream failures (a dead key,
// an empty balance). Nothing here is display:none: the panel simply never
// fails while a test is stubbing success, which is how a whole class of copy
// stayed unread in nineteen languages. Failing on purpose is the only way to
// see it.
const rebuildWith = async (fulfil) => {
  await page.unroute('**/api/consultant');
  await page.route('**/api/consultant', fulfil);
  // Her read is cached per park-day, and a park-day already asked is offered
  // rather than asked again -- so a rebuild alone would replay the successful
  // answer above and never reach the failure at all.
  await page.evaluate(() => { try { sessionStorage.clear(); } catch {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await closeOverlays();
  await page.evaluate(() => document.querySelector('.tabbar button[data-tab="today"]')?.click());
  await page.waitForTimeout(200);
  await page.evaluate(() => document.querySelectorAll('#rides input[type=checkbox][data-name]').forEach((c) => { if (!c.disabled && !c.checked) c.click(); }));
  await page.evaluate(() => document.querySelector('.tabbar button[data-tab="plan"]')?.click());
  await page.waitForTimeout(300);
  await page.evaluate(() => (document.getElementById('plan-hero-btn') || document.getElementById('build'))?.click());
};
await visit('plan · Mila out of budget', async () => {
  await rebuildWith((r) => r.fulfill({ status: 402, contentType: 'application/json', body: JSON.stringify({
    error: 'Mila is having a little rest — everything else still works. Try her again shortly.',
    milaRest: 'global', spent: 50, budget: 50 }) }));
}, 3000);
// Her read of the same plan, replayed because she could not be reached. The
// label is the only part of it we write, and it is the part a reader needs.
await visit('plan · Mila replayed read', async () => {
  await rebuildWith((r) => r.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' },
    body: 'event: stale\ndata: {"at":1}\n\nevent: delta\ndata: {"text":"Um comentario da Mila."}\n\nevent: done\ndata: {}\n\n' }));
}, 3000);
await visit('plan · Mila upstream failure', async () => {
  await rebuildWith((r) => r.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' },
    body: `event: error\ndata: ${JSON.stringify({ error: "Mila's key isn't being accepted right now — the operator has been told." })}\n\n` }));
}, 3000);
// Put the working advisor back for the screens below.
await page.unroute('**/api/consultant');
await page.route('**/api/consultant', (r) => r.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: 'event: delta\ndata: {"text":"Um comentario da Mila."}\n\nevent: done\ndata: {}\n\n' }));
await visit('skip-pass sheet', async () => {
  await page.evaluate(() => [...document.querySelectorAll('#plan-out button')].find((x) => /🎟/.test(x.textContent))?.click());
});
await closeOverlays();
await visit('account', async () => { await page.evaluate(() => document.getElementById('acct-btn')?.click()); });
// Signed-in account panel. It is display:none until a session exists, which is
// why every string in it -- "Account", "Log out everywhere else", "Delete my
// account", the whole deletion warning -- went years unaudited. Revealing it is
// enough: these are authored in the markup, so what renders here is what a
// signed-in reader gets.
await visit('account · signed in', async () => {
  await page.evaluate(() => {
    document.getElementById('acct-sheet')?.classList.add('open');
    const li = document.getElementById('acct-logged-in');
    if (li) li.style.display = '';
    document.getElementById('acct-form')?.setAttribute('style', 'display:none');
    document.getElementById('acct-switch')?.setAttribute('style', 'display:none');
    for (const id of ['acct-del', 'acct-wa']) { const e = document.getElementById(id); if (e) e.style.display = ''; }
  });
});
await closeOverlays();
// The paywall, likewise: shown only with PRO_GATE on and no pass, so its whole
// sales pitch had never been read back in another language.
await visit('the pass gate', async () => {
  await page.evaluate(() => {
    document.body.classList.add('gated-hard');
    document.getElementById('gate')?.classList.add('open');
  });
});
await page.evaluate(() => { document.body.classList.remove('gated-hard'); });
await visit('language sheet', async () => { await page.evaluate(() => document.getElementById('lang-lbl')?.scrollIntoView()); });
await closeOverlays();
// The trip sheet, WITH a saved trip in it. Opening the empty sheet showed the
// form and nothing else -- the booking-window advice only renders once a trip
// exists with a window still ahead of it, which is how a whole screen of
// English copy (every destination's line-skipping rules) went unaudited. A
// trip far enough out that the window has not passed is what makes it render.
await visit('trip sheet', async () => {
  await page.evaluate(() => {
    const soon = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);
    try { localStorage.setItem('pp-trip', JSON.stringify({ dest: 'Walt Disney World', start: soon, days: 3, onsite: true, plan: [
      { date: soon, park: 'magic-kingdom', level: 2 },
    ] })); } catch {}
  });
  await page.evaluate(() => { try { openTripSheet(); } catch { document.getElementById('trip-sheet')?.classList.add('open'); } });
});
// The same advice for a visitor who is NOT in a resort hotel: a different
// sentence entirely, and just as English before this.
await visit('trip sheet · off-site', async () => {
  await page.evaluate(() => {
    const soon = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);
    try { localStorage.setItem('pp-trip', JSON.stringify({ dest: 'Walt Disney World', start: soon, days: 3, onsite: false, plan: [
      { date: soon, park: 'magic-kingdom', level: 2 },
    ] })); } catch {}
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.evaluate(() => { try { openTripSheet(); } catch { document.getElementById('trip-sheet')?.classList.add('open'); } });
});
await closeOverlays();
await visit('chat', async () => {
  await page.evaluate(() => document.querySelector('.tabbar button[data-tab="mila"], #mila-tab, .tabbar button:nth-child(3)')?.click());
}, 1500);
await visit('you', async () => { await page.evaluate(() => document.querySelector('.tabbar button[data-tab="you"]')?.click()); });

// --- report -----------------------------------------------------------------
console.log(`\nlanguage: ${LANG} · screens walked: ${screens.length} · ${EN_WORDS.length}/${EN_CANDIDATES.length} candidate words are English-only here`);
for (const s of screens) console.log(`  · ${s}`);
if (errs.length) console.log(`\npage errors: ${errs.length} — ${errs[0]}`);

const rows = [...findings.entries()].sort((a, b) => (a[1].kind === b[1].kind ? 0 : a[1].kind === 'untranslated' ? -1 : 1));
const untranslated = rows.filter(([, v]) => v.kind === 'untranslated');
const english = rows.filter(([, v]) => v.kind === 'english');

console.log(`\n=== ${untranslated.length} strings have a translation that is not being used ===`);
for (const [text, v] of untranslated) console.log(`  ${v.where.padEnd(18)} ${JSON.stringify(text)}\n${' '.repeat(21)}${v.detail}  [${[...v.screens].join(', ')}]`);
console.log(`\n=== ${english.length} strings read as English and have no translation at all ===`);
for (const [text, v] of english) console.log(`  ${v.where.padEnd(18)} ${JSON.stringify(text)}\n${' '.repeat(21)}${v.detail}  [${[...v.screens].join(', ')}]`);

fs.writeFileSync(path.join(ROOT, `i18n-audit-${LANG}.json`), JSON.stringify(
  rows.map(([text, v]) => ({ text, kind: v.kind, detail: v.detail, where: v.where, screens: [...v.screens] })), null, 2));
console.log(`\nfull report: i18n-audit-${LANG}.json`);
await browser.close();
process.exit(findings.size ? 1 : 0);
