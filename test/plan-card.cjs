// She wrote out a day and told the reader they could load it, and no card
// appeared. This drives the real agent loop with a scripted model so each way
// that can happen is exercised, and counts the turns each one costs.
process.env.ANTHROPIC_API_KEY = 'stub';
const c = require('../consultant.js');
let fail = 0;
const check = (l, cond, d) => { if (!cond) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };

const RIDES = ['Seven Dwarfs Mine Train', 'Space Mountain', 'TRON Lightcycle Run', 'Haunted Mansion', 'Jungle Cruise', 'Peter Pan’s Flight'];
const waits = { rides: RIDES.map((n, i) => ({ name: n, land: 'Fantasyland', wait: 20 + i * 10, open: true, typical: 30 })), source: 'live', closures: [], events: [] };
const park = { slug: 'magic-kingdom', name: 'Magic Kingdom', group: 'Walt Disney World', tz: 'America/New_York', open: 9, close: 22 };
c.init({ registry: [{ slug: 'magic-kingdom', name: 'Magic Kingdom', group: 'WDW' }], parks: { 'magic-kingdom': park }, recordUsage() {}, getWaits: async () => waits, tagsFor: () => null, createAlert() {}, saveMemory() {} });

// `script` is one entry per model turn: text, or a propose_plan call.
function drive(script) {
  const turns = [];
  c._setClient({ beta: { messages: { stream(args) {
    const step = script[turns.length] || { text: 'nothing left to say' };
    turns.push(JSON.stringify(args.messages[args.messages.length - 1].content).slice(0, 160));
    const content = step.plan
      ? [{ type: 'tool_use', id: 't' + turns.length, name: 'propose_plan', input: { park: 'magic-kingdom', rides: step.plan } }]
      : [{ type: 'text', text: step.text }];
    return {
      async *[Symbol.asyncIterator]() { if (!step.plan) yield { type: 'content_block_delta', delta: { type: 'text_delta', text: step.text } }; },
      finalMessage: async () => ({ model: 'claude-opus-5', stop_reason: step.plan ? 'tool_use' : 'end_turn', content, usage: {} }),
    };
  } } } });
  return turns;
}
async function run(script, over = {}) {
  const turns = drive(script);
  const events = [];
  await c.consult({
    park, waits, messages: [{ role: 'user', content: 'Plan my day at Magic Kingdom please.' }],
    favorites: [], excluded: [], planPicks: [], done: [], profile: null, email: null, memory: null,
    lang: 'English', trip: null, name: null, send: (e, d) => events.push({ e, d }), ...over,
  });
  return {
    turns: turns.length,
    text: events.filter((x) => x.e === 'delta').map((x) => x.d.text).join(''),
    cards: events.filter((x) => x.e === 'action' && x.d.type === 'plan').map((x) => x.d),
    prompts: turns,
  };
}

const ORDER = "Start with Seven Dwarfs Mine Train at rope drop, then Peter Pan’s Flight, Haunted Mansion after lunch, Jungle Cruise in the heat, and keep Space Mountain and TRON Lightcycle Run for the evening. It's one tap away if you want it.";

(async () => {
  console.log('\n[she writes out a day and never calls the tool]');
  {
    // Turn 1 is the prose order; turn 2 is her answering the nudge with the
    // call she should have made in the first place.
    const r = await run([{ text: ORDER }, { plan: ['Seven Dwarfs Mine Train', 'Peter Pan’s Flight', 'Haunted Mansion', 'Space Mountain'] }]);
    check('a card is sent anyway', r.cards.length === 1, JSON.stringify(r.cards));
    check('it carries the order she actually wrote', r.cards[0]?.rides.length >= 3, JSON.stringify(r.cards[0]?.rides));
    check('the repair cost exactly one extra turn', r.turns === 3, `${r.turns} turns`);
    check('and the reader sees her answer, not the repair', r.text === ORDER, JSON.stringify(r.text.slice(-60)));
    console.log(`      nudge: ${r.prompts[1].slice(0, 120)}…`);
  }

  console.log('\n[she called it, but the names missed the feed and she gave up]');
  {
    const r = await run([
      { plan: ['Somethign That Isnt Real', 'Also Not Real'] }, // the feed rejects both
      { text: ORDER },                                          // she writes it out instead
      { plan: ['Seven Dwarfs Mine Train', 'Haunted Mansion', 'Space Mountain'] }, // and the nudge gets it back
    ]);
    check('the second attempt lands a card', r.cards.length === 1, JSON.stringify(r.cards.map((x) => x.rides)));
    check('the reader still sees only her answer', r.text === ORDER, JSON.stringify(r.text.slice(-40)));
    check('at a cost of one extra turn', r.turns === 4, `${r.turns} turns`);
  }

  console.log('\n[she got it right the first time]');
  {
    const r = await run([{ plan: ['Seven Dwarfs Mine Train', 'Space Mountain'] }, { text: 'Here you go — take it or leave it.' }]);
    check('one card', r.cards.length === 1);
    check('and no repair turn is bought', r.turns === 2, `${r.turns} turns`);
  }

  console.log('\n[a reply that was never a plan]');
  {
    const r = await run([{ text: 'Space Mountain is rougher than TRON Lightcycle Run, and Haunted Mansion is the gentlest of the three.' }, { text: 'SKIP' }]);
    check('she is asked, since three rides were named', r.turns === 2, `${r.turns} turns`);
    check('no card is invented', r.cards.length === 0, JSON.stringify(r.cards));
    check('and SKIP never reaches the reader', !/SKIP/.test(r.text), JSON.stringify(r.text));
  }

  console.log('\n[a short answer about one ride]');
  {
    const r = await run([{ text: 'Space Mountain is worth it before 10am, not after.' }]);
    check('nothing is repaired', r.turns === 1, `${r.turns} turns`);
    check('and no card appears', r.cards.length === 0);
  }

  console.log('\n[the plan panel, where leaving the order alone is a real answer]');
  {
    const r = await run([{ text: ORDER }], { cardExpected: false });
    check('no repair turn is bought there', r.turns === 1, `${r.turns} turns`);
    check('and her review is untouched', r.text === ORDER);
  }

  console.log(fail ? `\n=== ${fail} failures ===` : '\n=== the card follows the offer ===');
  process.exit(fail ? 1 : 0);
})();
