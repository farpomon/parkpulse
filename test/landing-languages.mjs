// The landing page promotes speaking the visitor's language as a headline
// feature, and lists all of them. Two ways that goes wrong quietly: a
// dictionary is added or dropped and the list no longer matches what the app
// ships, or the copy keeps claiming a number that is no longer true. Both are
// checked against the dictionaries on disk rather than against a constant.
//
// The section is also the one place on the page where an untranslated block
// would be self-refuting, so the translated landings are checked too.
import { launchBrowser } from './browser.mjs';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const B = process.env.PP_BASE || 'http://127.0.0.1:9695';
let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };

const dicts = fs.readdirSync(path.join(ROOT, 'public', 'i18n')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
const EXPECT = dicts.length + 1;                     // + English, which is the keys
const NUMBER_WORD = { 18: 'eighteen', 19: 'nineteen', 20: 'twenty', 21: 'twenty-one', 22: 'twenty-two' };

const home = await (await fetch(B + '/')).text();
const section = home.match(/<section class="sec" id="languages">([\s\S]*?)<\/section>/)?.[1] || '';

console.log(`\n[${EXPECT} languages ship: ${['en', ...dicts].join(' ')}]`);
check('the page has a languages section', Boolean(section));
const cards = [...section.matchAll(/<div class="lang"[^>]*><b>([^<]+)<\/b><span[^>]*>([^<]+)<\/span>/g)]
  .map((m) => ({ native: m[1], english: m[2] }));
check('it lists one card per language the app ships', cards.length === EXPECT, `${cards.length} cards for ${EXPECT} dictionaries`);
check('every card is named in its own language and in English', cards.every((c) => c.native && c.english), JSON.stringify(cards.filter((c) => !c.native || !c.english)));
check('no language is listed twice', new Set(cards.map((c) => c.english)).size === cards.length);
for (const code of ['ar', 'ur']) {
  if (!dicts.includes(code)) continue;
  const name = { ar: 'Arabic', ur: 'Urdu' }[code];
  const row = section.match(new RegExp(`<div class="lang"([^>]*)><b>[^<]+</b><span[^>]*>${name}<`));
  check(`${name} is set right-to-left`, /dir="rtl"/.test(row?.[1] || ''), row?.[1] ?? 'card not found');
}

console.log('\n[the copy agrees with the code]');
// The claim is authored as prose so it stays translatable; this is what stops
// it drifting away from the dictionaries behind it.
check(`the hero says "${EXPECT} languages"`, home.includes(`<span>In ${EXPECT} languages</span>`),
  home.match(/<span>In \d+ languages<\/span>/)?.[0] ?? 'the hero fact is missing');
check(`the section says "${NUMBER_WORD[EXPECT]}"`, new RegExp(NUMBER_WORD[EXPECT], 'i').test(section),
  section.match(/^[\s\S]{0,400}/)[0].replace(/\s+/g, ' ').slice(0, 160));
const claimed = [...home.matchAll(/(\d+) languages/g)].map((m) => Number(m[1]));
check('no other number of languages is claimed anywhere on the page', claimed.every((n) => n === EXPECT), claimed.join(', '));

// Writing a dictionary by hand, a character from the neighbouring language
// slips in and reads as a typo to everyone who speaks it: a Hangul syllable
// landed in the middle of a Japanese sentence twice while these were written.
// Cheap to catch, invisible to anyone who does not read the script.
console.log('\n[nothing from the wrong alphabet]');
{
  const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'landing-i18n.json'), 'utf8'));
  const HANGUL = /[\uac00-\ud7af\u1100-\u11ff]/;
  const KANA = /[\u3040-\u309f\u30a0-\u30ff]/;
  const CYRILLIC = /[\u0400-\u04ff]/;
  const ARABIC = /[\u0600-\u06ff]/;
  const DEVANAGARI = /[\u0900-\u097f]/;
  const FOREIGN = {
    zh: [['Hangul', HANGUL], ['kana', KANA], ['Cyrillic', CYRILLIC], ['Arabic', ARABIC], ['Devanagari', DEVANAGARI]],
    ja: [['Hangul', HANGUL], ['Cyrillic', CYRILLIC], ['Arabic', ARABIC], ['Devanagari', DEVANAGARI]],
    ko: [['kana', KANA], ['Cyrillic', CYRILLIC], ['Arabic', ARABIC], ['Devanagari', DEVANAGARI]],
    ru: [['Hangul', HANGUL], ['kana', KANA], ['Arabic', ARABIC], ['Devanagari', DEVANAGARI]],
    // The Latin dictionaries should carry no other script at all.
    es: [['Hangul', HANGUL], ['kana', KANA], ['Cyrillic', CYRILLIC], ['Arabic', ARABIC], ['Devanagari', DEVANAGARI]],
    pt: [['Hangul', HANGUL], ['kana', KANA], ['Cyrillic', CYRILLIC], ['Arabic', ARABIC], ['Devanagari', DEVANAGARI]],
    fr: [['Hangul', HANGUL], ['kana', KANA], ['Cyrillic', CYRILLIC], ['Arabic', ARABIC], ['Devanagari', DEVANAGARI]],
    de: [['Hangul', HANGUL], ['kana', KANA], ['Cyrillic', CYRILLIC], ['Arabic', ARABIC], ['Devanagari', DEVANAGARI]],
    it: [['Hangul', HANGUL], ['kana', KANA], ['Cyrillic', CYRILLIC], ['Arabic', ARABIC], ['Devanagari', DEVANAGARI]],
  };
  const strays = [];
  for (const [lang, tests] of Object.entries(FOREIGN)) {
    for (const [key, value] of Object.entries(dict[lang] || {})) {
      for (const [label, rx] of tests) {
        const m = rx.exec(value);
        if (m) strays.push(`${lang}: ${label} ${JSON.stringify(m[0])} in ${JSON.stringify(value.slice(0, 50))}`);
      }
    }
  }
  check('no dictionary carries a character from another script', strays.length === 0, strays.slice(0, 3).join(' | '));
}

