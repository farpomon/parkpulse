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

  // Reported with a screenshot. On the PLAN PANEL she wrote out a full
  // reorder in prose -- swap the coasters out of the 39-degree hour, start at
  // Morocco, save the water ride for the heat peak -- and no card came with
  // it, so the reader had no way to take any of it. The panel had been
  // excluded from the repair turn on the theory that a review only critiques
  // an order that already exists. A review that disagrees with Pip IS a
  // proposal, and it is the one screen where the reader is already looking at
  // the order they want changed.
  console.log('\n[the plan panel: she disagrees with Pip and rewrites the day]');
  {
    const r = await run(
      [{ text: ORDER }, { plan: ['Jungle Cruise', 'Haunted Mansion', 'Space Mountain'] }],
      { cardExpected: true, messages: [{ role: 'user', content: 'This is the running order the auto-planner drafted. What would you change?' }] },
    );
    check('her reorder comes with a card to take it', r.cards.length === 1, JSON.stringify(r.cards));
    check('carrying the order she wrote, not Pip\'s', r.cards[0]?.rides.length >= 3, JSON.stringify(r.cards[0]?.rides));
    check('the reader still sees only her review', r.text === ORDER, JSON.stringify(r.text.slice(-50)));
    check('bought with exactly one repair turn', r.turns === 3, `${r.turns} turns`);
  }

  console.log('\n[the plan panel: she agrees with Pip and changes nothing]');
  {
    // The turn the old behaviour was protecting. It still costs one, and the
    // nudge answers SKIP — what must NOT happen is a card inventing a reorder
    // she never proposed.
    const r = await run(
      [{ text: 'Honestly, that order is right. Space Mountain early is the call.' }, { text: 'SKIP' }],
      { cardExpected: true, messages: [{ role: 'user', content: 'This is the running order the auto-planner drafted. What would you change?' }] },
    );
    check('no card is invented when she agreed', r.cards.length === 0, JSON.stringify(r.cards));
    check('and the reader sees her verdict untouched', /that order is right/.test(r.text), JSON.stringify(r.text));
  }

  console.log('\n[the plan panel: she calls the tool herself]');
  {
    const r = await run(
      [{ plan: ['Jungle Cruise', 'Haunted Mansion'] }, { text: 'Swapped the two hot-hour rides.' }],
      { cardExpected: true, messages: [{ role: 'user', content: 'This is the running order the auto-planner drafted. What would you change?' }] },
    );
    check('one card', r.cards.length === 1, JSON.stringify(r.cards));
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

  console.log('\n[nothing may switch the guard off again]');
  {
    // This case used to assert the opposite: that the plan panel bought no
    // repair turn. That is what the bug WAS -- a review that rewrote the whole
    // day arrived as prose with no way to take it. The behaviour is still
    // reachable through the option, so the guard now watches the only caller
    // that matters instead of pinning the shape that lost the card.
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server.js'), 'utf8');
    const calls = [...src.matchAll(/cardExpected:\s*([^,\n]+)/g)].map((m) => m[1].trim());
    check('the server asks for a card on every consult', calls.length > 0 && calls.every((v) => v === 'true'),
      calls.join(' | ') || 'no cardExpected found — did the option get renamed?');
  }

  console.log(fail ? `\n=== ${fail} failures ===` : '\n=== the card follows the offer ===');
  process.exit(fail ? 1 : 0);
})();
