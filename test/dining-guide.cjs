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
consultant._setClient({ beta: { messages: { create: async () => {
  calls++;
  if (mode === 'throw') throw new Error('invalid x-api-key');
  if (mode === 'empty') return { model: 'claude-sonnet-5', stop_reason: 'end_turn', content: [{ type: 'text', text: '[]' }], usage: { input_tokens: 10, output_tokens: 2 } };
  return { model: 'claude-sonnet-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(GUIDE) }], usage: { input_tokens: 100, output_tokens: 60 } };
} } } });
const db = require('../db.js');

const B = 'http://127.0.0.1:9681';
const get = (slug = 'magic-kingdom', lang = 'en') => fetch(`${B}/api/dining/${slug}?lang=${lang}`);
const settle = () => new Promise((r) => setTimeout(r, 350));

(async () => {
  require('../server.js');
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

  console.log(`\n=== ${fail ? fail + ' failed' : 'a guide that cannot be written is asked for once, not twenty-two times'} ===`);
  process.exit(fail ? 1 : 0);
})();
