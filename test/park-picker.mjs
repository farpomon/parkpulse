// The picker's shortcuts were taking parks OUT of their own region: a visitor
// browsing Florida could not find EPCOT there, because it had been promoted to
// "Most popular" and removed from the list below. Every park belongs in its
// region whatever else is true of it.
//
// The popular row is also ordered by where the visitor is -- from real
// coordinates when they have already shared them, and from the browser's own
// timezone when they have not, which costs nothing and asks for nothing.
const pw = await import(process.env.PP_PLAYWRIGHT || 'playwright-core');
const chromium = pw.chromium || pw.default?.chromium;

const B = process.env.PP_BASE || 'http://127.0.0.1:9695';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

async function picker({ tz, geo, lang = 'en' } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 900 }, userAgent: UA, isMobile: true, hasTouch: true,
    serviceWorkers: 'block', ...(tz ? { timezoneId: tz } : {}),
  });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.addInitScript((a) => {
    localStorage.setItem('pp-onboarded', '1');
    localStorage.setItem('pp-park', 'magic-kingdom');
    if (a.lang !== 'en') localStorage.setItem('pp-lang', a.lang);
    if (a.geo) localStorage.setItem('pp-geo', JSON.stringify({ ...a.geo, at: Date.now() }));
    else localStorage.removeItem('pp-geo');
  }, { lang, geo });
  const json = (b) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
  await page.route('**/api/waits/**', (r) => r.fulfill(json({ park: 'x', source: 'live', attribution: 's', updatedAt: new Date().toISOString(), rides: [{ name: 'Atracao 1', land: 'A', wait: 20, open: true, typical: 25 }] })));
  for (const p of ['**/api/ride-tags/**', '**/api/closures/**', '**/api/weather/**', '**/api/dining/**']) await page.route(p, (r) => r.fulfill(json({})));
  await page.goto(B + '/app', { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(2600);
  const groups = await page.evaluate(() => [...document.querySelectorAll('#dest optgroup')].map((g) => ({
    label: g.label, slugs: [...g.querySelectorAll('option')].map((o) => o.value),
  })));
  const selected = await page.evaluate(() => ({
    value: document.getElementById('dest').value,
    marked: [...document.querySelectorAll('#dest option')].filter((o) => o.hasAttribute('selected')).length,
  }));
  await ctx.close();
  return { groups, selected, errs };
}
const groupNamed = (g, re) => g.find((x) => re.test(x.label));
const regionOf = (g, name) => g.find((x) => x.label === name);

console.log('\n[a park belongs in its region too]');
{
  const { groups, selected, errs } = await picker({ tz: 'America/New_York' });
  const shortcut = groups[0];
  const florida = regionOf(groups, 'Florida');
  console.log(`      groups: ${groups.map((g) => `${g.label}(${g.slugs.length})`).join(', ')}`);
  check('there is a Florida group', Boolean(florida));
  check('EPCOT is in it', florida?.slugs.includes('epcot'), JSON.stringify(florida?.slugs.slice(0, 6)));
  check('and Magic Kingdom too', florida?.slugs.includes('magic-kingdom'));
  check('while both still head the shortcut row', shortcut.slugs.includes('epcot') && shortcut.slugs.includes('magic-kingdom'), JSON.stringify(shortcut.slugs.slice(0, 4)));
  const counts = {};
  for (const g of groups) for (const s of g.slugs) counts[s] = (counts[s] || 0) + 1;
  check('every park appears somewhere', Object.keys(counts).length >= 60, Object.keys(counts).length);
  check('and no park more than twice', Object.values(counts).every((n) => n <= 2), JSON.stringify(Object.entries(counts).filter(([, n]) => n > 2)));

  console.log('\n[the duplicate does not confuse the select]');
  check('exactly one option carries selected', selected.marked === 1, `${selected.marked}`);
  check('and it is the current park', selected.value === 'magic-kingdom', selected.value);
  check('no page errors', errs.length === 0, errs[0]);
}

console.log('\n[ordered by where the visitor is]');
{
  const la = await picker({ tz: 'America/Los_Angeles' });
  const tokyo = await picker({ tz: 'Asia/Tokyo' });
  const lisbon = await picker({ tz: 'Europe/Lisbon' });
  const first = (r) => r.groups[0].slugs.slice(0, 4);
  console.log(`      Los Angeles: ${first(la).join(', ')}`);
  console.log(`      Tokyo:       ${first(tokyo).join(', ')}`);
  console.log(`      Lisbon:      ${first(lisbon).join(', ')}`);
  const CAL = ['disneyland', 'california-adventure', 'universal-hollywood', 'knotts-berry-farm', 'six-flags-magic-mountain', 'seaworld-san-diego', 'legoland-california'];
  const JP = ['tokyo-disneyland', 'tokyo-disneysea', 'universal-studios-japan'];
  check('California leads for a Californian', CAL.includes(first(la)[0]), first(la)[0]);
  check('Japan leads for someone in Tokyo', JP.includes(first(tokyo)[0]), first(tokyo)[0]);
  check('and the three orders are not all the same', new Set([first(la).join(), first(tokyo).join(), first(lisbon).join()]).size >= 2);
  check('the label still says popular, since nothing was measured', /popular/i.test(la.groups[0].label), la.groups[0].label);
  check('and the row holds the same parks either way', la.groups[0].slugs.slice().sort().join() === tokyo.groups[0].slugs.slice().sort().join());
}

console.log('\n[when they have actually shared a location]');
{
  // Anaheim, rounded the way the app stores it.
  const r = await picker({ tz: 'Europe/Lisbon', geo: { lat: 33.8, lng: -117.9 } });
  console.log(`      first: ${r.groups[0].slugs.slice(0, 3).join(', ')}  ·  label: ${r.groups[0].label}`);
  check('coordinates beat the timezone', ['disneyland', 'california-adventure'].includes(r.groups[0].slugs[0]), r.groups[0].slugs[0]);
  check('and the label now claims proximity', /nearest/i.test(r.groups[0].label), r.groups[0].label);
  const stale = await picker({ tz: 'Europe/Lisbon' });
  check('without a location it does not claim it', !/nearest/i.test(stale.groups[0].label), stale.groups[0].label);
}

console.log('\n[pt]');
{
  const r = await picker({ tz: 'America/Sao_Paulo', lang: 'pt', geo: { lat: 28.4, lng: -81.6 } });
  console.log(`      label: "${r.groups[0].label}"  first: ${r.groups[0].slugs.slice(0, 3).join(', ')}`);
  check('the label is translated', !/nearest to you/i.test(r.groups[0].label), r.groups[0].label);
  check('Orlando leads from Orlando coordinates', ['magic-kingdom', 'epcot', 'hollywood-studios', 'animal-kingdom', 'universal-studios-florida', 'islands-of-adventure', 'epic-universe', 'seaworld-orlando'].includes(r.groups[0].slugs[0]), r.groups[0].slugs[0]);
}

console.log(fail ? `\n=== ${fail} failures ===` : '\n=== every park is where you would look for it ===');
await browser.close();
process.exit(fail ? 1 : 0);