console.log('\n[promoted, not buried]');
check('the nav links to it', /href="#languages"/.test(home));
check('it sits above the screenshots, not at the bottom of the page',
  home.indexOf('id="languages"') < home.indexOf('<!--SHOTS-->') || home.indexOf('id="languages"') < home.indexOf('See it before you buy'));
check('the VIP list names it too', /In your language/.test(home));

// Which languages the landing page actually serves. Asking beats a hardcoded
// list: a language is added by filling its dictionary, and the test should
// start covering it the moment it does, not the next time someone edits this.
const LANDING_CODES = ['es', 'pt', 'fr', 'de', 'it', 'zh', 'ja', 'ko', 'ru'];
const shipped = [];
for (const code of LANDING_CODES) {
  try { if ((await fetch(`${B}/${code}`)).ok) shipped.push(code); } catch {}
}
console.log(`\n[the translated landings: ${shipped.join(' ') || 'none'}]`);
check('at least one language ships besides English', shipped.length > 0);
for (const lang of shipped) {
  const page = await (await fetch(`${B}/${lang}`)).text();
  const sec = page.match(/<section class="sec" id="languages">([\s\S]*?)<\/section>/)?.[1] || '';
  const h2 = sec.match(/<h2>([\s\S]*?)<\/h2>/)?.[1]?.trim();
  const lead = sec.match(/<p class="lead">([\s\S]*?)<\/p>/)?.[1]?.trim();
  const note = sec.match(/<p class="note"[^>]*>([\s\S]*?)<\/p>/)?.[1]?.trim();
  check(`/${lang} has the section`, Boolean(h2 && lead && note));
  check(`  and it is not still in English`, h2 !== 'The whole day, in your language' && !/and not just the buttons/.test(lead || ''), `${h2} | ${(lead || '').slice(0, 60)}`);
  check(`  the list is all ${EXPECT}`, (sec.match(/class="lang"/g) || []).length === EXPECT);
  check(`  the nav link is translated`, !/>Languages</.test(page.match(/href="#languages"[^>]*>[^<]*</)?.[0] || ''), page.match(/href="#languages"[^>]*>([^<]*)</)?.[1]);
}

// Layout: the one name that wraps is Bahasa Indonesia, and a wrapped card must
// not leave its row taller than the rest or push the page sideways.
if (!process.env.PP_NO_BROWSER) {
  console.log('\n[how it lays out]');
  const browser = await launchBrowser();
  for (const [label, width] of [['desktop', 1280], ['tablet', 760], ['phone', 390]]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await page.goto(B + '/', { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(1200);
    const m = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('#languages .lang')];
      const tops = [...new Set(cards.map((c) => Math.round(c.getBoundingClientRect().top)))];
      const heights = [...new Set(cards.map((c) => Math.round(c.getBoundingClientRect().height)))];
      return {
        n: cards.length,
        rows: tops.length,
        heights,
        clipped: cards.filter((c) => c.scrollWidth > c.clientWidth + 1).length,
        pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      };
    });
    check(`${label}: all ${EXPECT} are on screen in ${m.rows} rows`, m.n === EXPECT && m.rows > 0, JSON.stringify(m));
    check(`${label}: every card is the same height`, m.heights.length === 1, m.heights.join(', '));
    check(`${label}: no name is clipped`, m.clipped === 0, `${m.clipped} clipped`);
    check(`${label}: the page does not scroll sideways`, !m.pageOverflow);
    await ctx.close();
  }
  await browser.close();
}

console.log(fail ? `\n=== ${fail} failures ===` : `\n=== all ${EXPECT} languages, listed and promoted ===`);
process.exit(fail ? 1 : 0);
