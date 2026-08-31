// The chat widget is a SECOND consultant client, and it was missed.
//
// Reported from production with a screenshot: a Portuguese app, a Portuguese
// question, and "Mila has given you everything she has for today." in English
// underneath it. The plan panel had been taught to run the server's words
// through the dictionary; this file had not, and it hands them straight to
// textContent. Nothing about it is visible until something goes wrong, which
// is why it survived an audit that walks nineteen screens in nineteen
// languages -- the audit stubs a working advisor.
import { launchBrowser } from './browser.mjs';

const B = process.env.PP_BASE || 'http://127.0.0.1:9695';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const RIDES = Array.from({ length: 6 }, (_, i) => ({ name: `Ride ${i + 1}`, land: 'A', wait: 20, open: true, typical: 30 }));

let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };
const browser = await launchBrowser();

const askIn = async (lang, fulfil) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 }, userAgent: UA, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await page.addInitScript((l) => {
    localStorage.setItem('pp-onboarded', '1');
    localStorage.setItem('pp-park', 'magic-kingdom');
    localStorage.setItem('pp-lang', l);
  }, lang);
  const json = (b) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
  await page.route('**/api/waits/**', (r) => r.fulfill(json({ park: 'x', source: 'live', attribution: 's', updatedAt: new Date().toISOString(), rides: RIDES })));
  for (const p of ['**/api/ride-tags/**', '**/api/closures/**', '**/api/weather/**', '**/api/geo/**']) await page.route(p, (r) => r.fulfill(json({})));
  await page.route('**/api/consultant', fulfil);
  await page.goto(B + '/app', { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(2500);
  // The widget's own entry point -- the same call the send button makes,
  // without depending on how the sheet happens to be opened.
  const ok = await page.evaluate(() => {
    if (!window.ParkPulseChat || !window.ParkPulseChat.ask) return false;
    window.ParkPulseChat.ask('E o passe?');
    return true;
  });
  if (!ok) { await ctx.close(); return 'NO WIDGET'; }
  await page.waitForTimeout(2500);
  const txt = await page.evaluate(() => document.getElementById('ppc-msgs')?.innerText || '');
  await ctx.close();
  return txt;
};

const sse = (body) => (r) => r.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body });

console.log('\n[the exact case from production: out of budget, in Portuguese]');
{
  const t = await askIn('pt', (r) => r.fulfill({ status: 402, contentType: 'application/json',
    body: JSON.stringify({ error: 'Mila has given you everything she has for today.', milaRest: 'account', spent: 0.2, budget: 0.2 }) }));
  check('the cap reads in Portuguese', /Mila já te deu tudo o que tinha para hoje/.test(t), t.slice(-120));
  check('and the English never reaches the reader', !/has given you everything she has/.test(t), t.slice(-120));
}

console.log('\n[the other failures the server writes in English]');
{
  const de = await askIn('de', sse(`event: error\ndata: ${JSON.stringify({ error: "Mila's key isn't being accepted right now — the operator has been told." })}\n\n`));
  check('a rejected key reads in German', /Milas Schlüssel wird gerade nicht akzeptiert/.test(de), de.slice(-120));

  const es = await askIn('es', (r) => r.fulfill({ status: 402, contentType: 'application/json',
    body: JSON.stringify({ error: 'Mila is having a little rest — everything else still works. Try her again shortly.', milaRest: 'global' }) }));
  check('the global rest reads in Spanish', /Mila está descansando un momento/.test(es), es.slice(-120));
}

console.log('\n[a replayed read says so here too]');
{
  const fr = await askIn('fr', sse('event: stale\ndata: {"at":1}\n\nevent: delta\ndata: {"text":"Allez a Space Mountain."}\n\nevent: done\ndata: {}\n\n'));
  check('the replay is labelled', /Mila n'a pas pu être jointe/.test(fr), fr.slice(-160));
  check('and her prose is still shown', /Space Mountain/.test(fr), fr.slice(-160));
}

await browser.close();
console.log(`\n=== ${fail ? fail + ' failed' : "the chat speaks the reader's language, especially when it is bad news"} ===`);
process.exit(fail ? 1 : 0);
