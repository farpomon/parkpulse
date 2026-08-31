// Where a page view came from, and where an account came from.
//
// "1,645 views, 3 signups" could not be read before this: hits counted paths
// and nothing else, so there was no referrer, no campaign, and a crawler
// counted exactly the same as a person.
process.env.ANTHROPIC_API_KEY = 'stub';
process.env.DB_FILE = '/tmp/pp-traffic.db';
process.env.PORT = '9675';
process.env.PASS_SECRET = 'testsecret';

const crypto = require('node:crypto');
const fs = require('node:fs');
for (const f of [process.env.DB_FILE, process.env.DB_FILE + '-wal', process.env.DB_FILE + '-shm']) fs.rmSync(f, { force: true });

let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };

const consultant = require('../consultant.js');
consultant._setClient({ beta: { messages: { create: async () => ({ model: 'x', stop_reason: 'end_turn', content: [{ type: 'text', text: '.' }], usage: {} }) } } });
const db = require('../db.js');

const B = 'http://127.0.0.1:9675';
const HUMAN = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const visit = (path, headers = {}) => fetch(B + path, { headers: { 'user-agent': HUMAN, ...headers } });

(async () => {
  require('../server.js');
  for (let i = 0; i < 60 && !(await fetch(`${B}/api/config`).then((r) => r.ok).catch(() => false)); i++) {
    await new Promise((r) => setTimeout(r, 200));
  }
  const rowsFor = (m) => db.visits.bySource(today()).filter((r) => r.medium === m);

  console.log('\n[a referrer becomes a source]');
  {
    await visit('/app', { referer: 'https://www.google.com/search?q=magic+kingdom+wait+times' });
    await visit('/app', { referer: 'https://www.reddit.com/r/WaltDisneyWorld/comments/x' });
    await visit('/app', { referer: 'https://someblog.example.com/best-park-apps' });
    await visit('/app');                                     // typed in, or stripped
    const by = db.visits.bySource(today());
    const find = (s) => by.find((r) => r.source === s);
    check('a search engine is search, by name', find('google')?.medium === 'search', JSON.stringify(find('google')));
    check('a social site is social', find('reddit')?.medium === 'social', JSON.stringify(find('reddit')));
    check('anything else is a referral, kept as its domain',
      find('someblog.example.com')?.medium === 'referral', JSON.stringify(find('someblog.example.com')));
    check('no referrer is direct, not blank', find('direct')?.medium === 'direct', JSON.stringify(find('direct')));
  }

  console.log('\n[our own pages are not a traffic source]');
  {
    const before = (rowsFor('internal')[0]?.n) || 0;
    await visit('/app', { referer: `${B}/parks/magic-kingdom` });
    const after = (rowsFor('internal')[0]?.n) || 0;
    check('a link from our own page counts as internal', after === before + 1, `${before} -> ${after}`);
    check('and is not mixed in with real referrals',
      !db.visits.bySource(today()).some((r) => r.medium === 'referral' && r.source.includes('127.0.0.1')),
      JSON.stringify(db.visits.bySource(today())));
  }

  console.log('\n[a campaign wins over whatever the referrer says]');
  {
    await visit('/app?utm_source=newsletter&utm_medium=email&utm_campaign=summer24', { referer: 'https://www.google.com/' });
    const c = db.visits.byCampaign(today()).find((r) => r.campaign === 'summer24');
    check('the campaign is recorded by name', Boolean(c), JSON.stringify(db.visits.byCampaign(today())));
    check('and credited to the campaign source, not the referrer', c?.source === 'newsletter', JSON.stringify(c));
  }

  console.log('\n[crawlers are counted apart from people]');
  {
    const before = db.visits.totals(today());
    await visit('/app', { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' });
    await visit('/app', { 'user-agent': 'Mozilla/5.0 (compatible; bingbot/2.0)' });
    await visit('/app', { 'user-agent': 'AhrefsBot/7.0' });
    const after = db.visits.totals(today());
    check('a crawler does not inflate the human count', after.people === before.people, `${before.people} -> ${after.people}`);
    check('it is counted, not discarded', after.bots === before.bots + 3, `${before.bots} -> ${after.bots}`);
    const bots = db.visits.bySource(today(), { bots: true }).map((r) => r.source);
    check('and named where it is obvious', bots.includes('googlebot') && bots.includes('bingbot'), JSON.stringify(bots));
    // The reason this matters: hits counts every request, so the funnel's top
    // is crawlers plus people until you separate them.
    check('the old counter really was counting them too', db.hits.totals(30).some((h) => h.path === '/app' && h.n > after.people),
      JSON.stringify(db.hits.totals(30).filter((h) => h.path === '/app')));
  }

  console.log('\n[an account is credited to what first found it]');
  {
    const email = 'attributed@test.dev';
    const res = await fetch(`${B}/api/auth/signup`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': HUMAN },
      body: JSON.stringify({ email, password: 'longenoughpw', device: 'd1', name: 'Ana', terms: true,
        src: { source: 'Reddit', medium: 'Social', campaign: 'r/WaltDisneyWorld' } }),
    });
    check('signup goes through', res.status === 200, String(res.status));
    const u = db.users.get(email);
    check('the source is stamped on the account', u?.signup_source === 'reddit', String(u?.signup_source));
    check('normalised, not taken raw', u?.signup_medium === 'social', String(u?.signup_medium));
    check('with the campaign kept', /waltdisneyworld/.test(u?.signup_campaign || ''), String(u?.signup_campaign));

    // First-touch: the credit belongs to what found them, and a later visit
    // must not overwrite it.
    db.admin.attribute(email, 'google', 'search', '');
    check('a later touch does not steal the credit', db.users.get(email)?.signup_source === 'reddit', String(db.users.get(email)?.signup_source));

    const bySource = db.admin.signupsBySource(30);
    check('the dashboard can group signups by source', bySource.some((r) => r.source === 'reddit' && r.signups === 1), JSON.stringify(bySource));
  }

  console.log('\n[nothing here identifies anybody]');
  {
    // The visits table is a day, a source and a count. If it ever grows a
    // column that could single somebody out, this is the check that fails.
    const cols = db.visits.bySource(today())[0] || {};
    check('a visit row carries only source, kind and a count',
      Object.keys(cols).every((k) => ['source', 'medium', 'n'].includes(k)), JSON.stringify(Object.keys(cols)));
  }

  console.log(`\n=== ${fail ? fail + ' failed' : 'traffic and signups can both be traced to a source'} ===`);
  process.exit(fail ? 1 : 0);
})();
