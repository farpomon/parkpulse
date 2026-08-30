// Reported from the app: the party was changed and Mila's read still talked
// about a grandparent coming along. Her prose was cached under the park, the
// date and the ride names alone, so rebuilding the same rides for a different
// group replayed a description of people who were no longer there.
import { launchBrowser } from './browser.mjs';

const B = process.env.PP_BASE || 'http://127.0.0.1:9695';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const RIDES = Array.from({ length: 8 }, (_, i) => ({
  name: `Atracao ${i + 1}`, land: ['Fantasia', 'Aventura'][i % 2],
  wait: 20 + (i % 6) * 12, open: true, typical: 25 + (i % 6) * 12,
}));
let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };
const browser = await launchBrowser();

// The advisor answers with whatever party it was told about, so the reply on
// screen is evidence of which profile actually reached the server.
const sent = [];
const ctx = await browser.newContext({ viewport: { width: 390, height: 900 }, userAgent: UA, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.addInitScript(() => {
  localStorage.setItem('pp-onboarded', '1');
  localStorage.setItem('pp-park', 'magic-kingdom');
  localStorage.setItem('pp-wiz-seen', '2099-01-01');   // don't pop the wizard on boot
  localStorage.setItem('pp-profile', JSON.stringify({ party: 4, ages: ['kid', 'adult', 'elderly'], vibes: ['thrill'], onsite: false, day: '2099-01-01' }));
});
const json = (b) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
await page.route('**/api/waits/**', (r) => r.fulfill(json({ park: 'x', source: 'live', attribution: 's', updatedAt: new Date().toISOString(), rides: RIDES })));
for (const p of ['**/api/ride-tags/**', '**/api/closures/**', '**/api/weather/**']) await page.route(p, (r) => r.fulfill(json({})));
await page.route('**/api/consultant', (r) => {
  const body = JSON.parse(r.request().postData() || '{}');
  sent.push(body);
  const ages = (body.profile?.ages || []).join('+') || 'nobody';
  r.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' },
    body: `event: delta\ndata: ${JSON.stringify({ text: `Planning for ${ages}.` })}\n\nevent: done\ndata: {}\n\n` });
});
await page.goto(B + '/app', { waitUntil: 'domcontentloaded', timeout: 25000 });
await page.waitForTimeout(2500);
const clearOverlays = () => page.evaluate(() => { for (const i of ['onboard', 'onboard-bg', 'acct-sheet', 'acct-bg', 'gate', 'sheet', 'sheet-bg', 'wiz', 'wiz-bg']) document.getElementById(i)?.classList.remove('open'); });
await clearOverlays();

const build = async () => {
  await page.evaluate(() => document.querySelector('.tabbar button[data-tab="today"]')?.click());
  await page.waitForTimeout(200);
  await page.evaluate(() => document.querySelectorAll('#rides input[type=checkbox][data-name]').forEach((c) => { if (!c.disabled && !c.checked) c.click(); }));
  await page.evaluate(() => document.querySelector('.tabbar button[data-tab="plan"]')?.click());
  await page.waitForTimeout(300);
  await page.evaluate(() => (document.getElementById('plan-hero-btn') || document.getElementById('build'))?.click());
  await page.waitForTimeout(2800);
};
const advice = () => page.evaluate(() => document.getElementById('planai-body')?.textContent.trim() || '');

console.log('\n[a plan for a party that includes a grandparent]');
await build();
{
  const a = await advice();
  console.log(`      "${a.slice(-40)}"`);
  check('her read mentions the grandparent', /elderly/.test(a), a.slice(-60));
  check('and the profile reached the server', sent.at(-1)?.profile?.ages.includes('elderly'), JSON.stringify(sent.at(-1)?.profile));
}

console.log('\n[the grandparent is no longer coming]');
{
  const before = sent.length;
  // Drive the wizard the way a visitor does: open it, unpick the elderly
  // chip, and walk Next to the end. Poking localStorage instead would skip
  // the very commit path that is supposed to throw the old reads away.
  // Through the group chip, which is how a visitor gets there. Forcing the
  // dialog open directly skips openWizard() and leaves its draft unset.
  await page.evaluate(() => document.querySelector('.tabbar button[data-tab="today"]')?.click());
  await page.waitForTimeout(300);
  const opened = await page.evaluate(() => {
    const b = document.getElementById('group-chip-btn');
    if (!b) return false;
    b.click();
    return true;
  });
  check('the group sheet opens from the chip', opened);
  await page.waitForTimeout(500);
  // The wizard is several screens and the group counters are on one of them,
  // so walk it the way a visitor does, counting the grandparent back down to
  // zero when that screen comes up.
  let unpicked = false;
  for (let i = 0; i < 8; i++) {
    const open = await page.evaluate(() => document.getElementById('wiz')?.classList.contains('open'));
    if (!open) break;
    if (!unpicked) {
      unpicked = await page.evaluate(() => {
        const row = [...document.querySelectorAll('.bandrow')].find((r) => r.textContent.includes('\u{1F9D3}'));
        if (!row) return false;
        let guard = 12;
        while (Number(row.querySelector('b').textContent) > 0 && guard--) row.querySelector('button[data-d="-1"]').click();
        return Number(row.querySelector('b').textContent) === 0;
      });
      if (unpicked) await page.waitForTimeout(250);
    }
    await page.evaluate(() => document.getElementById('wiz-next')?.click());
    await page.waitForTimeout(280);
  }
  check('the elderly were counted back down to zero', unpicked);
  check('the wizard was committed', !(await page.evaluate(() => document.getElementById('wiz')?.classList.contains('open'))));
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('pp-profile') || 'null'));
  check('and the group no longer includes them', !(saved?.ages || []).includes('elderly'), JSON.stringify(saved?.ages));

  await page.waitForTimeout(500);
  await build();
  const a = await advice();
  console.log(`      "${a.slice(-40)}"`);
  check('a fresh read was bought', sent.length > before, `${sent.length - before} calls`);
  check('the new party reached the server', !sent.at(-1)?.profile?.ages.includes('elderly'), JSON.stringify(sent.at(-1)?.profile));
  check('and no grandparent is described any more', !/elderly/.test(a), a.slice(-60));
}

console.log('\n[the cache still works when nothing changed]');
{
  const before = sent.length;
  await build();
  check('an identical rebuild replays instead of paying', sent.length === before, `${sent.length - before} calls`);
}
check('no page errors', errs.length === 0, errs[0]);
await ctx.close();
console.log(fail ? `\n=== ${fail} failures ===` : '\n=== her read follows the group ===');
await browser.close();
process.exit(fail ? 1 : 0);
