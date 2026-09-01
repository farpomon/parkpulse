// What a visitor sees when the feed is down.
//
// The server keeps every park's last healthy board and hands it back when
// Queue-Times is quiet. That is only half the job: served honestly means the
// screen says which board it is looking at and how old it is. Get that wrong
// and the app quietly presents this morning's queues as live -- which is a
// worse failure than the empty board it replaced, because the visitor acts
// on it.
//
// So: the rides are there, the label says what it is and when, the plan warns
// about it, and nothing on the screen claims to be live.
import { launchBrowser } from './browser.mjs';

const B = process.env.PP_BASE || 'http://127.0.0.1:9695';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };

const RIDES = [
  { name: 'Space Mountain', land: 'Tomorrowland', wait: 45, open: true, typical: 40 },
  { name: 'Haunted Mansion', land: 'Liberty Square', wait: 25, open: true, typical: 30 },
  { name: 'Jungle Cruise', land: 'Adventureland', wait: 30, open: true, typical: 35 },
  { name: 'Peter Pan', land: 'Fantasyland', wait: 60, open: true, typical: 55 },
];
const HOURS_OLD = 5;

const browser = await launchBrowser();
async function screen(source) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 }, userAgent: UA, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.addInitScript(() => { localStorage.setItem('pp-onboarded', '1'); localStorage.setItem('pp-park', 'magic-kingdom'); });
  const json = (b) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
  await page.route('**/api/config', async (r) => {
    const cfg = await (await r.fetch()).json();
    cfg.proGate = false;
    // Hold the park open, or the board is in its pre-open state and the checks
    // below become a fact about what time the suite ran.
    for (const p of Object.values(cfg.parks || {})) { p.open = 0; p.close = 24; }
    r.fulfill(json(cfg));
  });
  await page.route('**/api/waits/**', (r) => r.fulfill(json({
    park: 'Magic Kingdom',
    source,
    attribution: source === 'stored' ? 'Last waits we recorded — the live feed is quiet' : 'Powered by Queue-Times.com',
    // A live board is minutes old; a stored one is hours. That difference is
    // the thing the label has to survive.
    updatedAt: new Date(Date.now() - (source === 'stored' ? HOURS_OLD * 3600 : 60) * 1000).toISOString(),
    rides: RIDES,
  })));
  await page.route('**/api/ride-tags/**', (r) => r.fulfill(json({ tags: {} })));
  for (const p of ['**/api/closures/**', '**/api/weather/**', '**/api/dining/**', '**/api/trip']) await page.route(p, (r) => r.fulfill(json({})));
  await page.route('**/api/consultant', (r) => r.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: 'event: done\ndata: {}\n\n' }));
  await page.goto(B + '/app', { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(3000);
  await page.evaluate(() => { for (const i of ['onboard', 'onboard-bg', 'acct-sheet', 'acct-bg', 'gate', 'sheet-bg']) document.getElementById(i)?.classList.remove('open'); });
  // Pick everything and build, so the plan's own warning line is on screen.
  await page.evaluate(() => document.getElementById('pick-all')?.click());
  await page.waitForTimeout(300);
  await page.evaluate(() => document.getElementById('build')?.click());
  await page.waitForTimeout(2000);
  const out = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('.ride .name')].map((n) => n.textContent.trim()),
    label: document.getElementById('updated')?.textContent?.trim() || '',
    empty: !!document.querySelector('#rides .state'),
    body: document.body.innerText,
  }));
  await ctx.close();
  return { out, errs };
}

console.log(`\n[a board from ${HOURS_OLD} hours ago, because the feed is down]`);
{
  const { out, errs } = await screen('stored');
  check('the rides are on the screen, not an empty state', out.rows.length === RIDES.length && !out.empty,
    `${out.rows.length} rows, empty state ${out.empty}`);
  check('the label says it is the last one recorded', /Last recorded/.test(out.label), out.label || '(no label)');
  check(`and how old it is, in hours`, new RegExp(`${HOURS_OLD}\\s*h ago`).test(out.label), out.label);
  // The one thing that must never happen: an old board wearing the live badge.
  check('nothing on the screen calls it live', !/\bLive\b/.test(out.label), out.label);
  check('the plan warns the day was built on it', /last waits we recorded/i.test(out.body),
    (out.body.match(/live feed is quiet[^\n]*/) || ['(no warning line)'])[0]);
  check('and the page threw nothing', errs.length === 0, errs[0]);
}

console.log('\n[and a live board is still a live board]');
{
  const { out, errs } = await screen('live');
  check('labelled live', /Live/.test(out.label) && !/Last recorded/.test(out.label), out.label);
  check('with no stale warning on the plan', !/last waits we recorded/i.test(out.body));
  check('and the page threw nothing', errs.length === 0, errs[0]);
}

await browser.close();
console.log(fail ? `\n=== ${fail} failures ===` : '\n=== a stored board arrives labelled ===');
process.exit(fail ? 1 : 0);
