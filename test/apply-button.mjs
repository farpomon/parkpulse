// Reported with a screenshot: on the plan panel Mila wrote out a full reorder
// — swap the coasters out of the 39-degree hour, save the water ride for the
// heat peak — and there was no button to take any of it. The server half is
// covered in plan-card.cjs; this is the other half, in a real browser: when a
// plan action arrives, the reader must get something to press, and pressing it
// must actually change the day.
import { launchBrowser } from './browser.mjs';

const B = process.env.PP_BASE || 'http://127.0.0.1:9695';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };
const browser = await launchBrowser();

const TZ = 'America/New_York';
const iso = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', { timeZone: TZ });
const DAYS = Array.from({ length: 7 }, (_, i) => ({ date: iso(i), dow: 'Mon', level: 2, label: 'Mild', score: 40, factor: 0.95 }));
// Waits chosen so Pip's own order is predictable: he takes the short queues
// first, so Jungle Cruise leads and Space Mountain trails.
const RIDES = [
  { name: 'Space Mountain', land: 'Tomorrowland', wait: 75, open: true, typical: 80 },
  { name: 'Haunted Mansion', land: 'Liberty Square', wait: 35, open: true, typical: 40 },
  { name: 'Jungle Cruise', land: 'Adventureland', wait: 15, open: true, typical: 20 },
];
// The order Mila proposes — deliberately the reverse of Pip's.
const HER_ORDER = ['Space Mountain', 'Haunted Mansion', 'Jungle Cruise'];

const ctx = await browser.newContext({ viewport: { width: 390, height: 900 }, userAgent: UA, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.addInitScript(() => { localStorage.setItem('pp-onboarded', '1'); localStorage.setItem('pp-park', 'magic-kingdom'); });
const json = (b) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
await page.route('**/api/config', async (r) => {
  const o = await r.fetch(); const c = await o.json();
  c.proGate = false; c.consultant = true; c.consultantAccess = true;
  r.fulfill(json(c));
});
await page.route('**/api/forecast/**', (r) => r.fulfill(json({ park: 'x', days: DAYS, best: 'Mon', measuredDays: 0 })));
await page.route('**/api/waits/**', (r) => r.fulfill(json({ park: 'x', source: 'live', attribution: 's', updatedAt: new Date().toISOString(), rides: RIDES })));
for (const p of ['**/api/ride-tags/**', '**/api/closures/**', '**/api/weather/**', '**/api/geo/**', '**/api/trip']) await page.route(p, (r) => r.fulfill(json({})));
await page.route('**/api/dining/**', (r) => r.fulfill(json({ park: 'x', reserve: null, list: [] })));
// Exactly what the server sends when she proposes a reorder: her prose, then
// the plan action, then done.
await page.route('**/api/consultant', (r) => r.fulfill({
  status: 200, headers: { 'content-type': 'text/event-stream' },
  body: `event: delta\ndata: ${JSON.stringify({ text: 'I would flip it — take the headliner first while the queue is short.' })}\n\n`
      + `event: action\ndata: ${JSON.stringify({ type: 'plan', park: 'magic-kingdom', rides: HER_ORDER })}\n\n`
      + 'event: done\ndata: {}\n\n',
}));

await page.goto(B + '/app?park=magic-kingdom', { waitUntil: 'domcontentloaded', timeout: 25000 });
await page.waitForTimeout(3000);
await page.evaluate(() => { for (const i of ['onboard', 'onboard-bg', 'acct-sheet', 'acct-bg', 'gate', 'sheet', 'sheet-bg', 'll-sheet', 'trip-sheet']) document.getElementById(i)?.classList.remove('open'); });
await page.evaluate(() => document.querySelector('.tabbar button[data-tab="today"]')?.click());
await page.waitForTimeout(300);
await page.evaluate(() => document.querySelectorAll('#rides input[type=checkbox][data-name]').forEach((c) => { if (!c.disabled && !c.checked) c.click(); }));
await page.evaluate(() => document.querySelector('.tabbar button[data-tab="plan"]')?.click());
await page.waitForTimeout(300);
await page.evaluate(() => (document.getElementById('plan-hero-btn') || document.getElementById('build'))?.click());
await page.waitForTimeout(3000);

// The order actually on screen, top to bottom.
// A plan step is .step, and the ride's name leads its .what cell.
const order = () => page.evaluate(() => [...document.querySelectorAll('#plan-out .step')]
  .map((el) => (el.querySelector('.what')?.textContent || '').split('·')[0].trim())
  .filter((n) => n && !/^[🍽🌇🎆🏁]/u.test(n)));

console.log('\n[she proposes an order the reader can take]');
{
  const before = await order();
  check('Pip built a day first', before.length >= 2, JSON.stringify(before));
  const btn = await page.evaluate(() => {
    const b = document.getElementById('planai-apply');
    return b ? { there: true, label: b.textContent.trim() } : { there: false };
  });
  console.log(`      button: ${JSON.stringify(btn)}`);
  check('her reorder comes with a button', btn.there === true, JSON.stringify(btn));
  check('and the button says what it does', (btn.label || '').length > 0, JSON.stringify(btn.label));
  check('her prose is on screen too', /flip it/.test(await page.evaluate(() => document.getElementById('planai-body')?.innerText || '')), 'prose missing');
}

console.log('\n[pressing it adopts her order]');
{
  const before = await order();
  const creditBefore = await page.evaluate(() => document.getElementById('planby')?.textContent.trim() || '');
  await page.evaluate(() => document.getElementById('planai-apply')?.click());
  await page.waitForTimeout(2600);
  const after = await order();
  const credit = await page.evaluate(() => document.getElementById('planby')?.textContent.trim() || '');
  console.log(`      before: ${JSON.stringify(before.slice(0, 3))}\n      after:  ${JSON.stringify(after.slice(0, 3))}\n      credit: ${JSON.stringify(credit)}`);

  // NOT "the order changed". Pip scores rides against the hour's crowd curve,
  // so at some hours he independently arrives at the same sequence Mila
  // proposes -- and then adopting it correctly changes nothing. Asserting a
  // difference made this test pass or fail by the clock, which is no kind of
  // test. What must always be true is that the day now runs in HER order and
  // that the plan says so.
  check('the day now runs in her order', JSON.stringify(after.slice(0, HER_ORDER.length)) === JSON.stringify(HER_ORDER),
    JSON.stringify(after.slice(0, HER_ORDER.length)));
  check('and the plan credits her for it', /Mila chose this order/.test(credit), JSON.stringify({ creditBefore, credit }));
  check('which it did not before', !/Mila chose this order/.test(creditBefore), JSON.stringify(creditBefore));
  check('no page errors', errs.length === 0, errs[0]);
}

await browser.close();
console.log(`\n=== ${fail ? fail + ' failed' : 'an offer she makes is an offer the reader can take'} ===`);
process.exit(fail ? 1 : 0);
