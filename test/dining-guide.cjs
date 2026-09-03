// The dining guide is written once per park per language and cached. What was
// never handled is the guide that cannot be written.
//
// The browser polls every four seconds for a minute and a half. The in-flight
// entry is deleted the moment a generation settles, so a FAILED one left
// nothing behind and the next poll started another -- twenty-two model calls
// per visitor per park, all failing, while the screen said "cooking up..."
// the entire time. This is the guard for that.
process.env.ANTHROPIC_API_KEY = 'stub';
process.env.DB_FILE = '/tmp/pp-dining-test.db';
process.env.PORT = '9681';
process.env.PASS_SECRET = 'testsecret';

const fs = require('node:fs');
for (const f of [process.env.DB_FILE, process.env.DB_FILE + '-wal', process.env.DB_FILE + '-shm']) fs.rmSync(f, { force: true });

let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };

const consultant = require('../consultant.js');
let calls = 0, mode = 'throw';
const GUIDE = [
  { name: 'Be Our Guest', type: 'table', price: '$$$', blurb: 'Beast’s castle, and the only one worth the queue.', mustBook: true },
  { name: 'Columbia Harbour House', type: 'quick', price: '$', blurb: 'Upstairs is the quietest room in the park.', mustBook: false },
];
const sent = [];
consultant._setClient({ beta: { messages: { create: async (args) => {
  calls++;
  sent.push(args);
  if (mode === 'throw') throw new Error('invalid x-api-key');
  if (mode === 'empty') return { model: 'claude-sonnet-5', stop_reason: 'end_turn', content: [{ type: 'text', text: '[]' }], usage: { input_tokens: 10, output_tokens: 2 } };
  return { model: 'claude-sonnet-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(GUIDE) }], usage: { input_tokens: 100, output_tokens: 60 } };
} } } });
const db = require('../db.js');

const B = 'http://127.0.0.1:9681';
const get = (slug = 'magic-kingdom', lang = 'en') => fetch(`${B}/api/dining/${slug}?lang=${lang}`);
const settle = () => new Promise((r) => setTimeout(r, 350));

(async () => {
  const server = require('../server.js');
  for (let i = 0; i < 60 && !(await fetch(`${B}/api/config`).then((r) => r.ok).catch(() => false)); i++) {
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log('\n[a guide that cannot be written is only attempted once]');
  {
    calls = 0; mode = 'throw';
    const first = await get();
    check('the first ask starts the work', first.status === 202, String(first.status));
    await settle();
    // This is the browser's poll loop, at speed.
    const codes = [];
    for (let i = 0; i < 5; i++) { codes.push((await get()).status); await settle(); }
    check('every poll after the failure is told so at once', codes.every((c) => c === 503), codes.join(','));
    check('and only ONE generation was ever attempted', calls === 1, `${calls} calls`);
    const body = await (await get()).json();
    check('the reason travels with it, for the logs and the health panel', /x-api-key/.test(body.reason || ''), JSON.stringify(body));
  }

  console.log('\n[an empty guide counts as a failure, not as a guide]');
  {
    calls = 0; mode = 'empty';
    // A different language, so it is a fresh job key rather than the cooled-down one.
    const first = await get('magic-kingdom', 'pt');
    check('it starts', first.status === 202, String(first.status));
    await settle();
    const second = await get('magic-kingdom', 'pt');
    check('nothing to show is reported, not retried forever', second.status === 503, String(second.status));
    check('one attempt', calls === 1, `${calls} calls`);
    check('and nothing empty was cached', db.dining.get('magic-kingdom', 'pt') === null, String(db.dining.get('magic-kingdom', 'pt')));
  }

  console.log('\n[a guide that works is cached and costs nothing again]');
  {
    calls = 0; mode = 'ok';
    const first = await get('magic-kingdom', 'es');
    check('it starts', first.status === 202, String(first.status));
    await settle();
    const res = await get('magic-kingdom', 'es');
    check('the guide comes back', res.status === 200, String(res.status));
    const d = await res.json();
    check('with the restaurants in it', Array.isArray(d.list) && d.list.length === 2, JSON.stringify(d).slice(0, 90));
    check('and where to book', Boolean(d.reserve && d.reserve.url), JSON.stringify(d.reserve));
    const before = calls;
    await get('magic-kingdom', 'es');
    await get('magic-kingdom', 'es');
    check('reading it again is free', calls === before, `${calls - before} extra calls`);
  }

  console.log('\n[a recovered upstream is not held against the park]');
  {
    // The cooldown is what stops the storm; it must not outlive the outage
    // in a way that makes a working guide unreachable. A fresh key is a
    // fresh job key here, which is the same path a cooled-down retry takes.
    calls = 0; mode = 'ok';
    const first = await get('epcot', 'en');
    await settle();
    const res = await get('epcot', 'en');
    check('a park that works still works', res.status === 200, String(res.status));
    check('after exactly one generation', calls === 1, `${calls} calls`);
  }

  console.log('\n[what the catalogue tier is actually asked for]');
  {
    // Reported from production: the dining guide failed on every park while
    // Mila answered normally. The advisor and the catalogue run on DIFFERENT
    // models, and this call was sending the advisor's server-side refusal
    // fallback to the catalogue one -- a parameter that buys nothing here (a
    // declined strict-JSON guide should fail and be retried, not be re-run on
    // a substitute) and that fails the whole call if the tier will not take
    // it. Every catalogue job that sent it broke; the one that never sent it
    // kept working.
    mode = 'ok';
    calls = 0; sent.length = 0;
    // A language nothing has generated yet, or the cache answers and this
    // block asserts about a call that never happened.
    await fetch(`${B}/api/dining/magic-kingdom?lang=fr`).catch(() => {});
    for (let i = 0; i < 30 && !sent.length; i++) await new Promise((r) => setTimeout(r, 100));
    check('a generation actually ran', sent.length > 0, `calls=${calls}`);
    const args = sent[0] || {};
    check('the guide is asked for on the catalogue tier', args.model === consultant.models.catalogue, String(args.model));
    check('and without the advisor tier\'s refusal fallback', args.fallbacks === undefined, JSON.stringify(args.fallbacks));
    check('nor its beta flag', args.betas === undefined, JSON.stringify(args.betas));
  }
  console.log('\n[where "Book a table" goes]');
  {
    const REG = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, '..', 'data', 'parks.json'), 'utf8'));
    const byGroup = {};
    for (const p of REG) (byGroup[p.group] ||= []).push(p);
    const links = REG.map((p) => ({ p, r: server._reserveFor(p) })).filter((x) => x.r);
    // The resorts whose pages were checked by hand. A park in any of these
    // must have a link; a resort dropped from the table shows up here.
    const VERIFIED = ['Walt Disney World', 'Disneyland (California)', 'Universal Orlando', 'Universal Hollywood', 'Disneyland Paris', 'Tokyo Disney Resort', 'Hong Kong Disneyland', 'Shanghai Disneyland', 'Universal Studios Japan', 'Europa-Park', 'Efteling'];
    const uncovered = REG.filter((p) => VERIFIED.includes(p.group) && !server._reserveFor(p)).map((p) => p.slug);
    check('every park of a verified resort has somewhere to send people', uncovered.length === 0, uncovered.join(', '));
    check('and that is nineteen parks across eleven resorts', links.length === 19 && new Set(links.map((x) => x.p.group)).size === 11, `${links.length} parks, ${new Set(links.map((x) => x.p.group)).size} resorts`);
    check('every link is https', links.every((x) => /^https:\/\//.test(x.r.url)), links.filter((x) => !/^https:\/\//.test(x.r.url)).map((x) => x.p.slug).join(', '));
    // A resort with several parks must send each park to its own page --
    // the resort-wide list is the "incorrect filters" a visitor reported.
    const shared = server._reserveSharedGroups;
    const offenders = [];
    for (const [group, parks] of Object.entries(byGroup)) {
      if (parks.length < 2 || shared.has(group)) continue;
      for (const p of parks) { const r = server._reserveFor(p); if (r && !r.scoped) offenders.push(p.slug); }
    }
    check('every park in a multi-park resort has its own dining page', offenders.length === 0, offenders.join(', '));
    check('and the parks that share one are the known exception only', [...shared].join(',') === 'Universal Orlando', [...shared].join(','));
    // Two parks never point at the same park page.
    const scoped = links.filter((x) => x.r.scoped).map((x) => x.r.url);
    check('no two parks share a park page', new Set(scoped).size === scoped.length);
    check('Hollywood goes to the reservations page, not the hub', /reservations/.test(server._reserveFor(REG.find((p) => p.slug === 'universal-studios-hollywood')).url));
  }


  console.log(`\n=== ${fail ? fail + ' failed' : 'a guide that cannot be written is asked for once, not twenty-two times'} ===`);
  process.exit(fail ? 1 : 0);
})();
