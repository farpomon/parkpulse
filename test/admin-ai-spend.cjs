// The AI spend card on /admin.
//
// The daily email already reported this, but the dashboard is where you look
// when you did not like what the email said -- and until now it was the one
// number the dashboard did not carry. This drives the card the way an admin
// meets it: signed in, against a database with real usage rows in it, and
// again against one with none.
process.env.ANTHROPIC_API_KEY = 'stub';
process.env.DB_FILE = '/tmp/pp-adminai.db';
process.env.PORT = '9691';
process.env.PASS_SECRET = 'testsecret';

const crypto = require('node:crypto');
const fs = require('node:fs');
for (const f of [process.env.DB_FILE, process.env.DB_FILE + '-wal', process.env.DB_FILE + '-shm']) fs.rmSync(f, { force: true });

let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };

const consultant = require('../consultant.js');
let aiMode = 'ok';                       // steered per case below
let asked = null;                        // the model the probe actually asked for
consultant._setClient({ beta: { messages: { create: async (args) => {
  asked = args.model;
  if (aiMode === 'ok') return { model: args.model, stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 9, output_tokens: 2 } };
  const e = new Error(aiMode === 'key' ? 'invalid x-api-key'
    : aiMode === 'credit' ? 'your credit balance is too low'
    : aiMode === 'tier' ? `model: ${args.model} not found` : 'upstream exploded');
  e.status = aiMode === 'key' ? 401 : aiMode === 'credit' ? 400 : aiMode === 'tier' ? 404 : 503;
  throw e;
} } } });
const db = require('../db.js');

const B = 'http://127.0.0.1:9691';
const ADMIN = 'lfaria@mabenconsulting.ca';   // the built-in ADMIN_EMAILS default

