// Which park is showing and which tab is open are two different questions,
// and choosing a park is not an answer to the second.
//
// Switching parks used to throw a reader out of Plan and onto attractions --
// alone among the tabs, since dining and the map both stayed put. That broke
// the one comparison people actually make, the same day at two parks, because
// it could not be made without navigating back every single time.
import { launchBrowser } from './browser.mjs';

const B = process.env.PP_BASE || 'http://127.0.0.1:9695';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };
const browser = await launchBrowser();

const TZ = 'America/New_York';
const iso = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', { timeZone: TZ });
const DAYS = Array.from({ length: 7 }, (_, i) => ({
  date: iso(i), dow: new Date(Date.now() + i * 86400000).toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short' }),
  level: 2, label: 'Mild', score: 40, factor: 0.95,
}));
const RIDES = [
  { name: 'Space Mountain', land: 'A', wait: 40, open: true, typical: 45 },
  { name: 'Haunted Mansion', land: 'B', wait: 25, open: true, typical: 30 },
];

const ctx = await browser.newContext({ viewport: { width: 390, height: 900 }, userAgent: UA, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.addInitScript(() => { localStorage.setItem('pp-onboarded', '1'); localStorage.setItem('pp-park', 'magic-kingdom'); });
const json = (b) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
await page.route('**/api/config', async (r) => {
  const orig = await r.fetch(); const cfg = await orig.json(); cfg.proGate = false; r.fulfill(json(cfg));
});
await page.route('**/api/forecast/**', (r) => r.fulfill(json({ park: 'x', days: DAYS, best: DAYS[0].dow, measuredDays: 0 })));
await page.route('**/api/waits/**', (r) => r.fulfill(json({ park: 'x', source: 'live', attribution: 's', updatedAt: new Date().toISOString(), rides: RIDES })));
for (const p of ['**/api/ride-tags/**', '**/api/closures/**', '**/api/weather/**', '**/api/geo/**', '**/api/trip']) await page.route(p, (r) => r.fulfill(json({})));
// The shape the server actually sends, so the dining tab renders rather than
// falling through to its retry message -- a tab that failed to load would
// "survive" a park switch trivially and prove nothing.
await page.route('**/api/dining/**', (r) => r.fulfill(json({
  park: 'x', reserve: null,
  list: [{ name: 'Be Our Guest', type: 'table', price: '$$$', mustBook: true, why: 'The castle one.' }],
})));
await page.route('**/api/consultant', (r) => r.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: 'event: done\ndata: {}\n\n' }));

await page.goto(B + '/app?park=magic-kingdom', { waitUntil: 'domcontentloaded', timeout: 25000 });
await page.waitForTimeout(3000);
await page.evaluate(() => { for (const i of ['onboard', 'onboard-bg', 'acct-sheet', 'acct-bg', 'gate', 'sheet', 'sheet-bg', 'll-sheet', 'trip-sheet']) document.getElementById(i)?.classList.remove('open'); });

// Which tab the app believes it is on, read the way a reader would see it:
// the highlighted button in the bar, plus the pane the body class selects.
const where = () => page.evaluate(() => ({
  lit: [...document.querySelectorAll('#tabbar button')].find((b) => b.classList.contains('on'))?.dataset.tab || null,
  planPane: document.body.classList.contains('pane-plan'),
  park: localStorage.getItem('pp-park'),
}));
const goTab = async (tab) => {
  await page.evaluate((t) => document.querySelector(`.tabbar button[data-tab="${t}"], #tabbar button[data-tab="${t}"]`)?.click(), tab);
  await page.waitForTimeout(800);
};
const swapPark = async (name) => {
  await page.evaluate((n) => {
    const t = [...document.querySelectorAll('#tabs button')].find((e) => new RegExp(n, 'i').test(e.textContent || ''));
    if (t) t.click();
  }, name);
  await page.waitForTimeout(2400);
};

for (const [label, tab, wantPlanPane] of [
  ['Plan', 'plan', true],
  ['Attractions', 'today', false],
  ['Dining', 'dining', false],
  ['Map', 'map', false],
]) {
  console.log(`\n[on ${label}, switching parks]`);
  await goTab(tab);
  const before = await where();
  check(`the app is on ${label}`, before.lit === tab && before.planPane === wantPlanPane, JSON.stringify(before));

  await swapPark('EPCOT');
  const after = await where();
  check('the park actually changed', after.park === 'epcot', after.park);
  check(`and the reader is still on ${label}`, after.lit === tab, `${after.lit} (wanted ${tab})`);
  check('  with the same pane showing', after.planPane === wantPlanPane, JSON.stringify(after));

  // And back again, because a one-way check would miss a reset that only
  // fires on the return trip.
  await swapPark('Magic Kingdom');
  const back = await where();
  check('coming back switches park again', back.park === 'magic-kingdom', back.park);
  check(`and still on ${label}`, back.lit === tab && back.planPane === wantPlanPane, JSON.stringify(back));
}

console.log('\n[the Plan tab is not left empty by the switch]');
{
  await goTab('plan');
  await swapPark('EPCOT');
  await page.waitForTimeout(600);
  // The plan itself belongs to the park just left, so it is cleared -- but the
  // pane has to offer the way to make a new one, or staying here is worse than
  // being thrown out.
  const usable = await page.evaluate(() => {
    const vis = (el) => Boolean(el && el.offsetParent !== null);
    return { hero: vis(document.getElementById('plan-hero-btn')) || vis(document.getElementById('build')),
             picker: vis(document.getElementById('pick-card')) };
  });
  check('the plan pane still offers a way to build one', usable.hero || usable.picker, JSON.stringify(usable));
}

check('no page errors along the way', errs.length === 0, errs[0]);
await browser.close();
console.log(`\n=== ${fail ? fail + ' failed' : 'the tab is the reader\'s, not the park\'s'} ===`);
process.exit(fail ? 1 : 0);
