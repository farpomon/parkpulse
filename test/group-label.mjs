// The group chip is where the party is edited, and the pencil glyph alone was
// too easy to miss. The label that used to say so was a coachmark: dismissed
// for good the first time the chip was tapped, so the visitor most likely to
// need it -- the one coming back on the day their party changed -- was the one
// who no longer had it. This checks the standing label is there, points at the
// chip, cannot be dismissed, and survives the sheet it opens.
const pw = await import(process.env.PP_PLAYWRIGHT || 'playwright-core');
const chromium = pw.chromium || pw.default?.chromium;
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };
for (const [lang, w] of [['pt', 390], ['en', 390], ['de', 320]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 820 }, userAgent: UA, isMobile: true, hasTouch: true, serviceWorkers: 'block', deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.addInitScript((l) => {
    localStorage.setItem('pp-onboarded','1'); localStorage.setItem('pp-park','seaworld-san-diego');
    localStorage.setItem('pp-wiz-seen','2099-01-01');
    localStorage.setItem('pp-grouphint-seen','1');   // the old coachmark was dismissed long ago
    localStorage.setItem('pp-profile', JSON.stringify({ party: 4, ages: ['kid','adult'], vibes: ['chill','water'], onsite: false, day: '2099-01-01' }));
    if (l !== 'en') localStorage.setItem('pp-lang', l);
  }, lang);
  const json = (b) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
  await page.route('**/api/waits/**', (r) => r.fulfill(json({ park:'x', source:'live', attribution:'s', updatedAt:new Date().toISOString(), rides:[{name:'Atracao 1',land:'A',wait:20,open:true,typical:25}] })));
  for (const p of ['**/api/ride-tags/**','**/api/closures/**','**/api/weather/**','**/api/dining/**']) await page.route(p, (r) => r.fulfill(json({})));
  await page.goto(`${process.env.PP_BASE || 'http://127.0.0.1:9695'}/app`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.evaluate(() => { for (const i of ['onboard','onboard-bg','acct-sheet','acct-bg','gate','sheet','sheet-bg','wiz','wiz-bg']) document.getElementById(i)?.classList.remove('open'); });
  const r = await page.evaluate(() => {
    const hint = document.getElementById('group-hint');
    const chip = document.getElementById('group-chip-btn');
    const hb = hint?.getBoundingClientRect(), cb = chip?.getBoundingClientRect();
    const ab = hint?.querySelector('.gh-arrow')?.getBoundingClientRect();
    return {
      text: hint?.textContent.trim() || '', shown: !!hb && hb.width > 0,
      sameLine: ab && cb ? ab.top < cb.bottom && ab.bottom > cb.top : null,
      rightOfChip: ab && cb ? ab.left >= cb.right - 2 : null,
      overflows: document.body.scrollWidth > document.body.clientWidth + 1,
      hasX: !!document.getElementById('group-hint-x'),
    };
  });
  console.log(`\n[${lang} @ ${w}px] "${r.text}"`);
  check('the label is showing even though the old hint was dismissed', r.shown, JSON.stringify(r));
  check('it points at the chip', r.text.startsWith('←'), r.text);
  check('there is no way to dismiss it', !r.hasX);
  check('the arrow sits beside the chip, pointing at it', r.sameLine && r.rightOfChip, `sameLine=${r.sameLine} right=${r.rightOfChip}`);
  check('nothing overflows the screen', !r.overflows);
  if (lang !== 'en') check('translated', !/Tap to change/.test(r.text), r.text);
  // Tapping the chip opens the group sheet and leaves the label alone.
  await page.evaluate(() => document.getElementById('group-chip-btn')?.click());
  await page.waitForTimeout(500);
  check('the chip still opens the group sheet', await page.evaluate(() => document.getElementById('wiz')?.classList.contains('open')));
  await page.evaluate(() => { document.getElementById('wiz')?.classList.remove('open'); document.getElementById('wiz-bg')?.classList.remove('open'); });
  await page.waitForTimeout(200);
  check('and the label is still there afterwards', await page.evaluate(() => Boolean(document.getElementById('group-hint'))));
  await ctx.close();
}
console.log(fail ? `\n=== ${fail} failures ===` : '\n=== the label stays put ===');
await browser.close();
process.exit(fail ? 1 : 0);
