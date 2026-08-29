// Caching is a prefix match: turn N+1's prompt must begin with turn N's prompt,
// byte for byte, or every marker in the request is a write nobody ever reads.
// Nothing announces that when it breaks -- requests keep succeeding, the bill
// is just higher -- so this asserts the invariant directly against the request
// objects the SDK is handed. Costs nothing to run.
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub'; // a real key is only needed by the live check below
const c = require('../consultant.js');
let fail = 0;
const check = (l, cond, d) => { if (!cond) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };
const tok = (n) => Math.round(n / 3.7);

const rides = Array.from({ length: 45 }, (_, i) => ({
  name: `Attraction ${i + 1}`, land: ['Fantasyland', 'Adventureland'][i % 2],
  wait: 10 + (i % 9) * 10, open: true, typical: 15 + (i % 9) * 10,
}));
const park = { slug: 'magic-kingdom', name: 'Magic Kingdom', group: 'Walt Disney World', tz: 'America/New_York', open: 9, close: 22, show: { name: 'Happily Ever After', hour: 21 } };
// A real Disney park's block, not a bare ride list: the shelter tags, weather,
// closures, events and forecast are most of its bulk, and they are exactly the
// part being bought once per visitor today.
const waits = {
  rides, source: 'live', today: '2026-08-29',
  tags: Object.fromEntries(rides.map((r) => [r.name, { in: 'indoor', hmin: 102, rs: true }])),
  weather: { now: { label: 'Sunny', temp: 32, feels: 38 }, today: { high: 34, low: 25, rainChance: 40, sunset: '19:52' }, wettestHour: { hour: 16, chance: 60 }, days: [] },
  forecast: { basis: 'last 30 days', best: 'Tuesday', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((dow) => ({ dow, label: 'Moderate' })) },
  closures: [{ name: 'Attraction 40', since: '2026-08-01' }],
  events: [{ name: "Mickey's Not-So-Scary Halloween Party", kind: 'hard-ticket', certainty: 'selected', closesEarlyAt: 18, note: 'Check the calendar.' }],
};

