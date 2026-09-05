// The laptop layout: a sticky rail beside the ride list, footer underneath.
//
// Chromium lets a sticky grid item slide anywhere inside the grid CONTAINER,
// not just its own cell. So whenever the rail was taller than the ride list
// -- six Express rides at Universal on a fog day, with weather, the pass
// verdict and the forecast all loaded -- it slid straight down over the
// footer. The footer now sits outside the grid, and this checks both halves
// of the bargain: the rail cannot reach the footer, and it still sticks.
import { launchBrowser } from './browser.mjs';

const B = process.env.PP_BASE || 'http://127.0.0.1:9695';
let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };

const browser = await launchBrowser();
const ctx = await browser.newContext({ viewport: { width: 1891, height: 936 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
await page.addInitScript(() => {
  localStorage.setItem('pp-onboarded', '1');
  localStorage.setItem('pp-park', 'magic-kingdom');
});
await page.goto(B + '/app', { waitUntil: 'domcontentloaded', timeout: 25000 });
await page.waitForTimeout(2500);

const measure = async () => {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(300);
  return page.evaluate(() => {
    const r = document.querySelector('.rail').getBoundingClientRect();
    const f = document.querySelector('footer').getBoundingClientRect();
    return { railTop: Math.round(r.top), railBottom: Math.round(r.bottom), footerTop: Math.round(f.top), mainH: Math.round(document.querySelector('.main').getBoundingClientRect().height) };
  });
};

const laid = await page.evaluate(() => getComputedStyle(document.querySelector('.wrap')).display);
check('the laptop view is the two-column grid', laid === 'grid', laid);
check('the footer is not a grid item', await page.evaluate(() => document.querySelector('footer').parentElement !== document.querySelector('.rail').parentElement));

// A long list: the rail must still stick under the top of the window.
const long = await measure();
check('with a long ride list the rail sticks at the top', long.railTop === 16, `rail top ${long.railTop}`);

// A short list and a tall rail -- the laptop-with-Express-rides case.
await page.evaluate(() => {
  [...document.querySelectorAll('#rides > *')].slice(6).forEach((el) => el.remove());
  document.querySelector('.rail').style.paddingBottom = '700px';
});
await page.waitForTimeout(300);
const tall = await measure();
check('the ride list is now shorter than the rail', tall.mainH < tall.railBottom - tall.railTop, `main ${tall.mainH}`);
check('and the rail stops above the footer instead of covering it', tall.railBottom <= tall.footerTop, `rail ends ${tall.railBottom}, footer starts ${tall.footerTop}`);

await browser.close();
console.log(fail ? `\n${fail} check(s) failed` : '\nall checks passed');
process.exit(fail ? 1 : 0);
