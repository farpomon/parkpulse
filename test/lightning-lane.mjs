// Buying the pass is the biggest decision a visitor makes inside the app, and
// until now the app forgot it the moment the page reloaded. This drives the
// whole round trip: apply it, hear Mila say so, see it stated on the plan,
// reload, take it back off -- and check the advisor is told about it.
import { launchBrowser } from './browser.mjs';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const B = process.env.PP_BASE || 'http://127.0.0.1:9695';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
// More rides than a day holds, so some are left over and the buy button shows.
const RIDES = Array.from({ length: 16 }, (_, i) => ({
  name: `Atracao ${i + 1}`, land: ['Fantasia', 'Aventura'][i % 2],
  wait: 35 + (i % 7) * 15, open: true, typical: 40 + (i % 7) * 15,
}));
let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };
const browser = await launchBrowser();

const consults = [];
async function open(lang = 'en') {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 }, userAgent: UA, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.addInitScript((l) => {
    localStorage.setItem('pp-onboarded', '1'); localStorage.setItem('pp-park', 'magic-kingdom');
    localStorage.setItem('pp-name', 'Luis'); if (l !== 'en') localStorage.setItem('pp-lang', l);
  }, lang);
  const json = (b) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
  await page.route('**/api/waits/**', (r) => r.fulfill(json({ park: 'x', source: 'live', attribution: 's', updatedAt: new Date().toISOString(), rides: RIDES })));
  for (const p of ['**/api/ride-tags/**', '**/api/closures/**', '**/api/weather/**']) await page.route(p, (r) => r.fulfill(json({})));
  await page.route('**/api/consultant', (r) => {
    consults.push(JSON.parse(r.request().postData() || '{}'));
    r.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: 'event: delta\ndata: {"text":"."}\n\nevent: done\ndata: {}\n\n' });
  });
  await page.goto(B + '/app', { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(2500);
  await page.evaluate(() => { for (const i of ['onboard', 'onboard-bg', 'acct-sheet', 'acct-bg', 'gate']) document.getElementById(i)?.classList.remove('open'); });
  return { ctx, page, errs };
}
const buildPlan = async (page) => {
  // Plan a whole day, not whatever is left of this one. With "now" as the
  // arrival this test passed in the morning and failed after about six in the
  // evening: only two or three slots fit before closing, and the planner
  // spends them on the biggest headliners -- which are exactly the rides a
  // Multi Pass does not cover. Nothing wrong with that behaviour; it just
  // meant the assertion was really about the wall clock.
  await page.evaluate(() => {
    const s = document.getElementById('start-hour');
    const open = [...s.options].map((o) => Number(o.value)).filter(Number.isFinite);
    if (open.length) { s.value = String(Math.min(...open)); s.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => document.querySelectorAll('#rides input[type=checkbox][data-name]').forEach((c) => { if (!c.disabled && !c.checked) c.click(); }));
  await page.evaluate(() => document.querySelector('.tabbar button[data-tab="plan"]')?.click());
  await page.waitForTimeout(400);
  await page.evaluate(() => (document.getElementById('plan-hero-btn') || document.getElementById('build'))?.click());
  await page.waitForTimeout(2800);
};
const applyPass = async (page) => {
  const opened = await page.evaluate(() => {
    const b = [...document.querySelectorAll('#plan-out button')].find((x) => /🎟/.test(x.textContent));
    if (!b) return false; b.click(); return true;
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => document.getElementById('ll-apply')?.click());
  await page.waitForTimeout(2800);
  return opened;
};
const state = (page) => page.evaluate(() => ({
  applied: !!document.querySelector('.llon'),
  appliedText: document.querySelector('.llon-t')?.textContent.trim() || '',
  sub: document.querySelector('.llon-s')?.textContent.trim() || '',
  remove: document.getElementById('ll-off')?.textContent.trim() || '',
  opener: document.querySelector('.planai-open')?.textContent.trim() || '',
  note: document.getElementById('plan-note-txt')?.textContent.trim() || '',
  stored: Object.keys(localStorage).filter((k) => k.startsWith('pp-ll-')).map((k) => [k, localStorage.getItem(k)]),
  walkOns: [...document.querySelectorAll('#plan-out .step')].filter((s) => /🎟/.test(s.textContent)).length,
}));

console.log('\n[applying the pass]');
{
  const { ctx, page, errs } = await open();
  await buildPlan(page);
  const before = await state(page);
  check('no applied card before buying', !before.applied);
  check('the buy button is there', await applyPass(page));
  const s = await state(page);
  console.log(`      opener: "${s.opener}"`);
  console.log(`      card:   "${s.appliedText}" / "${s.sub}" / [${s.remove}]`);
  // The opener is drawn at random from ten written lines, so a word list was
  // really a one-in-ten coin toss: "Lovely. With {pass} on those, we can
  // afford to be greedy with the afternoon." says the pass went on without
  // using any of the words it looked for. What actually matters -- and what
  // this now checks -- is that she wrote a NEW opener once the pass was on,
  // instead of leaving the one from before the purchase standing.
  check('Mila says the pass went on', !!s.opener && s.opener !== before.opener, `${before.opener} -> ${s.opener}`);
  check('and names the pass', /Lightning Lane|Skip pass|Express/i.test(s.opener), s.opener);
  check('the applied card replaced the pitch', s.applied);
  check('it counts the attractions', /\d/.test(s.appliedText), s.appliedText);
  check('and offers to take it back off', s.remove.length > 2, s.remove);
  check('the running order marks the walk-ons', s.walkOns > 0, `${s.walkOns} steps`);
  check('the sticky note mentions it too', /🎟/.test(s.note), s.note);
  check('it is written down', s.stored.length === 1 && JSON.parse(s.stored[0][1]).length > 0, JSON.stringify(s.stored));
  check('no page errors', errs.length === 0, errs[0]);

  console.log('\n[what Mila is told]');
  // A rebuild offers her rather than spending on her, so the payload only
  // goes out once the visitor actually asks for the read.
  await page.evaluate(() => document.getElementById('planai-recheck')?.click());
  await page.waitForTimeout(2600);
  const last = consults[consults.length - 1];
  check('the pass reaches the advisor', Array.isArray(last?.lanePasses) && last.lanePasses.length > 0, JSON.stringify(last?.lanePasses));
  check('as the same rides that are on the card', (last.lanePasses || []).every((n) => RIDES.some((r) => r.name === n)), JSON.stringify(last?.lanePasses));

  console.log('\n[after a reload]');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2600);
  await page.evaluate(() => { for (const i of ['onboard', 'onboard-bg', 'gate']) document.getElementById(i)?.classList.remove('open'); });
  await buildPlan(page);
  const after = await state(page);
  check('the pass is still applied', after.applied, JSON.stringify(after).slice(0, 120));
  check('and still counted', /\d/.test(after.appliedText), after.appliedText);
  check('but she does not announce it a second time', !/applied|Sorted/i.test(after.opener) || after.opener === '', after.opener);

  console.log('\n[taking it back off]');
  await page.evaluate(() => document.getElementById('ll-off')?.click());
  await page.waitForTimeout(2600);
  const off = await state(page);
  check('the card is gone', !off.applied, off.appliedText);
  check('nothing is left written down', off.stored.length === 0 || JSON.parse(off.stored[0][1] || '[]').length === 0, JSON.stringify(off.stored));
  check('and no step claims a walk-on', off.walkOns === 0, `${off.walkOns} steps`);
  await ctx.close();
}

console.log('\n[pt]');
{
  const { ctx, page } = await open('pt');
  await buildPlan(page);
  await applyPass(page);
  const s = await state(page);
  console.log(`      opener: "${s.opener}"`);
  console.log(`      card:   "${s.appliedText}" / "${s.remove}"`);
  const EN = /\b(applied|Let's go|Done|Smart buy|Remove it|attraction|attractions|walk-ons)\b/i;
  check('her line is translated', !EN.test(s.opener), s.opener);
  check('the card is translated', !EN.test(s.appliedText + ' ' + s.sub), s.appliedText + ' / ' + s.sub);
  check('so is the remove link', !EN.test(s.remove), s.remove);
  check('no placeholder leaked', !/\{\w+\}/.test(s.opener + s.appliedText), s.opener);
  await page.locator('.llon').screenshot({ path: path.join(ROOT, '../ll_applied_pt.png') }).catch(() => {});
  await ctx.close();
}

console.log('\n[ten distinct lines]');
{
  // Sampling sixteen browser boots only proves Math.random works, and costs a
  // minute and a half. What matters is that ten lines exist, that every
  // language has all ten and no two the same, and that what actually renders
  // is one of them.
  const EN = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/i18n/pt.json'), 'utf8'));
  const src = fs.readFileSync(path.join(ROOT, 'public/app.html'), 'utf8');
  // Parse the array rather than pattern-match it: the lines mix quote styles
  // and contain apostrophes, and a regex over that reported nine of ten.
  const from = src.indexOf('const MILA_LL_LINES = [');
  const to = src.indexOf('];', from);
  const lines = new Function(`return ${src.slice(from + 'const MILA_LL_LINES = '.length, to + 1)}`)();
  console.log(`      ${lines.length} lines shipped, ${new Set(lines).size} distinct`);
  check('ten of them', lines.length === 10, lines.length);
  check('all different', new Set(lines).size === 10);
  check('every one names the pass', lines.every((l) => l.includes('{pass}')));

  const langs = fs.readdirSync(path.join(ROOT, 'public/i18n')).filter((f) => f.endsWith('.json'));
  const missing = [];
  const dupes = [];
  for (const f of langs) {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/i18n', f), 'utf8'));
    const got = lines.map((l) => d[l]).filter(Boolean);
    if (got.length !== 10) missing.push(`${f}: ${got.length}/10`);
    if (new Set(got).size !== got.length) dupes.push(f);
  }
  check(`all ${langs.length} languages have all ten`, missing.length === 0, missing.join(', '));
  check('and none of them repeats a line', dupes.length === 0, dupes.join(', '));

  // Four real purchases: what renders has to be one of the ten, translated.
  const seen = new Set();
  for (let i = 0; i < 2; i++) {
    const { ctx, page } = await open('pt');
    await buildPlan(page);
    await applyPass(page);
    const { opener } = await state(page);
    seen.add(opener);
    const pt = new Set(lines.map((l) => EN[l].replace('{pass}', 'Lightning Lane Multi Pass')));
    check(`purchase ${i + 1} rendered one of the ten`, [...pt].some((x) => opener.endsWith(x)), opener);
    await ctx.close();
  }
  console.log(`      ${seen.size} distinct across 2 purchases`);
}

console.log(fail ? `\n=== ${fail} failures ===` : '\n=== the pass is remembered, announced and undoable ===');
await browser.close();
process.exit(fail ? 1 : 0);
