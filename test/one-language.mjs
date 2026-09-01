// A page is written in one language, and the URL is what picks it.
//
// It was not. The landing page at "/" is rendered in English, but the client
// dictionary chose its language from the browser, so a Brazilian phone loaded
// the Portuguese dictionary over the English page and Mila's speech bubble
// floated past saying "É só falar e o dia começa a brilhar" above English
// marketing copy. Every string that goes through PP_T was exposed the same
// way -- the bubble was simply the one that moves, so it was the one somebody
// saw.
//
// The rule this locks down: a server-rendered page declares its language and
// that wins for everything drawn on it; the visitor's own choice is kept, but
// it decides the app, not somebody else's page.
import { launchBrowser } from './browser.mjs';

const B = process.env.PP_BASE || 'http://127.0.0.1:9695';
let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };

// The bubble that started this, plus the rest of the rotation it belongs to.
// Read from the page itself rather than copied here, so a new line is covered
// the day it is written instead of the next time someone remembers this file.
const home = await (await fetch(B + '/')).text();
const milaLines = [...(home.match(/const MILA_LINES = \[([\s\S]*?)\];/)?.[1] || '')
  .matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
const pipLines = [...(home.match(/const THOUGHTS = \[([\s\S]*?)\];/)?.[1] || '')
  .matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);

console.log('\n[every landing page says which language it is]');
check('the sprite lines were found to test against', milaLines.length > 0 && pipLines.length > 0,
  `${milaLines.length} of Mila's, ${pipLines.length} of Pip's`);
check('/ declares English', /window\.PP_PAGE_LANG='en'/.test(home),
  home.match(/PP_PAGE_LANG='[a-z]*'/)?.[0] ?? 'no declaration at all');
// English is the one that had no declaration, because it needed no translating
// -- which is exactly why it was the page that leaked.
const shipped = [];
for (const code of ['es', 'pt', 'fr', 'de', 'it', 'zh', 'ja', 'ko', 'ru']) {
  const res = await fetch(`${B}/${code}`);
  if (!res.ok) continue;
  shipped.push(code);
  const page = await res.text();
  check(`/${code} declares ${code}`, page.includes(`window.PP_PAGE_LANG='${code}'`),
    page.match(/PP_PAGE_LANG='[a-z]*'/)?.[0] ?? 'no declaration at all');
}
check('at least one translated landing was checked', shipped.length > 0);

if (process.env.PP_NO_BROWSER) {
  console.log(fail ? `\n=== ${fail} failures ===` : '\n=== one language per page (markup only) ===');
  process.exit(fail ? 1 : 0);
}

const browser = await launchBrowser();
// A visitor whose own language is Portuguese: saved choice AND browser, so
// neither route into the old behaviour is left open.
const read = async (path, own) => {
  const ctx = await browser.newContext({ locale: own === 'pt' ? 'pt-BR' : 'en-US', serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await page.addInitScript((l) => { try { localStorage.setItem('pp-lang', l); } catch (e) {} }, own);
  await page.goto(B + path, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForFunction(() => typeof window.PP_T === 'function', null, { timeout: 10000 });
  await page.evaluate(() => window.PP_READY);
  const out = await page.evaluate(({ mila, pip }) => ({
    lang: window.PP_LANG,
    htmlLang: document.documentElement.lang,
    userLang: window.PP_USER_LANG,
    // Which of the sprite lines the dictionary would rewrite. On a page in the
    // language the lines are already written in, that must be none of them.
    rewritten: [...mila, ...pip].filter((k) => window.PP_T(k) !== k),
    sample: window.PP_T(mila[0] || ''),
  }), { mila: milaLines, pip: pipLines });
  await ctx.close();
  return out;
};

console.log('\n[a Portuguese phone on the English page]');
{
  const r = await read('/', 'pt');
  check('reads the page in English', r.lang === 'en', r.lang);
  check('and the document says so', r.htmlLang === 'en', r.htmlLang);
  check('no sprite line is translated out from under the copy',
    r.rewritten.length === 0, r.rewritten.slice(0, 2).join(' | '));
  check('the bubble stays in the language of the page it floats over',
    r.sample === milaLines[0], `${r.sample} (wanted ${milaLines[0]})`);
  check('their own language is remembered, not overwritten', r.userLang === 'pt', r.userLang);
}

if (shipped.includes('pt')) {
  console.log('\n[an English phone on the Portuguese page]');
  const r = await read('/pt', 'en');
  check('reads the page in Portuguese', r.lang === 'pt', r.lang);
  // This one is not cosmetic: /pt is an indexable page, and a client script
  // resetting <html lang> to "en" tells every crawler it is English.
  check('and the document still says Portuguese', r.htmlLang === 'pt', r.htmlLang);
  // Arriving straight at /pt is itself a choice, and the page has always
  // recorded it so the app behind the CTA opens in the same language rather
  // than asking twice. That is deliberate, and it is the one direction the
  // carry runs: "/" records nothing, so an English page can never quietly
  // reset somebody's Portuguese app back to English.
  check('arriving here counts as choosing it', r.userLang === 'pt', r.userLang);
}

console.log('\n[the app is nobody else’s page]');
{
  const r = await read('/app', 'pt');
  check('it opens in the language the visitor chose', r.lang === 'pt', r.lang);
  check('and the dictionary is actually loaded', r.rewritten.length > 0 || r.sample !== milaLines[0],
    'nothing translated — the app fell back to English');
}

await browser.close();
console.log(fail ? `\n=== ${fail} failures ===` : '\n=== one language per page ===');
process.exit(fail ? 1 : 0);
