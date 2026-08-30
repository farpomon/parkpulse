// Tapping "fit these in with a skip pass" opened a panel that was English top
// to bottom in a Portuguese app. This opens it for real in several languages
// and reads back every word in it.
import { launchBrowser } from './browser.mjs';
import fs from 'node:fs';
import os from 'node:os';
const B = process.env.PP_BASE || 'http://127.0.0.1:9695';
// A screenshot for eyeballing, written wherever this machine puts temp files.
const SCRATCH = process.env.PP_SHOTS || os.tmpdir();
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
// Enough rides that the planner has to leave some out — the sheet only opens
// for the ones that did not fit.
const RIDES = Array.from({ length: 16 }, (_, i) => ({
  name: `Attraction ${i + 1}`, land: ['Fantasyland', 'Tomorrowland'][i % 2],
  wait: 30 + (i % 7) * 15, open: true, typical: 35 + (i % 7) * 15,
}));
let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };
const browser = await launchBrowser();

// Anything left in English is a leak. Words that are the same in every
// language (the pass's official name, ride names, numbers) are not.
const EN = /\b(per person|per day|per ride|Update my plan|Ask Mila first|Close|Prices float daily|before buying|one pass covers|top headliners|sold separately|for the day)\b/i;

async function openSheet(lang) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 }, userAgent: UA, isMobile: true, hasTouch: true, serviceWorkers: 'block', deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.addInitScript((l) => {
    localStorage.setItem('pp-onboarded', '1'); localStorage.setItem('pp-park', 'magic-kingdom');
    if (l !== 'en') localStorage.setItem('pp-lang', l);
  }, lang);
  await page.route('**/api/waits/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ park: 'x', source: 'live', attribution: 's', updatedAt: new Date().toISOString(), rides: RIDES }) }));
  for (const p of ['**/api/ride-tags/**', '**/api/closures/**', '**/api/weather/**']) await page.route(p, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/consultant', (r) => r.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: 'event: delta\ndata: {"text":"."}\n\nevent: done\ndata: {}\n\n' }));
  await page.goto(B + '/app', { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(2400);
  await page.evaluate(() => { for (const i of ['onboard', 'onboard-bg', 'acct-sheet', 'acct-bg', 'gate']) document.getElementById(i)?.classList.remove('open'); });
  await page.evaluate(() => document.querySelectorAll('#rides input[type=checkbox][data-name]').forEach((c) => { if (!c.disabled && !c.checked) c.click(); }));
  await page.evaluate(() => document.querySelector('.tabbar button[data-tab="plan"]')?.click());
  await page.waitForTimeout(500);
  await page.evaluate(() => (document.getElementById('plan-hero-btn') || document.getElementById('build'))?.click());
  await page.waitForTimeout(2600);
  // The "fit them in with a pass" button under the leftovers.
  const opened = await page.evaluate(() => {
    const b = [...document.querySelectorAll('#plan-out button')].find((x) => /🎟/.test(x.textContent));
    if (!b) return false;
    b.click();
    return true;
  });
  await page.waitForTimeout(500);
  const sheet = await page.evaluate(() => {
    const el = document.getElementById('ll-sheet');
    const t = (id) => document.getElementById(id)?.textContent.trim() || '';
    return {
      open: !!el && el.classList.contains('open'),
      title: t('ll-title'), info: t('ll-info'), cost: t('ll-cost'),
      note: t('ll-price-note'), apply: t('ll-apply'), ask: t('ll-ask'), close: t('ll-cancel'),
    };
  });
  return { ctx, page, sheet, opened, errs };
}

for (const lang of ['pt', 'ja', 'ar']) {
  console.log(`\n[${lang}]`);
  const { ctx, page, sheet, opened, errs } = await openSheet(lang);
  check('the sheet opens', opened && sheet.open, JSON.stringify(sheet).slice(0, 80));
  for (const [k, v] of Object.entries(sheet)) if (k !== 'open') console.log(`      ${k.padEnd(6)} ${v}`);
  // The pass keeps its official English name on purpose; everything else must move.
  for (const k of ['info', 'cost', 'note', 'apply', 'ask', 'close']) {
    check(`${k} is not English`, !EN.test(sheet[k]), sheet[k]);
  }
  check('the price band survived', /\d/.test(sheet.info), sheet.info);
  check('the cost line kept its number', /\d/.test(sheet.cost), sheet.cost);
  check('no placeholder leaked through', !/\{\w+\}/.test(sheet.cost + sheet.info), sheet.cost);
  check('she is not called "the AI"', !/\bAI\b/.test(sheet.ask), sheet.ask);
  check('no page errors', errs.length === 0, errs[0]);
  if (lang === 'pt') await page.locator('#ll-sheet').screenshot({ path: `${SCRATCH}/llsheet_pt.png` });
  await ctx.close();
}
console.log(fail ? `\n=== ${fail} failures ===` : '\n=== the pass sheet speaks the reader\'s language ===');
await browser.close();
process.exit(fail ? 1 : 0);
