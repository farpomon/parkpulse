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

// The same park with its rides running. The board these tests need depends on
// what they are asking about: whether a dead end is explained honestly needs a
// dead end, and whether a failure to reach Mila is explained honestly needs a
// plan for her to have failed on.
const RUNNING = [
  { name: 'Space Mountain', land: 'A', wait: 45, open: true, typical: 120 },
  { name: 'Haunted Mansion', land: 'B', wait: 25, open: true, typical: 105 },
  { name: 'Jungle Cruise', land: 'B', wait: 30, open: true, typical: 60 },
];

let asked = null;
const visit = async (query, consultantFulfil, rides = SHUT) => {
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
  await page.route('**/api/waits/**', (r) => r.fulfill(json({ park: 'x', source: 'live', attribution: 's', updatedAt: new Date().toISOString(), rides })));
  for (const p of ['**/api/ride-tags/**', '**/api/closures/**', '**/api/weather/**', '**/api/geo/**', '**/api/trip']) await page.route(p, (r) => r.fulfill(json({})));
  await page.route('**/api/dining/**', (r) => r.fulfill(json({ park: 'x', reserve: null, list: [] })));
  await page.route('**/api/consultant', (r) => {
    try { asked = JSON.parse(r.request().postData() || '{}'); } catch {}
    if (consultantFulfil) return consultantFulfil(r);
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
    // Mila's own panel — where a failure to reach her is reported, separate
    // from Pip's running order in #plan-out.
    advisor: await page.evaluate(() => document.getElementById('planai-body')?.innerText || ''),
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
  // Either the whole board reads closed, or the picks are closed long-term.
  // Both are honest; which one depends on whether the park is open at the
  // moment the suite runs, and neither may blame the clock.
  const dead = /não conseguiu preencher/.test(r.card);
  if (dead) {
    check('Mila says she could not fill it', true);
    check('and names a real reason', /aparecendo como fechadas|fechad[ao]s? há dias|fechadas/i.test(r.card), r.card.slice(0, 240));
    check('instead of blaming the arrival and departure times', !/hora de chegada/.test(r.card), r.card.slice(0, 240));
    check('and Mila is reachable from the dead end', r.mila, r.card.slice(0, 120));
  } else {
    // The park reads closed right now, so planning it anyway is correct --
    // that is the same exception that makes planning next Saturday work.
    check('a shut park still gets a day planned', r.stops > 0, r.card.slice(0, 120));
    check('and the clock is never blamed', !/hora de chegada/.test(r.card), r.card.slice(0, 200));
  }

  if (dead) {
    await r.page.evaluate(() => document.getElementById('plan-ask-mila')?.click());
    await r.page.waitForTimeout(1500);
    const q = String(asked?.messages?.[0]?.content || '');
    check('her question carries the day that failed', /Magic Kingdom/.test(q), q.slice(0, 160));
    check('and the hours it was tried with', /(AM|PM)/.test(q), q.slice(0, 160));
  }
  check('no page errors', r.errs.length === 0, r.errs[0]);
  await r.ctx.close();
}

// Reported from production: the plan panel said only "Mila couldn't be
// reached", which tells the reader nothing they can act on. The server had
// already said exactly why — log in, or she is not switched on here — and the
// client threw it away for a generic line on every status except 402.
console.log('\n[when she cannot be reached, the reason reaches the reader]');
for (const [label, status, error, want] of [
  ['not logged in', 401, 'Your free daily plan is waiting — log in (free) so Mila knows who she is planning for.', /plano diário gratuito está esperando/],
  ['not configured', 503, 'Mila is not switched on here yet — the plan below still stands.', /ainda não está ativada aqui/],
  ['upstream refused', 502, 'Your magical fairy is having a moment — try again shortly.', /fada mágica/i],
  // The paywall. With PRO_GATE on and the free tier limited to one park, this
  // is what every visitor planning anywhere else meets — the upsell moment,
  // which used to read "pass required".
  ['behind the paywall', 402, "Mila's read of your plan comes with any pass.", /leitura da Mila sobre o seu plano vem com qualquer passe/],
  // Same status, different "no": a pass-holder who has used up the pass's
  // share of Mila. They are offered more of her, not a pass they already own.
  ['out of the pass', 402, { error: 'Mila has given you everything that came with this pass ✨ A top-up keeps her going.', milaRest: 'pass', topUp: true }, /tudo o que vinha com este passe/],
]) {
  // A running board on purpose. Mila is only asked to read a plan once there
  // is one, so on a shut board this panel is empty and these four checks
  // become a statement about what time the suite ran -- which is how they
  // passed when they were written and failed the same evening.
  const r = await visit('/app?park=magic-kingdom', (rt) => rt.fulfill({
    status, contentType: 'application/json', body: JSON.stringify(typeof error === 'string' ? { error } : error),
  }), RUNNING);
  if (typeof error === 'object') {
    const acts = await r.page.evaluate(() => document.getElementById('planai-act')?.innerText || '');
    check(`${label}: is offered more of Mila`, /mais tempo com a Mila/i.test(acts), acts);
    check(`${label}: and not a pass they already hold`, !/passe inclui|inclui um passe/i.test(acts), acts);
  }
  check(`${label}: there is a plan for her to have failed on`, r.stops > 0, `${r.stops} stops`);
  const said = r.advisor;
  check(`${label}: the reader is told why`, want.test(said), said.slice(0, 160));
  check(`  and not the generic line`, !/não foi possível falar com a Mila — o plano abaixo/i.test(said), said.slice(0, 120));
  await r.ctx.close();
}

await browser.close();
console.log(`\n=== ${fail ? fail + ' failed' : 'the card says what is actually wrong, and Mila is one tap away'} ===`);
process.exit(fail ? 1 : 0);