// A signed session for the admin, minted the way the server would.
function adminSession() {
  const sid = crypto.randomBytes(16).toString('hex');
  db.sessions.create(sid, ADMIN, 'test-device', 'test');
  const body = Buffer.from(JSON.stringify({ sid, email: ADMIN, exp: Date.now() + 86400000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.PASS_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

// Yesterday and today in Eastern, which is the calendar the report uses.
const etDay = (back = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })
  .format(new Date(Date.now() - back * 86400000));

(async () => {
  require('../server.js');
  for (let i = 0; i < 60 && !(await fetch(`${B}/api/config`).then((r) => r.ok).catch(() => false)); i++) {
    await new Promise((r) => setTimeout(r, 200));
  }

  const salt = crypto.randomBytes(16).toString('hex');
  db.users.create(ADMIN, salt, 'x', 1);
  db.users.markVerified(ADMIN);
  const session = adminSession();
  const get = (p) => fetch(B + p, { headers: { 'x-session': session } });

  console.log('\n[the endpoint the card reads]');
  {
    const anon = await fetch(`${B}/api/admin/ai-cost`);
    check('it is closed to anyone without an admin session', anon.status === 403, String(anon.status));

    const empty = await (await get('/api/admin/ai-cost')).json();
    check('a database with no AI calls still answers', typeof empty.today?.cost_usd === 'number', JSON.stringify(empty).slice(0, 90));
    check('and reports nothing spent rather than nothing at all', empty.month.cost_usd === 0, String(empty.month.cost_usd));
    check('with no cache share to claim', empty.month.cache_share === null, String(empty.month.cache_share));
    check('it names the address the daily report goes to', typeof empty.recipient === 'string', String(empty.recipient));
  }

  console.log('\n[with usage on the books]');
  {
    // Two features, two days: enough for every section of the card to have
    // something to draw, including the cached/one-off distinction.
    for (const day of [etDay(0), etDay(1)]) {
      db.aiusage.add(day, 'advisor', 'claude-opus-5', { input: 10000, output: 900, cacheWrite: 2000, cacheRead: 8000, cost: 0.5 });
      // The real name, from CACHED_FEATURES. It carries nothing in the string
      // to say it is a catalogue job, which is exactly why the dashboard has
      // to be told rather than left to guess.
      db.aiusage.add(day, 'ride-tags', 'claude-sonnet-5', { input: 4000, output: 200, cacheWrite: 0, cacheRead: 1000, cost: 0.02 });
    }
    const r = await (await get('/api/admin/ai-cost')).json();
    check('today is counted', r.today.cost_usd > 0.5, String(r.today.cost_usd));
    check('the month sees both days', r.month.cost_usd > r.today.cost_usd, `${r.month.cost_usd} vs ${r.today.cost_usd}`);
    check('the features come back biggest first', r.features[0]?.feature === 'advisor', JSON.stringify(r.features));
    // The catalogue jobs are written once per park and never charged again, so
    // they must not inflate what one more visitor is said to cost.
    check('the cached job is kept out of the running cost', r.month.running_usd < r.month.cost_usd,
      `running ${r.month.running_usd} of ${r.month.cost_usd}`);
    check('a cache share is reported', r.month.cache_share > 0 && r.month.cache_share < 1, String(r.month.cache_share));
    // The dashboard marks these rows "cached, one-off". It cannot work the
    // list out from the names, so the endpoint has to hand it over.
    check('the endpoint names which features are catalogue jobs',
      Array.isArray(r.cachedFeatures) && r.cachedFeatures.includes('ride-tags'), JSON.stringify(r.cachedFeatures));
    check('and the advisor is not one of them', !r.cachedFeatures.includes('advisor'), JSON.stringify(r.cachedFeatures));
    check('there is a day series to chart', r.days.length >= 2, JSON.stringify(r.days));
    check('and every day in it is on or before the report day', r.days.every((d) => d.day <= r.day), `${JSON.stringify(r.days)} vs ${r.day}`);
  }

  console.log('\n[the card is on the page]');
  {
    // Not a browser test: the markup and the code that fills it are what would
    // silently go missing, and both are visible in the served HTML.
    const html = await (await fetch(`${B}/admin`)).text();
    check('the card is in the markup', html.includes('id="ai-card"'), 'no #ai-card');
    for (const id of ['ai-tiles', 'ai-feat', 'ai-chart', 'ai-note', 'ai-send']) {
      check(`  it has its ${id}`, html.includes(`id="${id}"`), id);
    }
    check('and something asks the endpoint for the numbers', html.includes('/api/admin/ai-cost'), 'no fetch');
    check('the cached marker reads the served list, not the feature name',
      html.includes('cachedFeatures.has(') && !html.includes('CACHED_HINT'), 'still guessing from the name');
    // The bug this catches: building the 14 days from the reader's own clock
    // drew a chart ending on their tomorrow for anyone east of New York.
    check('the chart is anchored on the report day, not the browser clock',
      !/for \(let i = 13; i >= 0; i--\) \{\s*const day = new Date\(Date\.now\(\)/.test(html), 'Date.now() drives the AI chart');
  }

  console.log('\n[whether Mila can actually answer]');
  {
    // Every other signal is indirect: a key being SET is not a key being
    // accepted, and an empty error log is not a working advisor. So the
    // dashboard asks the model, and reports what came back.
    const server = require('../server.js');
    const ops = () => fetch(B + '/api/admin/ops', { headers: { 'x-session': session } }).then((r) => r.json());

    aiMode = 'ok'; server._clearMilaPingCache();
    let m = (await ops()).mila;
    check('a working model reports answering', m.ok === true, JSON.stringify(m));
    // The probe has to ask on the tier the ADVISOR speaks on. Model access is
    // granted per model, so a key can hold the catalogue tier and not this
    // one: probe the cheap tier and the dashboard goes green while every real
    // question a visitor asks fails. That is the exact blindness this panel
    // exists to end, so it is worth a standing test.
    check('it asks on the tier Mila herself answers on', asked === 'claude-opus-5', String(asked));
    check('and names the model that answered', /opus/.test(m.model || ''), String(m.model));
    check('with today\'s spend against the cap', typeof m.spentToday === 'number' && m.dailyCap > 0, JSON.stringify({ s: m.spentToday, c: m.dailyCap }));

    // The three failures that look identical to a reader and are not:
    // a revoked key, an empty balance, and an upstream that fell over.
    aiMode = 'key'; server._clearMilaPingCache();
    m = (await ops()).mila;
    check('a rejected key is named as such', m.ok === false && m.reason === 'key rejected', JSON.stringify(m));

    aiMode = 'credit'; server._clearMilaPingCache();
    m = (await ops()).mila;
    check('an empty balance is told apart from it', m.ok === false && m.reason === 'out of credit', JSON.stringify(m));

    aiMode = 'down'; server._clearMilaPingCache();
    m = (await ops()).mila;
    check('and an upstream failure from both', m.ok === false && m.reason === 'upstream down', JSON.stringify(m));

    // A valid key that is simply not allowed this tier. It comes back as "not
    // found", which reads like our bug and is not -- it is a permission, and
    // it is fixed in the Anthropic console, so it gets named on its own.
    aiMode = 'tier'; server._clearMilaPingCache();
    m = (await ops()).mila;
    check('a key without access to her tier is named', m.ok === false && m.reason === 'model unavailable', JSON.stringify(m));

    // Asking costs money, so it is billed like anything else -- a health check
    // that hid its own cost would be lying in the one report meant to show costs.
    aiMode = 'ok'; server._clearMilaPingCache();
    await ops();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
    const feats = db.aiusage.byFeature(today, today).map((r) => r.feature);
    check('the probe bills itself like any other call', feats.includes('health-ping'), JSON.stringify(feats));

    // Answering, but a tier down. The probe above can pass while this is true
    // -- a tier that fails intermittently answers an eight-token ping and
    // drops a real conversation -- so it is its own line, not a shade of green.
    aiMode = 'ok'; server._clearMilaPingCache();
    m = (await ops()).mila;
    check('no fallback is claimed when there has not been one', !m.fallback, JSON.stringify(m.fallback));
    server._noteFallbackForTest('claude-opus-5', 'claude-sonnet-5', 404, 'model not found');
    server._clearMilaPingCache();
    m = (await ops()).mila;
    check('a tier drop is reported even though she is answering',
      m.ok === true && m.fallback && m.fallback.to === 'claude-sonnet-5' && m.fallback.status === 404,
      JSON.stringify(m.fallback));
  }

  console.log(`\n=== ${fail ? fail + ' failed' : 'the dashboard says what the AI costs'} ===`);
  process.exit(fail ? 1 : 0);
})();
