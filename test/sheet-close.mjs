// The bottom of a sheet is a set of choices, and it should read as one.
//
// Close was styled as a bare text link under two full-width pills, so the last
// thing on the account sheet looked like a caption rather than the third
// option it is. It now shares the pills' shape -- same width, radius, padding,
// type -- while staying the quietest of them: a neutral outline instead of the
// brand, because closing must never compete with what the sheet is asking for.
//
// Checked as a relationship between the buttons rather than against fixed
// pixels, so a change to the button shape carries Close along with it instead
// of leaving it behind.
import { launchBrowser } from './browser.mjs';

const B = process.env.PP_BASE || 'http://127.0.0.1:9695';
let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };

const browser = await launchBrowser();
const ctx = await browser.newContext({ viewport: { width: 414, height: 900 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
await page.addInitScript(() => {
  localStorage.setItem('pp-onboarded', '1');
  localStorage.setItem('pp-park', 'magic-kingdom');
});
await page.goto(B + '/app', { waitUntil: 'domcontentloaded', timeout: 25000 });
await page.waitForTimeout(2000);

// Every sheet that has a Close, found on the page rather than listed here, so
// a new sheet is covered the day somebody adds one.
const sheets = await page.evaluate(() => [...document.querySelectorAll('.sheet')]
  .filter((s) => s.querySelector('.cancel') && s.querySelector('.btn'))
  .map((s) => s.id));
check('the sheets with a Close were found', sheets.length >= 3, sheets.join(', '));

for (const id of sheets) {
  const m = await page.evaluate((sheetId) => {
    document.querySelectorAll('.sheet.open').forEach((s) => s.classList.remove('open'));
    const sheet = document.getElementById(sheetId);
    sheet.classList.add('open');
    document.getElementById('sheet-bg')?.classList.add('open');
    const read = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        w: Math.round(r.width),
        radius: cs.borderTopLeftRadius,
        size: cs.fontSize,
        weight: cs.fontWeight,
        padX: cs.paddingLeft,
        padY: cs.paddingTop,
        borderW: parseFloat(cs.borderTopWidth),
        color: cs.color,
      };
    };
    // The widest primary button in the sheet is the one Close sits under.
    const btns = [...sheet.querySelectorAll('.btn')].filter((b) => b.offsetParent !== null);
    const primary = btns.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
    return { close: read(sheet.querySelector('.cancel')), primary: primary ? read(primary) : null };
  }, id);
  await page.waitForTimeout(150);

  console.log(`\n[#${id}]`);
  if (!m.primary) { check('  it has a button to match', false); continue; }
  check('  Close is as wide as the button above it', m.close.w === m.primary.w, `${m.close.w} vs ${m.primary.w}`);
  check('  same corner', m.close.radius === m.primary.radius, `${m.close.radius} vs ${m.primary.radius}`);
  check('  same type', m.close.size === m.primary.size && m.close.weight === m.primary.weight,
    `${m.close.size}/${m.close.weight} vs ${m.primary.size}/${m.primary.weight}`);
  check('  same padding', m.close.padX === m.primary.padX && m.close.padY === m.primary.padY,
    `${m.close.padY} ${m.close.padX} vs ${m.primary.padY} ${m.primary.padX}`);
  // ...and still visibly the lesser of the two: an outline, not a fill, and
  // muted ink rather than the brand's white-on-purple.
  check('  but outlined, not filled', m.close.borderW > 0, `border ${m.close.borderW}px`);
  check('  and quieter than what it sits under', m.close.color !== m.primary.color,
    `${m.close.color} vs ${m.primary.color}`);
}

await ctx.close();
await browser.close();
console.log(fail ? `\n=== ${fail} failures ===` : '\n=== the sheet buttons are one family ===');
process.exit(fail ? 1 : 0);
