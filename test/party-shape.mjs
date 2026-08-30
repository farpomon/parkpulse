// "Who's going?" used to ask for one party total and a set of age bands, which
// could not tell four adults from two adults and two children -- and those are
// not the same day. It counts each band now, and the moment a child is counted
// it asks for that child's age and height, because height is what decides what
// they can board.
//
// Checked here: the counters, the automatic height question, what an old saved
// profile turns into, and that the height typed in actually means something.
import { launchBrowser } from './browser.mjs';

const B = process.env.PP_BASE || 'http://127.0.0.1:9695';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };
const browser = await launchBrowser();

// Three height gates and one ride with none, so "N of M" has a right answer.
const RIDES = [
  { name: 'Big One', land: 'A', wait: 40, open: true, typical: 45 },
  { name: 'Middle One', land: 'A', wait: 25, open: true, typical: 30 },
  { name: 'Small One', land: 'B', wait: 10, open: true, typical: 12 },
  { name: 'No Gate', land: 'B', wait: 5, open: true, typical: 8 },
];
const TAGS = {
  'Big One': { vibe: 'thrill', minAge: 8, hmin: 122 },
  'Middle One': { vibe: 'family', minAge: 4, hmin: 102 },
  'Small One': { vibe: 'gentle', minAge: 0, hmin: 81 },
  'No Gate': { vibe: 'show', minAge: 0, hmin: -1 },
};

