// When the top tier will not answer, Mila drops a tier rather than handing
// back an apology -- and when she cannot be reached at all, the server serves
// her own read of the SAME plan from earlier instead of an error.
//
// Both exist because the alternative is the product's one paid feature going
// dark for reasons a visitor can neither see nor fix.
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.DB_FILE = '/tmp/pp-mila-fallback.db';
process.env.PORT = '9661';
process.env.PRO_GATE = 'off';
const fs = require('fs');
for (const f of [process.env.DB_FILE, process.env.DB_FILE + '-wal', process.env.DB_FILE + '-shm']) fs.rmSync(f, { force: true });

let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };

const consultant = require('../consultant.js');

// What each attempt should do, keyed by the model it is made against.
let plan = {};
const asked = [];
const REPLY = 'Go straight to Space Mountain — the queue is short.';
const finalFor = (model) => ({
  model, stop_reason: 'end_turn', type: 'message', role: 'assistant',
  content: [{ type: 'text', text: REPLY }],
  usage: { input_tokens: 100, output_tokens: 20 },
});
const streamFor = (model) => {
  const boom = plan[model];
  if (boom) {
    // Thrown when the caller starts consuming, which is where a real API
    // failure surfaces.
    return { async *[Symbol.asyncIterator]() { const e = new Error(boom.msg); e.status = boom.status; throw e; },
             finalMessage: async () => { const e = new Error(boom.msg); e.status = boom.status; throw e; } };
  }
  return {
    async *[Symbol.asyncIterator]() {
      for (const t of [REPLY.slice(0, 20), REPLY.slice(20)]) yield { type: 'content_block_delta', delta: { type: 'text_delta', text: t } };
    },
    finalMessage: async () => finalFor(model),
  };
};
consultant._setClient({ beta: { messages: {
  create: async (a) => finalFor(a.model),
  stream: (a) => { asked.push(a.model); return streamFor(a.model); },
} } });

const server = require('../server.js');
const db = require('../db.js');
const B = 'http://127.0.0.1:9661';

const ask = (body) => fetch(B + '/api/consultant', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ park: 'magic-kingdom', messages: [{ role: 'user', content: 'What now?' }], ...body }),
});
// Her prose arrives in pieces, so "Space Mountain" is split across two delta
// frames and is nowhere to be found in the raw stream. Reassemble it the way
// the app does before asserting on what she said.
const drain = async (r) => {
  const t = await r.text();
  const said = [...t.matchAll(/^event: delta\ndata: (.*)$/gm)]
    .map((m) => { try { return JSON.parse(m[1]).text || ''; } catch { return ''; } }).join('');
  return { text: t, said, events: [...t.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]) };
};

(async () => {
  await new Promise((r) => setTimeout(r, 900));

  console.log('\n[the top tier answers, so nothing else is tried]');
  {
    plan = {}; asked.length = 0;
    const r = await ask({});
    const { said, events } = await drain(r);
    check('she answers', r.status === 200 && /Space Mountain/.test(said), said);
    check('on the advisor tier', asked[0] === 'claude-opus-5', JSON.stringify(asked));
    check('and no second tier is asked', asked.length === 1, JSON.stringify(asked));
    check('the stream closes cleanly', events.includes('done'), JSON.stringify(events));
  }

  console.log('\n[the top tier is unavailable to this key]');
  {
    // 404 is what a key WITHOUT ACCESS to a model gets back. It is the failure
    // that looks most like our bug and is least like one.
    plan = { 'claude-opus-5': { status: 404, msg: 'model: claude-opus-5 not found' } };
    asked.length = 0;
    const r = await ask({});
    const { said, events } = await drain(r);
    check('she still answers', r.status === 200 && /Space Mountain/.test(said), said);
    check('by dropping to the catalogue tier', asked[1] === 'claude-sonnet-5', JSON.stringify(asked));
    check('having tried the top tier first', asked[0] === 'claude-opus-5', JSON.stringify(asked));
    check('and the reader gets no error', !events.includes('error'), JSON.stringify(events));
  }

  console.log('\n[capacity and upstream failures fall back too]');
  for (const [label, status] of [['a rate limit', 429], ['an upstream failure', 503]]) {
    plan = { 'claude-opus-5': { status, msg: 'boom' } }; asked.length = 0;
    const { said } = await drain(await ask({}));
    check(`${label} drops a tier`, asked[1] === 'claude-sonnet-5' && /Space Mountain/.test(said), JSON.stringify(asked) + ' ' + said);
  }

  console.log('\n[failures a second tier cannot survive are not retried]');
  for (const [label, status, msg] of [
    ['a rejected key', 401, 'invalid x-api-key'],
    ['an empty balance', 400, 'your credit balance is too low'],
  ]) {
    plan = { 'claude-opus-5': { status, msg }, 'claude-sonnet-5': { status, msg } };
    asked.length = 0;
    const { events } = await drain(await ask({}));
    check(`${label} is not retried one tier down`, asked.length === 1, JSON.stringify(asked));
    check(`  and the reader is told`, events.includes('error'), JSON.stringify(events));
  }

  console.log('\n[she cannot be reached at all, but she read this plan before]');
  {
    // The plan panel's own question, which is the only kind that gets banked.
    const planAsk = { kind: 'plan-review', planPicks: ['Space Mountain'], messages: [{ role: 'user', content: 'Check my plan' }] };
    plan = {}; asked.length = 0;
    const first = await drain(await ask(planAsk));
    check('the first ask is answered and banked', /Space Mountain/.test(first.said), first.said);

    // Age the banked row past the ordinary replay window. Without this the
    // happy-path cache answers the second ask outright and the model is never
    // called at all -- which is correct behaviour, and would quietly turn this
    // whole case into a test of nothing.
    {
      const { DatabaseSync } = require('node:sqlite');
      const raw = new DatabaseSync(process.env.DB_FILE);
      raw.prepare('UPDATE plan_advice SET at = ?').run(new Date(Date.now() - 30 * 60 * 1000).toISOString());
      raw.close();
    }

    // Now nothing answers. Same question, same plan.
    plan = { 'claude-opus-5': { status: 503, msg: 'down' }, 'claude-sonnet-5': { status: 503, msg: 'down' } };
    asked.length = 0;
    const r = await ask(planAsk);
    const { said, events } = await drain(r);
    check('her earlier read is served instead of an apology', /Space Mountain/.test(said), said);
    check('labelled as a replay', events.includes('stale'), JSON.stringify(events));
    check('with no error event', !events.includes('error'), JSON.stringify(events));
    check('and the stream still closes cleanly', events.includes('done'), JSON.stringify(events));
    check('both tiers were genuinely tried first', asked.length === 2, JSON.stringify(asked));
  }

  console.log('\n[nothing to replay: the apology, and the wish back]');
  {
    plan = { 'claude-opus-5': { status: 503, msg: 'down' }, 'claude-sonnet-5': { status: 503, msg: 'down' } };
    const { events } = await drain(await ask({ kind: 'plan-review', planPicks: ['Nothing She Has Ever Seen'], messages: [{ role: 'user', content: 'A plan she has never read' }] }));
    check('the reader is told', events.includes('error'), JSON.stringify(events));
    check('and nothing stale is claimed', !events.includes('stale'), JSON.stringify(events));
  }

  console.log(`\n=== ${fail ? fail + ' failed' : 'Mila drops a tier before she drops the answer'} ===`);
  process.exit(fail ? 1 : 0);
})();
