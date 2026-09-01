// The dashboard page runs at all.
//
// Every other admin test talks to the API. None of them load the page, so a
// syntax error in its script -- one `const` named the same as another in the
// same function, which is exactly what happened -- kills the whole dashboard
// while every test stays green. Chrome reports that as a pageerror before a
// single element renders, so: load it, and demand silence.
import { launchBrowser } from './browser.mjs';

const B = process.env.PP_BASE || 'http://127.0.0.1:9695';
let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };

const browser = await launchBrowser();
const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.goto(B + '/admin', { waitUntil: 'domcontentloaded', timeout: 25000 });
await page.waitForTimeout(1500);
console.log('\n[/admin, signed out]');
check('the script ran without throwing', errs.length === 0, errs[0]);
check('and got as far as showing the sign-in card', await page.evaluate(() => {
  const l = document.getElementById('login'); return !!l && !l.hidden && getComputedStyle(l).display !== 'none';
}));
await browser.close();
console.log(fail ? `\n=== ${fail} failures ===` : '\n=== the dashboard page runs ===');
process.exit(fail ? 1 : 0);
