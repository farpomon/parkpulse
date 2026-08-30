// A future day at any park outside the four with hand-built baselines showed
// a column of dashes: projectedWait() returned null without a measured
// typical, and only 4 of 65 parks have one. The planner never had that
// problem -- it quietly fell back to the live wait -- so the Plan tab was
// printing "~35 min" for a ride whose board row said "—".
//
// Three sources now, in descending order of how much they are worth believing,
// and the board says out loud which one it used.
import { launchBrowser } from './browser.mjs';

const B = process.env.PP_BASE || 'http://127.0.0.1:9695';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };
const browser = await launchBrowser();

const TZ = 'America/New_York';
const iso = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', { timeZone: TZ });
const DAYS = Array.from({ length: 7 }, (_, i) => ({
  date: iso(i),
  dow: new Date(Date.now() + i * 86400000).toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short' }),
  level: 4, label: 'Busy', score: 70, factor: 1.2,
}));
const TARGET = DAYS[3].date;

// Three rides, one per source: one with a measured typical, one open with only
// a live wait, one shut with only a tag to go on.
const RIDES = [
  { name: 'Measured Mountain', land: 'A', wait: 30, open: true, typical: 40 },
  { name: 'Live Only Coaster', land: 'A', wait: 45, open: true, typical: null },
  { name: 'Shut Water Ride', land: 'A', wait: 0, open: false, typical: null },
];
const TAGS = { 'Live Only Coaster': { vibe: 'thrill', minAge: 0, hmin: -1 }, 'Shut Water Ride': { vibe: 'water', minAge: 0, hmin: -1 } };

async function board({ tags = true, plan = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 }, userAgent: UA, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.addInitScript(() => { localStorage.setItem('pp-onboarded', '1'); localStorage.setItem('pp-park', 'magic-kingdom'); });
  const json = (b) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
  await page.route('**/api/config', async (r) => {
    const cfg = await (await r.fetch()).json();
    cfg.proGate = false;                       // planning ahead is a pass feature
    r.fulfill(json(cfg));
  });
  await page.route('**/api/forecast/**', (r) => r.fulfill(json({ park: 'Magic Kingdom', days: DAYS, best: DAYS[0].dow, measuredDays: 0 })));
  await page.route('**/api/waits/**', (r) => r.fulfill(json({ park: 'Magic Kingdom', source: 'live', attribution: 's', updatedAt: new Date().toISOString(), rides: RIDES })));
  await page.route('**/api/ride-tags/**', (r) => r.fulfill(json(tags ? { tags: TAGS } : {})));
  for (const p of ['**/api/closures/**', '**/api/weather/**', '**/api/dining/**', '**/api/trip']) await page.route(p, (r) => r.fulfill(json({})));
  await page.route('**/api/consultant', (r) => r.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: 'event: done\ndata: {}\n\n' }));
  await page.goto(B + '/app' + (plan ? `?park=magic-kingdom&date=${TARGET}` : ''), { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(3600);
  await page.evaluate(() => { for (const i of ['onboard', 'onboard-bg', 'acct-sheet', 'acct-bg', 'gate', 'sheet-bg']) document.getElementById(i)?.classList.remove('open'); });
  const out = await page.evaluate(() => ({
    day: document.getElementById('plan-day-sel')?.value,
    rows: [...document.querySelectorAll('.ride')].map((el) => ({
      name: el.querySelector('.name')?.textContent,
      wait: el.querySelector('.wait')?.textContent.trim(),
      cls: [...(el.querySelector('.wait')?.classList || [])].filter((c) => c !== 'wait').join(' '),
    })),
    note: document.querySelector('.clnote .cl-sub')?.textContent?.trim() || '',
  }));
  await ctx.close();
  return { out, errs };
}

console.log(`\n[a future day (${TARGET}), crowd factor 1.2]`);
const { out, errs } = await board();
out.rows.forEach((r) => console.log(`      ${r.wait.padEnd(10)} ${r.cls.padEnd(6)} ${r.name}`));
check('the day was restored', out.day === TARGET, out.day);
check('nothing is left as a dash', out.rows.length === 3 && !out.rows.some((r) => r.wait === '—'), JSON.stringify(out.rows));

const by = Object.fromEntries(out.rows.map((r) => [r.name, r]));
// 40 measured x 1.2 = 48, exact because a measured figure has earned it.
check('a measured typical scales to the day, unrounded', by['Measured Mountain']?.wait === '~48 min', by['Measured Mountain']?.wait);
// 45 posted, divided back off the hour curve, x 1.2, to the nearest five.
check('a live wait becomes an estimate ending in 0 or 5', /^~\d*[05] min$/.test(by['Live Only Coaster']?.wait || ''), by['Live Only Coaster']?.wait);
check('  and it is bigger than the posted 45, since the day is busier', Number((by['Live Only Coaster']?.wait || '').replace(/\D/g, '')) > 45, by['Live Only Coaster']?.wait);
// A shut ride has no live number, so its class is all there is: water = 30.
check('a shut ride falls back to its class', by['Shut Water Ride']?.wait === '~35 min', by['Shut Water Ride']?.wait);
check('estimates are still coloured, not greyed out as closed',
  out.rows.every((r) => r.cls && r.cls !== 'closed'), out.rows.map((r) => `${r.name}:${r.cls}`).join(', '));
check('the board says where the numbers came from', /posted waits|attraction/i.test(out.note), out.note || '(no note)');
check('and it does not claim to have measured them', !/measured/i.test(out.note), out.note);
check('no page errors', errs.length === 0, errs[0]);

console.log('\n[a park with no tags either]');
{
  const { out: o2 } = await board({ tags: false });
  const b2 = Object.fromEntries(o2.rows.map((r) => [r.name, r]));
  check('the shut ride with nothing to go on is still an honest dash', b2['Shut Water Ride']?.wait === '—', b2['Shut Water Ride']?.wait);
  check('and the open one is still projected', b2['Live Only Coaster']?.wait !== '—', b2['Live Only Coaster']?.wait);
}

console.log('\n[today]');
{
  const { out: o3 } = await board({ plan: false });
  const b3 = Object.fromEntries(o3.rows.map((r) => [r.name, r]));
  check('live waits are untouched', b3['Measured Mountain']?.wait === '30 min' && b3['Live Only Coaster']?.wait === '45 min',
    `${b3['Measured Mountain']?.wait} / ${b3['Live Only Coaster']?.wait}`);
  // "paused" is a ride down while the park is open; "closed" is shut for the
  // day. Either is the board reporting a fact rather than projecting one.
  check('a shut ride still reads as shut, not projected',
    /paused|closed/.test(b3['Shut Water Ride']?.cls || '') && !/^~/.test(b3['Shut Water Ride']?.wait || ''),
    `${b3['Shut Water Ride']?.cls} / ${b3['Shut Water Ride']?.wait}`);
}

console.log(fail ? `\n=== ${fail} failures ===` : '\n=== every park gets a projection, and says where it came from ===');
await browser.close();
process.exit(fail ? 1 : 0);