let seen = [];
c.init({ registry: [{ slug: 'magic-kingdom', name: 'Magic Kingdom', group: 'WDW' }], recordUsage() {}, getWaits: async () => waits, tagsFor: () => null, createAlert() {}, saveMemory() {} });
c._setClient({ beta: { messages: { stream(args) {
  seen.push(JSON.parse(JSON.stringify(args))); // consult mutates convo afterwards
  return { async *[Symbol.asyncIterator]() {}, finalMessage: async () => ({ model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Reply.' }], usage: {} }) };
} } } });

const ask = (messages, over = {}) => c.consult({
  park, waits, messages, favorites: [], excluded: [], planPicks: ['Attraction 1'], done: [],
  profile: { party: 2, ages: [30, 31], vibes: ['thrill'] }, email: 'a@b.c', memory: null,
  lang: 'English', trip: null, name: 'Luis', send() {}, ...over,
});

// The cacheable prefix of a request, as bytes, with markers removed: a moving
// cache_control marker is not an invalidator and must not count as a diff.
function prefixOf(req, upto) {
  const strip = (v) => JSON.parse(JSON.stringify(v), (k, val) => (k === 'cache_control' ? undefined : val));
  return JSON.stringify([strip(req.tools), strip(req.system), strip(req.messages.slice(0, upto))]);
}
const marked = (req) => req.messages.flatMap((m, i) => (Array.isArray(m.content) ? m.content : [])
  .map((b, j) => (b.cache_control ? { i, j, kind: (b.text || '').slice(0, 11) } : null)).filter(Boolean));

(async () => {
  console.log('\n[a one-shot plan review]');
  seen = [];
  await ask([{ role: 'user', content: 'Here is the running order. Give me your read.' }]);
  const one = seen[0];
  check('the system prompt carries a marker', one.system.some((b) => b.cache_control));
  const m = marked(one);
  console.log(`      markers in messages: ${JSON.stringify(m)}`);
  check('the live park block carries one too', m.some((x) => x.kind.startsWith('<live_data>')), JSON.stringify(m));
  check('nothing is marked after it', m.length === 1, JSON.stringify(m));
  check('and it sits before the question, so every visitor shares it',
    one.messages[0].content[0].text.startsWith('<live_data>'), one.messages[0].content[0].text.slice(0, 20));
  check('the question is still the last thing the model reads',
    one.messages[one.messages.length - 1].content === 'Here is the running order. Give me your read.', JSON.stringify(one.messages[one.messages.length - 1].content).slice(0, 60));
  check('three breakpoints at most, of the four allowed',
    one.system.filter((b) => b.cache_control).length + m.length <= 4);

  console.log('\n[the same conversation, turn after turn]');
  const convo = [{ role: 'user', content: 'Is Lightning Lane worth it today?' }];
  const reqs = [];
  for (let turn = 0; turn < 4; turn++) {
    seen = [];
    await ask([...convo]);
    reqs.push(seen[0]);
    convo.push({ role: 'assistant', content: `Reply number ${turn + 1}, of the length these run to in practice.` });
    convo.push({ role: 'user', content: `Follow-up number ${turn + 2}?` });
  }
  for (let i = 1; i < reqs.length; i++) {
    // Turn i's history is turn i-1's history plus the turn that just happened,
    // so turn i-1's marked prefix must reappear unchanged inside turn i.
    const upto = reqs[i - 1].messages.length - 2; // history only: drop the live block and the question
    check(`turn ${i + 1} still begins with turn ${i}'s cached prefix`,
      prefixOf(reqs[i], upto) === prefixOf(reqs[i - 1], upto),
      `diverges at ${(() => { const a = prefixOf(reqs[i - 1], upto), b = prefixOf(reqs[i], upto); let k = 0; while (k < a.length && a[k] === b[k]) k++; return JSON.stringify(a.slice(Math.max(0, k - 40), k + 40)); })()}`);
  }
  const lastReq = reqs[reqs.length - 1];
  const lm = marked(lastReq);
  console.log(`      markers by turn 4: ${JSON.stringify(lm)}`);
  check('the history carries a marker of its own once there is history', lm.length === 2, JSON.stringify(lm));
  check('and it sits on the last history message',
    lm[0].i === lastReq.messages.length - 3, `${lm[0].i} of ${lastReq.messages.length}`);

  console.log('\n[what this is worth]');
  const sys = tok(lastReq.system.map((b) => b.text).join('').length);
  const tools = tok(JSON.stringify(lastReq.tools).length);
  const hist = tok(lastReq.messages.slice(0, -2).reduce((n, x) => n + JSON.stringify(x.content).length, 0));
  const live = tok(lastReq.messages[lastReq.messages.length - 2].content[0].text.length);
  console.log(`      cacheable now: system ${sys} + tools ${tools} + history ${hist} + live ${live} = ${sys + tools + hist + live} tok`);
  console.log(`      cacheable before this change: ${sys + tools} tok`);
  check('the cacheable prefix grew by the live block and the history', hist + live > 1500, hist + live);

  // The structural check above proves the prefix is stable, which is what
  // caching needs -- but only the API can say the cache was actually read.
  // That costs a few cents, so it runs on request rather than by default.
  if (process.env.PP_LIVE_CACHE_TEST === '1') {
    console.log('\n[live: is the cache actually read]');
    if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY === 'stub') {
      check('a real ANTHROPIC_API_KEY is set', false, 'export one to run this');
    } else {
      const Anthropic = require('@anthropic-ai/sdk');
      const usages = [];
      c.init({ registry: [{ slug: 'magic-kingdom', name: 'Magic Kingdom', group: 'WDW' }], recordUsage: (f, m, u) => usages.push(u), getWaits: async () => waits, tagsFor: () => null, createAlert() {}, saveMemory() {} });
      c._setClient(new Anthropic());
      const q = [{ role: 'user', content: 'In one short sentence: is the wait for Attraction 1 worth it right now?' }];
      await ask(q); await ask(q);
      const [first, second] = usages;
      const show = (u) => `write ${u.cache_creation_input_tokens || 0}, read ${u.cache_read_input_tokens || 0}, fresh ${u.input_tokens || 0}`;
      console.log(`      first:  ${show(first)}\n      second: ${show(second)}`);
      check('the first ask writes the cache', (first.cache_creation_input_tokens || 0) > 0, show(first));
      check('the second reads it back', (second.cache_read_input_tokens || 0) > 0, show(second));
      check('and reads back the whole shared prefix, not a sliver',
        (second.cache_read_input_tokens || 0) >= (first.cache_creation_input_tokens || 0) * 0.9, show(second));
    }
  } else {
    console.log('\n[live check skipped — set PP_LIVE_CACHE_TEST=1 with a real key to spend a few cents on the real thing]');
  }

  console.log(fail ? `\n=== ${fail} failures ===` : '\n=== the prefix holds across turns ===');
  process.exit(fail ? 1 : 0);
})();
