// The landing page's park directory: eight "Most popular" cards, then every
// park under its region.
//
// The regional columns used to leave the eight popular parks out, on the
// theory that they were already in the cards above. Someone on a phone
// scrolled straight past the cards, looked for Disneyland under California &
// West, and it was not there. The cards are a shortcut; the columns are the
// directory; a directory is complete or it is wrong.
import fs from 'node:fs';

const B = process.env.PP_BASE || 'http://127.0.0.1:9695';
let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };

const registry = JSON.parse(fs.readFileSync(new URL('../data/parks.json', import.meta.url), 'utf8'));
const unescape = (s) => s.replace(/&amp;/g, '&');

for (const path of ['/', '/es']) {
  const html = await fetch(B + path).then((r) => r.text());
  const cols = [...html.matchAll(/<div class="pg-col"><div class="pg-head">(.*?)<\/div>(.*?)<\/div>/gs)]
    .map((m) => ({ head: unescape(m[1]), body: m[2] }));
  console.log(`\n  ${path}`);
  check('the directory has its five regions', cols.length === 5, cols.map((c) => c.head).join(', '));
  const missing = registry.filter((p) => !cols.some((c) => c.body.includes(`href="/parks/${p.slug}"`)));
  check(`every one of the ${registry.length} parks is under a region`, missing.length === 0, missing.map((p) => p.slug).join(', '));
  const cal = cols.find((c) => c.head.startsWith('California'));
  check('Disneyland is under California & West', Boolean(cal) && cal.body.includes('href="/parks/disneyland"'));
  const fl = cols.find((c) => c.head === 'Florida');
  check('and Magic Kingdom under Florida', Boolean(fl) && fl.body.includes('href="/parks/magic-kingdom"'));
  const cards = (html.match(/<a class="pg-card"/g) || []).length;
  check('the eight Most popular cards are still there', cards === 8, String(cards));
  // Each park sits in exactly one column: the eight are duplicated between
  // the cards and their column, never between two columns.
  const twice = registry.filter((p) => cols.filter((c) => c.body.includes(`href="/parks/${p.slug}"`)).length > 1);
  check('and no park is filed under two regions', twice.length === 0, twice.map((p) => p.slug).join(', '));
}

console.log(fail ? `\n${fail} check(s) failed` : '\nall checks passed');
process.exit(fail ? 1 : 0);
