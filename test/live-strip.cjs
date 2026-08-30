// Mila's standing line under the header.
//
// The point of this file is the money: the strip must refresh every twenty
// minutes WITHOUT asking a model, and must ask one only when the day actually
// moved. A regression here is not a wrong pixel, it is a bill.
process.env.ANTHROPIC_API_KEY = 'stub';
process.env.DB_FILE = '/tmp/pp-livestrip.db';
process.env.PORT = '9687';
process.env.PASS_SECRET = 'testsecret';
process.env.LIVE_NUDGE_CAP = '3';          // small, so the ceiling is reachable

const crypto = require('node:crypto');
const fs = require('node:fs');
for (const f of [process.env.DB_FILE, process.env.DB_FILE + '-wal', process.env.DB_FILE + '-shm']) fs.rmSync(f, { force: true });

let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };

const consultant = require('../consultant.js');
let calls = [];
consultant._setClient({
  beta: { messages: {
    create: async (req) => {
      calls.push(req);
      return { model: 'claude-sonnet-5', stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Space Mountain just dropped to 10 minutes — go now, my dears! ✨' }],
        usage: { input_tokens: 700, output_tokens: 30 } };
    },
  } },
});
const db = require('../db.js');

const B = 'http://127.0.0.1:9687';
const EMAIL = 'strip@test.dev';
function session() {
  const sid = crypto.randomBytes(16).toString('hex');
  db.sessions.create(sid, EMAIL, 'dev-1', 'test');
  const body = Buffer.from(JSON.stringify({ sid, email: EMAIL, exp: Date.now() + 86400000 })).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', process.env.PASS_SECRET).update(body).digest('base64url')}`;
}

(async () => {
  require('../server.js');
  for (let i = 0; i < 60 && !(await fetch(`${B}/api/config`).then((r) => r.ok).catch(() => false)); i++) {
    await new Promise((r) => setTimeout(r, 200));
  }
  db.users.create(EMAIL, 's', 'x', 1);
  db.users.markVerified(EMAIL);
  db.users.setName(EMAIL, 'Luis');
  const tok = session();
  const nudge = (body, headers = {}) => fetch(`${B}/api/live-nudge`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-session': tok, ...headers },
    body: JSON.stringify(body),
  });

  console.log('\n[the strip is in the page, and it does not offer a way out]');
  {
    const html = await (await fetch(`${B}/app`)).text();
    check('the strip is in the markup', html.includes('id="mila-live"'), 'no #mila-live');
    check('it has a line to fill', html.includes('id="mila-live-txt"'));
    // "Leave it there static" -- it is not a nudge to dismiss.
    const strip = html.slice(html.indexOf('id="mila-live"'), html.indexOf('id="mila-live"') + 400);
    check('and no dismiss button', !/aria-label="Dismiss"/.test(strip), strip.slice(0, 120));
    check('it refreshes on a twenty-minute timer', /20 \* 60 \* 1000/.test(html), 'no 20-minute interval');
  }

  console.log('\n[a written line costs a call, and only when something moved]');
  {
    calls = [];
    const res = await nudge({ park: 'magic-kingdom', lang: 'en', headline: 'Space Mountain has dropped from 55 to 10 minutes', facts: ['It normally runs about 45 minutes.'] });
    const d = await res.json();
    check('the change comes back as a sentence', res.status === 200 && typeof d.text === 'string' && d.text.length > 10, JSON.stringify(d));
    check('exactly one model call was spent', calls.length === 1, String(calls.length));
    check('on the cheaper catalogue model, not the advisor one', calls[0].model === 'claude-sonnet-5', String(calls[0].model));
    // A long answer here is a long answer on every change, for every visitor.
    check('with the output capped short', calls[0].max_tokens <= 200, String(calls[0].max_tokens));
    const sent = JSON.parse(calls[0].messages[0].content);
    check('the model is told the language to answer in', Boolean(sent.language), JSON.stringify(sent).slice(0, 90));
    check('and is given the change rather than asked to find one', sent.change.includes('Space Mountain'), sent.change);
    check('the whole park wait list is NOT shipped to it', !JSON.stringify(sent).includes('Seven Dwarfs'), JSON.stringify(sent).length + ' chars');
  }

  console.log('\n[nothing to say costs nothing]');
  {
    calls = [];
    const res = await nudge({ park: 'magic-kingdom', lang: 'en', headline: '', facts: [] });
    check('an empty change is refused', res.status === 400, String(res.status));
    check('and buys no model call', calls.length === 0, String(calls.length));
  }

  console.log('\n[the ceiling holds even if the page misbehaves]');
  {
    // LIVE_NUDGE_CAP is 3 for this run. A stuck client asking every twenty
    // seconds instead of every twenty minutes must not be able to bill for it.
    calls = [];
    let ok = 0, blocked = 0;
    for (let i = 0; i < 12; i++) {
      const r = await nudge({ park: 'magic-kingdom', lang: 'en', headline: `Ride ${i} has gone down`, facts: [] });
      if (r.status === 429) blocked++; else ok++;
    }
    check('the account is cut off at the cap', blocked > 0, `${ok} allowed, ${blocked} blocked`);
    check('and no model call happens past it', calls.length === ok, `${calls.length} calls for ${ok} allowed`);
    check('the cap is the configured one', ok <= 3, `${ok} allowed against a cap of 3`);
  }

  console.log('\n[who can ask]');
  {
    const anon = await fetch(`${B}/api/live-nudge`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ park: 'magic-kingdom', headline: 'something moved' }),
    });
    check('a stranger cannot spend our money', anon.status === 401, String(anon.status));
  }

  console.log('\n[every line the strip writes itself is translated]');
  {
    const en = ['First up on the day I planned: {ride} at {t}.', 'Gates open at {t} — I’m getting your day ready. ✨',
      'Park’s shut for the night — rest up, I’ll be here in the morning. ✨', 'Next up: {ride}, {n} min right now.',
      'Next up: {ride} at {t}.', 'Shortest queue right now: {ride}, {n} min.', 'Watching the queues for you ✨',
      'Planning ahead — I’ll watch the queues for you on the day. ✨'];
    const langs = fs.readdirSync('public/i18n').filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));
    const holes = [];
    for (const lang of langs) {
      const d = JSON.parse(fs.readFileSync(`public/i18n/${lang}.json`, 'utf8'));
      for (const k of en) if (!d[k]) holes.push(`${lang}:${k.slice(0, 20)}`);
    }
    check(`all ${en.length} lines exist in all ${langs.length} languages`, holes.length === 0, holes.slice(0, 4).join(' | '));
  }

  console.log(`\n=== ${fail ? fail + ' failed' : 'she speaks up when the day moves, and stays quiet when it does not'} ===`);
  process.exit(fail ? 1 : 0);
})();