async function open(profile, lang = 'en') {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 }, userAgent: UA, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.addInitScript(([prof, l]) => {
    localStorage.setItem('pp-onboarded', '1');
    localStorage.setItem('pp-park', 'magic-kingdom');
    localStorage.setItem('pp-wiz-seen', '2099-01-01');
    localStorage.setItem('pp-kid-unit', 'cm');
    localStorage.setItem('pp-profile', JSON.stringify(prof));
    if (l !== 'en') localStorage.setItem('pp-lang', l);
  }, [profile, lang]);
  const json = (b) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
  await page.route('**/api/waits/**', (r) => r.fulfill(json({ park: 'x', source: 'live', attribution: 's', updatedAt: new Date().toISOString(), rides: RIDES })));
  await page.route('**/api/ride-tags/**', (r) => r.fulfill(json({ tags: TAGS })));
  for (const q of ['**/api/closures/**', '**/api/weather/**', '**/api/dining/**', '**/api/trip']) await page.route(q, (r) => r.fulfill(json({})));
  await page.route('**/api/consultant', (r) => r.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: 'event: done\ndata: {}\n\n' }));
  await page.goto(B + '/app', { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(2800);
  await page.evaluate(() => { for (const i of ['onboard', 'onboard-bg', 'acct-sheet', 'acct-bg', 'gate', 'sheet-bg'] ) document.getElementById(i)?.classList.remove('open'); });
  await page.click('#group-chip-btn');
  await page.waitForTimeout(450);
  for (let i = 0; i < 5; i++) {
    const h = await page.evaluate(() => document.querySelector('#wiz-body h2')?.textContent || '');
    if (/\u{1F465}/u.test(h)) break;
    await page.click('#wiz-next');
    await page.waitForTimeout(380);
  }
  return { ctx, page, errs };
}
const bands = (page) => page.evaluate(() => [...document.querySelectorAll('.bandrow')].map((r) => ({
  label: r.querySelector('.bl').textContent.trim(), n: Number(r.querySelector('b').textContent), on: r.classList.contains('on'),
})));
const bump = (page, emoji, d, times = 1) => page.evaluate(([e, dir, t]) => {
  const row = [...document.querySelectorAll('.bandrow')].find((r) => r.textContent.includes(e));
  for (let i = 0; i < t; i++) row.querySelector(`button[data-d="${dir}"]`).click();
}, [emoji, d, times]);

console.log('\n[three bands, counted]');
{
  const { ctx, page, errs } = await open({ counts: { kid: 0, adult: 2, elderly: 0 }, vibes: [], onsite: null });
  const b = await bands(page);
  console.log('      ' + b.map((x) => `${x.label}=${x.n}`).join('  '));
  check('there are exactly three', b.length === 3, JSON.stringify(b.map((x) => x.label)));
  check('toddlers and teens are gone', !b.some((x) => /👶|🧑\b/.test(x.label)), JSON.stringify(b.map((x) => x.label)));
  check('each one carries its own count', b.every((x) => Number.isFinite(x.n)));
  check('only the bands with somebody in them are lit', b.filter((x) => x.on).length === 1, JSON.stringify(b));
  check('the total is stated', /2/.test(await page.evaluate(() => document.querySelector('.wiz-total')?.textContent || '')));
  check('no height question without children', !(await page.evaluate(() => Boolean(document.querySelector('.kidbox')))));
  // Somebody has to be going.
  await bump(page, '🧔', -1, 5);
  await page.waitForTimeout(200);
  const after = await bands(page);
  check('the group cannot be emptied', after.reduce((n, x) => n + x.n, 0) >= 1, JSON.stringify(after));
  check('no page errors', errs.length === 0, errs[0]);
  await ctx.close();
}

console.log('\n[count a child and the question arrives on its own]');
{
  const { ctx, page, errs } = await open({ counts: { kid: 0, adult: 2, elderly: 0 }, vibes: [], onsite: null });
  await bump(page, '🧒', 1);
  await page.waitForTimeout(350);
  check('the height box appears with no second tap', await page.evaluate(() => Boolean(document.querySelector('.kidbox'))));
  check('one child, one row', await page.evaluate(() => document.querySelectorAll('.kidrow').length) === 1);
  await bump(page, '🧒', 1, 2);
  await page.waitForTimeout(350);
  check('three children, three rows', await page.evaluate(() => document.querySelectorAll('.kidrow').length) === 3);
  check('each row says which child it is', await page.evaluate(() => document.querySelectorAll('.kidno').length) === 3);
  await bump(page, '🧒', -1, 2);
  await page.waitForTimeout(350);
  check('counting back down removes rows', await page.evaluate(() => document.querySelectorAll('.kidrow').length) === 1);

  // The point of asking: what the height opens up, from this park's own gates.
  const setCm = async (cm) => {
    await page.evaluate((v) => {
      const ins = document.querySelector('.kidrow').querySelectorAll('input');
      ins[1].value = String(v); ins[1].dispatchEvent(new Event('input', { bubbles: true }));
    }, cm);
    await page.waitForTimeout(180);
    return page.evaluate(() => document.querySelector('.kidfit').textContent.trim());
  };
  const at95 = await setCm(95), at110 = await setCm(110), at130 = await setCm(130);
  console.log(`      95cm: ${at95}\n      110cm: ${at110}\n      130cm: ${at130}`);
  check('a height is answered with what it opens', /1/.test(at95) && /3/.test(at95), at95);
  check('and the answer grows with the child', /2/.test(at110) && /3/.test(at130), `${at110} | ${at130}`);
  check('the ride with no height gate is not counted', !/4/.test(at130), at130);
  check('no page errors', errs.length === 0, errs[0]);
  await ctx.close();
}

console.log('\n[what the wizard saves]');
{
  const { ctx, page } = await open({ counts: { kid: 0, adult: 2, elderly: 0 }, vibes: [], onsite: null });
  await bump(page, '🧒', 1);
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const ins = document.querySelector('.kidrow').querySelectorAll('input');
    ins[0].value = '7'; ins[0].dispatchEvent(new Event('input', { bubbles: true }));
    ins[1].value = '118'; ins[1].dispatchEvent(new Event('input', { bubbles: true }));
  });
  await bump(page, '🧓', 1);
  await page.waitForTimeout(250);
  for (let i = 0; i < 6; i++) {
    if (!(await page.evaluate(() => document.getElementById('wiz')?.classList.contains('open')))) break;
    await page.click('#wiz-next');
    await page.waitForTimeout(420);
  }
  await page.waitForTimeout(1200);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('pp-profile') || 'null'));
  console.log('      ' + JSON.stringify({ counts: saved?.counts, party: saved?.party, ages: saved?.ages, kids: saved?.kids }));
  check('the counts are what was set', JSON.stringify(saved?.counts) === JSON.stringify({ kid: 1, adult: 2, elderly: 1 }), JSON.stringify(saved?.counts));
  check('party is their sum', saved?.party === 4, String(saved?.party));
  check('ages still lists the bands present, for everything that reads it', JSON.stringify((saved?.ages || []).slice().sort()) === JSON.stringify(['adult', 'elderly', 'kid']), JSON.stringify(saved?.ages));
  check("the child's age and height were kept", saved?.kids?.[0]?.age === 7 && saved?.kids?.[0]?.cm === 118, JSON.stringify(saved?.kids));
  check('and the shortest child became the height filter', await page.evaluate(() => localStorage.getItem('pp-child-height')) === '118',
    await page.evaluate(() => localStorage.getItem('pp-child-height')));
  await ctx.close();
}

console.log('\n[a profile saved before any of this]');
{
  // Toddlers fold into kids (they get the height question, which is the part
  // that mattered) and teens into adults; the party total survives.
  const { ctx, page } = await open({ party: 5, ages: ['toddler', 'teen', 'adult'], vibes: ['family'], onsite: null, kids: [{ age: 3, cm: 95 }] });
  const b = await bands(page);
  console.log('      ' + b.map((x) => `${x.label}=${x.n}`).join('  '));
  check('it still adds up to the party they saved', b.reduce((n, x) => n + x.n, 0) === 5, JSON.stringify(b));
  check('the toddler is counted as a child', b.find((x) => x.label.includes('🧒'))?.n >= 1, JSON.stringify(b));
  check('and their height question is already open', await page.evaluate(() => Boolean(document.querySelector('.kidbox'))));
  check('with the height they had given', await page.evaluate(() => document.querySelector('.kidrow').querySelectorAll('input')[1].value) === '95');
  await ctx.close();
}

console.log(fail ? `\n=== ${fail} failures ===` : '\n=== the group is counted, and the little ones are measured ===');
await browser.close();
process.exit(fail ? 1 : 0);
