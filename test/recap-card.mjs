// The day, summed up and shared.
//
// Three rides ticked off and the Today pane offers "Share my day": how many,
// how long in line, how that compares with a typical day here. The share
// button draws a real picture and hands it to the phone's share sheet; a
// phone without one gets the picture opened to save. Fewer than three rides,
// or a day being planned ahead, and there is nothing to sum up.
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
  // The share sheet, stood in for: it records what it was handed.
  window.__shared = null;
  navigator.canShare = () => true;
  navigator.share = async (d) => { window.__shared = { files: d.files.map((f) => ({ name: f.name, type: f.type, size: f.size })), text: d.text }; };
});
await page.goto(B + '/app', { waitUntil: 'domcontentloaded', timeout: 25000 });
await page.waitForTimeout(2500);

check('with nothing ridden there is no card', await page.evaluate(() => !document.getElementById('recap')));

// Three rides ticked, in the app's own words: the first three the board shows.
const ticked = await page.evaluate(() => {
  const names = [...document.querySelectorAll('#rides .ride .rode')].slice(0, 3);
  names.forEach((b) => b.click());
  return names.length;
});
check('three rides can be ticked off the board', ticked === 3, String(ticked));
await page.waitForTimeout(400);
const card = await page.evaluate(() => { const c = document.getElementById('recap'); return c ? c.textContent : null; });
check('the card appears, counting them', card && /3 rides today/.test(card), card);
check('  with the minutes in line', card && /\d+ min in line/.test(card));

// The picture. Clicked through the DOM: on a fresh device the account sheet
// sits over the pane, and it is the button that is under test, not the sheet.
await page.evaluate(() => document.getElementById('recap-share').click());
await page.waitForTimeout(1500);
const shared = await page.evaluate(() => window.__shared);
check('Share hands the share sheet a picture', shared && shared.files.length === 1 && shared.files[0].type === 'image/png', JSON.stringify(shared));
check('  a real one, not a blank', shared && shared.files[0].size > 20000, shared && String(shared.files[0].size));
check('  with the numbers in the text beside it', shared && /3 rides today/.test(shared.text) && /parkpulse\.fun/.test(shared.text), shared && shared.text);

// Untick one: back under three, the card goes.
await page.evaluate(() => document.querySelector('#rides .ride .rode.on').click());
await page.waitForTimeout(300);
check('under three rides the card goes away again', await page.evaluate(() => !document.getElementById('recap')));

await browser.close();
console.log(fail ? `\n${fail} check(s) failed` : '\nall checks passed');
process.exit(fail ? 1 : 0);
