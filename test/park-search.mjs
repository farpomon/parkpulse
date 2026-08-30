// Sixty-five parks behind one <select> means knowing which resort EPCOT
// belongs to before you can reach it. This drives the search field the way a
// visitor would: type a fragment, an abbreviation, a resort, a region, a
// misspelling without accents -- and check the right park comes back and
// switching to it actually works.
import { launchBrowser } from './browser.mjs';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const B = process.env.PP_BASE || 'http://127.0.0.1:9695';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };
const browser = await launchBrowser();

async function open(lang = 'en') {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 }, userAgent: UA, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.addInitScript((l) => {
    localStorage.setItem('pp-onboarded', '1'); localStorage.setItem('pp-park', 'magic-kingdom');
    if (l !== 'en') localStorage.setItem('pp-lang', l);
  }, lang);
  const json = (b) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
  await page.route('**/api/waits/**', (r) => r.fulfill(json({ park: 'x', source: 'live', attribution: 's', updatedAt: new Date().toISOString(), rides: [{ name: 'Atracao 1', land: 'A', wait: 20, open: true, typical: 25 }] })));
  for (const p of ['**/api/ride-tags/**', '**/api/closures/**', '**/api/weather/**', '**/api/dining/**']) await page.route(p, (r) => r.fulfill(json({})));
  await page.route('**/api/consultant', (r) => r.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: 'event: done\ndata: {}\n\n' }));
  await page.goto(B + '/app', { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(2500);
  await page.evaluate(() => { for (const i of ['onboard', 'onboard-bg', 'acct-sheet', 'acct-bg', 'gate', 'sheet', 'sheet-bg', 'll-sheet', 'trip-sheet']) document.getElementById(i)?.classList.remove('open'); });
  return { ctx, page, errs };
}
const type = async (page, q) => {
  await page.fill('#parkq', '');
  await page.type('#parkq', q, { delay: 8 });
  await page.waitForTimeout(180);
  return page.evaluate(() => ({
    open: !document.getElementById('parkq-list').hidden,
    none: !!document.querySelector('.pf-none'),
    noneText: document.querySelector('.pf-none')?.textContent.trim() || '',
    rows: [...document.querySelectorAll('.pf-row')].map((r) => ({ slug: r.dataset.slug, name: r.querySelector('b')?.textContent.trim(), sub: r.querySelector('span')?.textContent.trim() })),
    marked: !!document.querySelector('.pf-row mark'),
  }));
};

const { ctx, page, errs } = await open();
const parkCount = await page.evaluate(async () => Object.keys(await (await fetch('/api/config')).json().then((c) => c.parks)).length);
console.log(`\n[the field] ${parkCount} parks in the picker`);
{
  const idle = await page.evaluate(() => ({
    field: !!document.getElementById('parkq'),
    select: !!document.getElementById('dest'),
    listHidden: document.getElementById('parkq-list').hidden,
    ph: document.getElementById('parkq').placeholder,
  }));
  check('the field sits alongside the dropdown, not instead of it', idle.field && idle.select);
  check('nothing is listed until something is typed', idle.listHidden);
  check('it says what it is for', /search/i.test(idle.ph), idle.ph);
}

console.log('\n[finding a park]');
const cases = [
  ['epcot', 'epcot', 'by its own name'],
  ['EPCOT', 'epcot', 'ignoring case'],
  ['hollywood stu', 'hollywood-studios', 'from a fragment'],
  ['mk', 'magic-kingdom', 'by the abbreviation people type'],
  ['ioa', 'islands-of-adventure', 'by another one'],
  ['disneysea', 'tokyo-disneysea', 'when the words are run together'],
  ['tokyo sea', 'tokyo-disneysea', 'from two words in any order'],
  ['animal', 'animal-kingdom', 'from one distinctive word'],
];
for (const [q, want, why] of cases) {
  const r = await type(page, q);
  check(`"${q}" finds it ${why}`, r.rows[0]?.slug === want, `got ${r.rows.slice(0, 3).map((x) => x.slug).join(', ') || 'nothing'}`);
}

console.log('\n[searching by where it is]');
for (const [q, want] of [['orlando', 'Walt Disney World'], ['paris', 'Disneyland Paris'], ['florida', null]]) {
  const r = await type(page, q);
  check(`"${q}" returns parks`, r.rows.length > 0, JSON.stringify(r.rows.map((x) => x.slug)));
  if (want) check(`  and they are ${want}`, r.rows.some((x) => x.sub.includes(want)), r.rows.map((x) => x.sub).join(' | '));
}

console.log('\n[searching in your own language]');
// The field used to strip every character that was not a-z: typing the only
// spelling on a Japanese, Korean, Chinese, Arabic or Indic keyboard searched
// for the empty string and found nothing at all.
const langCases = [
  ['Tóquio', ['tokyo-disneyland', 'tokyo-disneysea'], 'Portuguese for Tokyo'],
  ['東京', ['tokyo-disneyland', 'tokyo-disneysea'], 'Japanese for Tokyo'],
  ['도쿄', ['tokyo-disneyland', 'tokyo-disneysea'], 'Korean for Tokyo'],
  ['Токио', ['tokyo-disneyland', 'tokyo-disneysea'], 'Russian for Tokyo'],
  ['टोक्यो', ['tokyo-disneyland', 'tokyo-disneysea'], 'Hindi for Tokyo'],
  ['Xangai', ['shanghai-disneyland'], 'Portuguese for Shanghai'],
  ['巴黎', ['disneyland-paris', 'walt-disney-studios-paris', 'parc-asterix'], 'Chinese for Paris'],
  ['서울', ['everland', 'lotte-world'], 'Korean for Seoul'],
  ['Alemanha', ['europa-park', 'heide-park', 'phantasialand'], 'Portuguese for Germany'],
  ['ロンドン', ['thorpe-park', 'legoland-windsor', 'chessington'], 'Japanese for London'],
];
for (const [q, want, why] of langCases) {
  const r = await type(page, q);
  const got = r.rows.map((x) => x.slug);
  check(`"${q}" finds parks (${why})`, got.length > 0, 'nothing came back');
  check(`  and only the right ones`, got.length > 0 && got.every((g) => want.includes(g)), got.join(', '));
}
{
  // The nearest false friend in the set: London decomposes to the same
  // fragments as Toronto once the dakuten is split off, so a sloppy fix
  // returns Canada's Wonderland for a London search.
  const r = await type(page, 'ロンドン');
  check('Toronto is not London', !r.rows.some((x) => x.slug === 'canadas-wonderland'), r.rows.map((x) => x.slug).join(', '));
}

console.log('\n[when there is nothing]');
{
  const r = await type(page, 'zzzznotapark');
  check('it says so rather than sitting empty', r.none, JSON.stringify(r));
  check('and repeats what was typed', /zzzznotapark/.test(r.noneText), r.noneText);
}

console.log('\n[the result itself]');
{
  const r = await type(page, 'epco');
  check('the matched part is highlighted', r.marked);
  check('and the resort is named underneath', /Walt Disney World/.test(r.rows[0]?.sub || ''), r.rows[0]?.sub);
}

console.log('\n[switching park]');
{
  await type(page, 'hollywood stu');
  await page.click('.pf-row');
  await page.waitForTimeout(2200);
  const after = await page.evaluate(() => ({
    park: localStorage.getItem('pp-park'),
    dest: document.getElementById('dest').value,
    q: document.getElementById('parkq').value,
    listHidden: document.getElementById('parkq-list').hidden,
  }));
  check('the app switched to it', after.park === 'hollywood-studios', after.park);
  check('the dropdown followed', after.dest === 'hollywood-studios', after.dest);
  check('the field cleared itself', after.q === '', JSON.stringify(after.q));
  check('and the list closed', after.listHidden);
}

console.log('\n[keyboard]');
{
  await type(page, 'disney');
  const first = await page.evaluate(() => document.querySelector('.pf-row[aria-selected="true"]')?.dataset.slug);
  await page.press('#parkq', 'ArrowDown');
  const second = await page.evaluate(() => document.querySelector('.pf-row[aria-selected="true"]')?.dataset.slug);
  check('arrow keys move the selection', first && second && first !== second, `${first} -> ${second}`);
  await page.press('#parkq', 'Enter');
  await page.waitForTimeout(2200);
  check('enter picks it', await page.evaluate(() => localStorage.getItem('pp-park')) === second, second);
  await type(page, 'epcot');
  await page.press('#parkq', 'Escape');
  await page.waitForTimeout(150);
  check('escape closes and clears', await page.evaluate(() => document.getElementById('parkq-list').hidden && document.getElementById('parkq').value === ''));
}
check('no page errors', errs.length === 0, errs[0]);
await ctx.close();

console.log('\n[pt]');
{
  const { ctx: c2, page: p2 } = await open('pt');
  const ph = await p2.evaluate(() => document.getElementById('parkq').placeholder);
  const r = await type(p2, 'zzzznope');
  console.log(`      placeholder: "${ph}"\n      empty: "${r.noneText}"`);
  check('the placeholder is translated', !/search/i.test(ph), ph);
  check('so is the nothing-found line', !/nothing matches/i.test(r.noneText), r.noneText);
  check('and it still repeats the query', /zzzznope/.test(r.noneText), r.noneText);
  const hit = await type(p2, 'epcot');
  check('and it still finds parks', hit.rows[0]?.slug === 'epcot', JSON.stringify(hit.rows.map((x) => x.slug)));
  await p2.locator('.parkfind').screenshot({ path: path.join(ROOT, 'parksearch_pt.png') }).catch(() => {});
  await c2.close();
}

console.log(fail ? `\n=== ${fail} failures ===` : '\n=== any of the parks, from anything you would type ===');
await browser.close();
process.exit(fail ? 1 : 0);
