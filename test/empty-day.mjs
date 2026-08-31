// "Mila couldn't fill this day" told the reader to change their arrival and
// departure times. Reported from production with a screenshot, and the advice
// was wrong every single time it appeared: the clock is never why this card
// shows up.
//
// Two things put it on screen. The park's whole board reads closed, so the
// picker finds nothing to pick -- and, until this was fixed, planning a day
// that has not arrived yet ALSO went down that path, because the picker only
// ever looked at what was open right now. Planning next Saturday from your
// sofa on a Thursday evening was a dead end with a misleading way out.
import { launchBrowser } from './browser.mjs';

const B = process.env.PP_BASE || 'http://127.0.0.1:9695';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };
const browser = await launchBrowser();

const TZ = 'America/New_York';
const iso = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', { timeZone: TZ });
const DAYS = Array.from({ length: 7 }, (_, i) => ({ date: iso(i), dow: 'Mon', level: 2, label: 'Mild', score: 40, factor: 0.95 }));
// The park as it reads at closing time: everything shut, no live waits.
const SHUT = [
  { name: 'Space Mountain', land: 'A', wait: 0, open: false, typical: 120 },
  { name: 'Haunted Mansion', land: 'B', wait: 0, open: false, typical: 105 },
];

let asked = null;
const visit = async (query) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 }, userAgent: UA, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.addInitScript(() => { localStorage.setItem('pp-onboarded', '1'); localStorage.setItem('pp-park', 'magic-kingdom'); localStorage.setItem('pp-lang', 'pt'); });
  const json = (b) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
  await page.route('**/api/config', async (r) => {
    const o = await r.fetch(); const c = await o.json();
    // The test server has no API key, and without one the app hides every
    // route to Mila -- including the button this file exists to check.
    c.proGate = false; c.consultant = true; c.consultantAccess = true;
    r.fulfill(json(c));
  });
  await page.route('**/api/forecast/**', (r) => r.fulfill(json({ park: 'x', days: DAYS, best: 'Mon', measuredDays: 0 })));
  await page.route('**/api/waits/**', (r) => r.fulfill(json({ park: 'x', source: 'live', attribution: 's', updatedAt: new Date().toISOString(), rides: SHUT })));
  for (const p of ['**/api/ride-tags/**', '**/api/closures/**', '**/api/weather/**', '**/api/geo/**', '**/api/trip']) await page.route(p, (r) => r.fulfill(json({})));
  await page.route('**/api/dining/**', (r) => r.fulfill(json({ park: 'x', reserve: null, list: [] })));
  await page.route('**/api/consultant', (r) => {
    try { asked = JSON.parse(r.request().postData() || '{}'); } catch {}
    r.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: 'event: done\ndata: {}\n\n' });
  });
  await page.goto(B + query, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(3200);
  await page.evaluate(() => { for (const i of ['onboard', 'onboard-bg', 'acct-sheet', 'acct-bg', 'gate', 'sheet', 'sheet-bg', 'll-sheet', 'trip-sheet']) document.getElementById(i)?.classList.remove('open'); });
  await page.evaluate(() => document.querySelector('.tabbar button[data-tab="plan"]')?.click());
  await page.waitForTimeout(300);
  await page.evaluate(() => (document.getElementById('plan-hero-btn') || document.getElementById('build'))?.click());
  await page.waitForTimeout(2800);
  const out = {
    card: await page.evaluate(() => document.getElementById('plan-out')?.innerText || ''),
    mila: await page.evaluate(() => Boolean(document.getElementById('plan-ask-mila'))),
    stops: await page.evaluate(() => document.querySelectorAll('#plan-out .plan').length),
    page, ctx, errs,
  };
  return out;
};

console.log('\n[a day that has not arrived, planned while the park is shut]');
{
  const r = await visit(`/app?park=magic-kingdom&date=${DAYS[3].date}`);
  check('Saturday gets planned even with tonight closed', !/não conseguiu preencher/.test(r.card), r.card.slice(0, 140));
  check('and it is a real running order', r.stops > 0, String(r.stops));
  check('no page errors', r.errs.length === 0, r.errs[0]);
  await r.ctx.close();
}

console.log('\n[today, with the whole board closed]');
{
  const r = await visit('/app?park=magic-kingdom');
  check('Mila says she could not fill it', /não conseguiu preencher/.test(r.card), r.card.slice(0, 100));
  check('and names the real reason — everything is closed', /aparecendo como fechadas/.test(r.card), r.card.slice(0, 220));
  check('instead of blaming the arrival and departure times', !/hora de chegada/.test(r.card), r.card.slice(0, 220));
  check('the way out is a different day or park', /Planeje um dia mais para frente/.test(r.card), r.card.slice(0, 260));
  check('and Mila is reachable from the dead end', r.mila, r.card.slice(0, 120));

  await r.page.evaluate(() => document.getElementById('plan-ask-mila')?.click());
  await r.page.waitForTimeout(1500);
  const q = String(asked?.messages?.[0]?.content || '');
  check('her question carries the day that failed', /Magic Kingdom/.test(q), q.slice(0, 160));
  check('and the hours it was tried with', /(AM|PM)/.test(q), q.slice(0, 160));
  check('asked in the reader\'s language', /chego|saio|conseguiu/i.test(q), q.slice(0, 160));
  check('no page errors', r.errs.length === 0, r.errs[0]);
  await r.ctx.close();
}

await browser.close();
console.log(`\n=== ${fail ? fail + ' failed' : 'the card says what is actually wrong, and Mila is one tap away'} ===`);
process.exit(fail ? 1 : 0);
