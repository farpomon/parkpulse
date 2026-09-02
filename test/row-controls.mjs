// What sits beside a ride's name.
//
// The star went. "Left out of your plan" takes its slot, before the name:
// ruling a ride out is a decision about the plan, and it belongs with the
// checkbox that puts rides in, not among the after-the-fact controls on the
// right. The right-hand pair -- ridden, alert -- stays where it was.
import { launchBrowser } from './browser.mjs';

const B = process.env.PP_BASE || 'http://127.0.0.1:9695';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };

// One land on purpose: rides are ordered within their land, so "sinks to the
// bottom" means the bottom of that land's list, not of the whole board.
const RIDES = [
  { name: 'Pirates of the Caribbean', land: 'Adventureland', wait: 45, open: true, typical: 40 },
  { name: 'Jungle Cruise', land: 'Adventureland', wait: 25, open: true, typical: 30 },
  { name: 'Magic Carpets of Aladdin', land: 'Adventureland', wait: 30, open: true, typical: 35 },
];
const browser = await launchBrowser();
const ctx = await browser.newContext({ viewport: { width: 390, height: 900 }, userAgent: UA, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.addInitScript(() => { localStorage.setItem('pp-onboarded', '1'); localStorage.setItem('pp-park', 'magic-kingdom'); });
const json = (b) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
await page.route('**/api/config', async (r) => { const c = await (await r.fetch()).json(); c.proGate = false; for (const p of Object.values(c.parks || {})) { p.open = 0; p.close = 24; } r.fulfill(json(c)); });
await page.route('**/api/waits/**', (r) => r.fulfill(json({ park: 'Magic Kingdom', source: 'live', attribution: 's', updatedAt: new Date().toISOString(), rides: RIDES })));
await page.route('**/api/ride-tags/**', (r) => r.fulfill(json({ tags: {} })));
for (const p of ['**/api/closures/**', '**/api/weather/**', '**/api/dining/**', '**/api/trip']) await page.route(p, (r) => r.fulfill(json({})));
await page.goto(B + '/app', { waitUntil: 'domcontentloaded', timeout: 25000 });
await page.waitForTimeout(2500);
await page.evaluate(() => { for (const i of ['onboard', 'onboard-bg', 'acct-sheet', 'acct-bg', 'gate', 'sheet-bg']) document.getElementById(i)?.classList.remove('open'); });
await page.evaluate(() => document.querySelector('.tabbar button[data-tab="today"]')?.click());
await page.waitForTimeout(400);

const row = () => page.evaluate(() => {
  const r = document.querySelector('#rides .ride');
  if (!r) return null;
  const kids = [...r.children].map((el) => el.className.split(' ')[0] || el.tagName.toLowerCase());
  return { kids, star: !!r.querySelector('.star'), skipBeforeName: kids.indexOf('skip') !== -1 && kids.indexOf('skip') < kids.indexOf('mid'), isskip: r.classList.contains('isskip') };
});
console.log('\n[a ride row]');
let r = await row();
check('there is a row to look at', !!r, JSON.stringify(r));
check('no star on it', r && !r.star, JSON.stringify(r && r.kids));
check('"left out" sits before the name, where the star was', r && r.skipBeforeName, JSON.stringify(r && r.kids));
check('ridden and alert still sit after the name', r && r.kids.indexOf('rode') > r.kids.indexOf('mid') && r.kids.indexOf('bell') > r.kids.indexOf('mid'), JSON.stringify(r && r.kids));
await page.evaluate(() => document.querySelector('#rides .ride > .skip')?.click());
await page.waitForTimeout(500);
r = await row();
check('tapping it rules the ride out', await page.evaluate(() => [...document.querySelectorAll('#rides .ride')].some((x) => x.classList.contains('isskip'))));
const order = await page.evaluate(() => [...document.querySelectorAll('#rides .ride')].map((x) => (x.querySelector('.name')?.textContent || '') + (x.classList.contains('isskip') ? ' (out)' : '')));
check('and the ruled-out ride sinks to the bottom of its land', order.length === 3 && /\(out\)$/.test(order[2]) && !/\(out\)/.test(order[0]), JSON.stringify(order));
check('no page errors', errs.length === 0, errs[0]);
await browser.close();
console.log(fail ? `\n=== ${fail} failures ===` : '\n=== the row reads: in, out, name, ridden, alert ===');
process.exit(fail ? 1 : 0);
