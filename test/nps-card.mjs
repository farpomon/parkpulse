// The question, as a visitor meets it.
//
// It appears after the third ride ticked off the plan -- not the first, when
// nothing has been proven, and never on a fresh open. One tap answers it, one
// optional line follows, and it is not asked again for a quarter. Dismissing
// counts as asked. All of that is the difference between a survey and a nag.
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
  { name: 'Pirates', land: 'Adventureland', wait: 20, open: true, typical: 25 },
];

const browser = await launchBrowser();
async function day({ askedAgo = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 }, userAgent: UA, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  const posted = [];
  await page.addInitScript((ago) => {
    localStorage.setItem('pp-onboarded', '1'); localStorage.setItem('pp-park', 'magic-kingdom');
    if (ago != null) localStorage.setItem('pp-nps-at', String(Date.now() - ago));
  }, askedAgo);
  const json = (b) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
  await page.route('**/api/config', async (r) => {
    const cfg = await (await r.fetch()).json();
    cfg.proGate = false;
    for (const p of Object.values(cfg.parks || {})) { p.open = 0; p.close = 24; }
    r.fulfill(json(cfg));
  });
  await page.route('**/api/waits/**', (r) => r.fulfill(json({ park: 'Magic Kingdom', source: 'live', attribution: 's', updatedAt: new Date().toISOString(), rides: RIDES })));
  await page.route('**/api/ride-tags/**', (r) => r.fulfill(json({ tags: {} })));
  for (const p of ['**/api/closures/**', '**/api/weather/**', '**/api/dining/**', '**/api/trip']) await page.route(p, (r) => r.fulfill(json({})));
  await page.route('**/api/consultant', (r) => r.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: 'event: done\ndata: {}\n\n' }));
  await page.route('**/api/nps', (r) => { try { posted.push(JSON.parse(r.request().postData() || '{}')); } catch {} r.fulfill(json({ ok: true })); });
  await page.goto(B + '/app', { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(3000);
  await page.evaluate(() => { for (const i of ['onboard', 'onboard-bg', 'acct-sheet', 'acct-bg', 'gate', 'sheet-bg']) document.getElementById(i)?.classList.remove('open'); });
  await page.evaluate(() => document.getElementById('pick-all')?.click());
  await page.waitForTimeout(300);
  await page.evaluate(() => document.getElementById('build')?.click());
  await page.waitForTimeout(2000);
  const tick = async (n) => {
    await page.evaluate((i) => document.querySelectorAll('#plan-out .stepdone')[i]?.click(), n);
    await page.waitForTimeout(250);
  };
  const card = () => page.evaluate(() => ({
    shown: !!document.querySelector('#nps-slot .npscard'),
    chips: document.querySelectorAll('#nps-slot .nps-row button').length,
    text: document.querySelector('#nps-slot')?.innerText || '',
    followUp: !!document.querySelector('#nps-slot textarea'),
  }));
  return { page, ctx, errs, posted, tick, card };
}

console.log('\n[a day, ride by ride]');
{
  const d = await day();
  const steps = await d.page.evaluate(() => document.querySelectorAll('#plan-out .stepdone').length);
  check('there is a plan with rides to tick', steps >= 3, `${steps} steps`);
  check('nothing is asked on a fresh open', !(await d.card()).shown);
  await d.tick(0); await d.tick(1);
  check('nor after two rides', !(await d.card()).shown);
  await d.tick(2);
  let c = await d.card();
  check('after the third, the question appears', c.shown, c.text.slice(0, 80));
  check('as eleven taps, 0 to 10', c.chips === 11, String(c.chips));
  check('anchored at both ends', /Not likely/.test(c.text) && /Very likely/.test(c.text), c.text.slice(0, 120));
  check('no follow-up yet -- one thing at a time', !c.followUp);

  await d.page.evaluate(() => [...document.querySelectorAll('#nps-slot .nps-row button')].find((b) => b.textContent === '9')?.click());
  await d.page.waitForTimeout(300);
  c = await d.card();
  check('a tap sends the score at once', d.posted.length === 1 && d.posted[0].score === 9, JSON.stringify(d.posted));
  check('under the device, with the park', d.posted[0] && d.posted[0].device && d.posted[0].park === 'magic-kingdom', JSON.stringify(d.posted[0]));
  check('then one optional line, worded for a promoter', c.followUp && /What did we get right/.test(await d.page.evaluate(() => document.querySelector('#nps-slot textarea')?.placeholder || '')));
  await d.page.fill('#nps-slot textarea', 'The order was perfect.');
  await d.page.evaluate(() => document.querySelector('#nps-slot .nps-btns .btn')?.click());
  await d.page.waitForTimeout(300);
  c = await d.card();
  check('the comment goes with the same score', d.posted.length === 2 && d.posted[1].score === 9 && /perfect/.test(d.posted[1].comment), JSON.stringify(d.posted[1]));
  check('and Mila says thank you', /Thank you/.test(c.text), c.text.slice(0, 80));
  const marked = await d.page.evaluate(() => Number(localStorage.getItem('pp-nps-at') || 0));
  check('the quarter clock starts', Date.now() - marked < 60000, String(marked));
  check('no page errors', d.errs.length === 0, d.errs[0]);
  await d.ctx.close();
}

console.log('\n[a detractor is asked what to fix, not what went right]');
{
  const d = await day();
  await d.tick(0); await d.tick(1); await d.tick(2);
  await d.page.evaluate(() => [...document.querySelectorAll('#nps-slot .nps-row button')].find((b) => b.textContent === '4')?.click());
  await d.page.waitForTimeout(300);
  const ph = await d.page.evaluate(() => document.querySelector('#nps-slot textarea')?.placeholder || '');
  check('the follow-up asks what we could do better', /do better/.test(ph), ph);
  await d.page.evaluate(() => document.querySelector('#nps-slot .nps-skip')?.click());
  await d.page.waitForTimeout(200);
  check('skip still thanks them, and sends nothing more', d.posted.length === 1 && /Thank you/.test((await d.card()).text));
  await d.ctx.close();
}

console.log('\n[asked once a quarter, not once a ride]');
{
  const d = await day({ askedAgo: 30 * 86400000 });
  await d.tick(0); await d.tick(1); await d.tick(2); await d.tick(3);
  check('asked a month ago: not asked again', !(await d.card()).shown);
  await d.ctx.close();
  const e = await day({ askedAgo: 100 * 86400000 });
  await e.tick(0); await e.tick(1); await e.tick(2);
  check('asked a hundred days ago: asked again', (await e.card()).shown);
  // Dismissing is an answer too, as far as nagging goes.
  await e.page.evaluate(() => document.querySelector('#nps-slot .nps-x')?.click());
  await e.page.waitForTimeout(150);
  check('dismissed with the ✕: gone', !(await e.card()).shown);
  await e.tick(3);
  check('and not brought back by the next ride', !(await e.card()).shown);
  check('nothing was sent for a dismissal', e.posted.length === 0);
  await e.ctx.close();
}

await browser.close();
console.log(fail ? `\n=== ${fail} failures ===` : '\n=== one question, once, after the day earned it ===');
process.exit(fail ? 1 : 0);
