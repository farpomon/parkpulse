// The plan email is written for one particular day. Its links restore the
// park -- and, when the plan is for a day that has not arrived yet, the day
// as well. Without that the reader opens the link, sees today's running
// order, and the email and the app disagree about their own trip.
//
// Drives the real deep link in a real browser: /app?park=X&date=Y.
import { launchBrowser } from './browser.mjs';

const B = process.env.PP_BASE || 'http://127.0.0.1:9695';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };
const browser = await launchBrowser();

// A forecast the test owns, so the horizon is a fact and not the weather.
const TZ = 'America/New_York';
const iso = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', { timeZone: TZ });
const DAYS = Array.from({ length: 7 }, (_, i) => ({
  date: iso(i),
  dow: new Date(Date.now() + i * 86400000).toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short' }),
  level: 2, label: 'Mild', score: 40, factor: 0.95,
}));
const TODAY = DAYS[0].date, TARGET = DAYS[3].date, PAST = iso(-2), BEYOND = iso(30);

async function open(query) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 }, userAgent: UA, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.addInitScript(() => { localStorage.setItem('pp-onboarded', '1'); localStorage.setItem('pp-park', 'magic-kingdom'); });
  const json = (b) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
  // The pass is what buys a planning horizon; grant it the way the app does.
  await page.route('**/api/config', async (r) => {
    const orig = await r.fetch();
    const cfg = await orig.json();
    cfg.proGate = false;
    r.fulfill(json(cfg));
  });
  await page.route('**/api/forecast/**', (r) => r.fulfill(json({ park: 'Magic Kingdom', days: DAYS, best: DAYS[0].dow, measuredDays: 0 })));
  await page.route('**/api/waits/**', (r) => r.fulfill(json({
    park: 'Magic Kingdom', source: 'live', attribution: 's', updatedAt: new Date().toISOString(),
    rides: [{ name: 'Space Mountain', land: 'A', wait: 40, open: true, typical: 45 }, { name: 'Haunted Mansion', land: 'B', wait: 25, open: true, typical: 30 }],
  })));
  for (const p of ['**/api/ride-tags/**', '**/api/closures/**', '**/api/weather/**', '**/api/dining/**', '**/api/trip']) await page.route(p, (r) => r.fulfill(json({})));
  await page.route('**/api/consultant', (r) => r.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: 'event: done\ndata: {}\n\n' }));
  await page.goto(B + query, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(3200);
  await page.evaluate(() => { for (const i of ['onboard', 'onboard-bg', 'acct-sheet', 'acct-bg', 'gate', 'sheet', 'sheet-bg', 'll-sheet', 'trip-sheet']) document.getElementById(i)?.classList.remove('open'); });
  const state = await page.evaluate(() => ({
    day: document.getElementById('plan-day-sel')?.value ?? null,
    options: [...(document.getElementById('plan-day-sel')?.options || [])].map((o) => o.value),
    park: localStorage.getItem('pp-park'),
    url: location.pathname + location.search,
    startHour: document.getElementById('start-hour')?.value,
  }));
  await ctx.close();
  return { state, errs };
}

console.log(`\n[a link for ${TARGET}]`);
{
  const { state, errs } = await open(`/app?park=magic-kingdom&date=${TARGET}`);
  check('the park came back', state.park === 'magic-kingdom', state.park);
  check('the day picker offers it', state.options.includes(TARGET), state.options.join(', '));
  check('and it is the day being planned', state.day === TARGET, `picker shows "${state.day}"`);
  check('a future day opens at the gates, not "now"', state.startHour !== 'now', state.startHour);
  check('both params are cleaned off the address bar', state.url === '/app', state.url);
  check('no page errors', errs.length === 0, errs[0]);
}

console.log('\n[a link the reader opened too late]');
{
  const { state } = await open(`/app?park=magic-kingdom&date=${PAST}`);
  check('a day that has already been falls back to today', state.day === '' || state.day === TODAY, `picker shows "${state.day}"`);
}

console.log('\n[a day this pass cannot reach]');
{
  const { state } = await open(`/app?park=magic-kingdom&date=${BEYOND}`);
  check('a day beyond the horizon falls back to today', state.day === '' || state.day === TODAY, `picker shows "${state.day}"`);
}

console.log('\n[no date at all]');
{
  const { state } = await open('/app?park=magic-kingdom');
  check('the old link still works', state.park === 'magic-kingdom' && (state.day === '' || state.day === TODAY), `${state.park} / "${state.day}"`);
}

console.log(fail ? `\n=== ${fail} failures ===` : '\n=== the emailed link restores the day it was written for ===');
await browser.close();
process.exit(fail ? 1 : 0);
