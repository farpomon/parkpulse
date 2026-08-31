// Sign in with Google / Apple, driven end to end against a provider this test
// runs itself: a local OIDC-shaped server with its own RSA key, so the whole
// exchange -- authorize, code, token, JWKS, signature, issuer, audience,
// nonce -- is exercised with no network and no developer account.
//
// The security rules are the point of most of these checks: accounts match on
// the provider's subject and never on the address, and an address only ever
// joins an existing account when the provider says it verified it.
process.env.ANTHROPIC_API_KEY = 'stub';
process.env.DB_FILE = '/tmp/pp-oauth.db';
process.env.PORT = '9693';
process.env.PASS_SECRET = 'testsecret';
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.OAUTH_REDIRECT_BASE = 'http://127.0.0.1:9693';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
for (const f of [process.env.DB_FILE, process.env.DB_FILE + '-wal', process.env.DB_FILE + '-shm']) fs.rmSync(f, { force: true });

let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };

// --- the fake provider -------------------------------------------------------
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-key-1';
const ISS = 'https://accounts.google.com';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
// What the next token will claim. Each case sets this, then drives a login.
let persona = { sub: 'sub-alice', email: 'alice@example.com', email_verified: true, given_name: 'Alice' };
let issued = {};                       // code -> claims

const provider = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://fake');
  if (u.pathname === '/jwks') {
    const jwk = publicKey.export({ format: 'jwk' });
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: 'RS256', use: 'sig' }] }));
  }
  if (u.pathname === '/authorize') {
    // Stand in for the consent screen: mint a code and bounce straight back.
    const code = crypto.randomBytes(8).toString('hex');
    const now = Math.floor(Date.now() / 1000);
    issued[code] = { iss: ISS, aud: 'test-client-id', iat: now, exp: now + 600, nonce: u.searchParams.get('nonce'), ...persona };
    const back = new URL(u.searchParams.get('redirect_uri'));
    back.searchParams.set('code', code);
    back.searchParams.set('state', u.searchParams.get('state'));
    res.writeHead(302, { location: back.toString() });
    return res.end();
  }
  if (u.pathname === '/token') {
    let body = '';
    req.on('data', (c) => { body += c; });
    return req.on('end', () => {
      const form = new URLSearchParams(body);
      const claims = issued[form.get('code')];
      delete issued[form.get('code')];
      if (!claims) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"error":"invalid_grant"}'); }
      const head = b64({ alg: 'RS256', kid: KID, typ: 'JWT' });
      const payload = b64(claims);
      const sig = crypto.sign('sha256', Buffer.from(`${head}.${payload}`), privateKey).toString('base64url');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id_token: `${head}.${payload}.${sig}`, token_type: 'Bearer' }));
    });
  }
  res.writeHead(404); res.end();
});

const consultant = require('../consultant.js');
consultant._setClient({ beta: { messages: { create: async () => ({ model: 'x', stop_reason: 'end_turn', content: [{ type: 'text', text: '.' }], usage: {} }) } } });
const oauth = require('../oauth.js');
const db = require('../db.js');

(async () => {
  await new Promise((r) => provider.listen(9692, r));
  oauth._setProvider('google', {
    authorize: 'http://127.0.0.1:9692/authorize',
    token: 'http://127.0.0.1:9692/token',
    jwks: 'http://127.0.0.1:9692/jwks',
  });
  require('../server.js');
  await new Promise((r) => setTimeout(r, 2500));

  const B = 'http://127.0.0.1:9693';
  // Follows the redirects by hand so every hop can be inspected.
  async function signIn(device = 'dev-1') {
    const start = await fetch(`${B}/api/auth/oauth/google/start?device=${device}`, { redirect: 'manual' });
    if (start.status !== 302) return { stage: 'start', status: start.status };
    const toProvider = await fetch(start.headers.get('location'), { redirect: 'manual' });
    if (toProvider.status !== 302) return { stage: 'authorize', status: toProvider.status };
    const cb = await fetch(toProvider.headers.get('location'), { redirect: 'manual' });
    const loc = cb.headers.get('location') || '';
    const frag = new URLSearchParams(loc.split('#')[1] || '');
    return { stage: 'callback', status: cb.status, code: frag.get('auth'), error: frag.get('autherr') };
  }
  const claim = (code, device = 'dev-1') => fetch(`${B}/api/auth/oauth/claim`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, device }),
  });

  console.log('\n[the app offers what the server can finish]');
  {
    const cfg = await (await fetch(`${B}/api/config`)).json();
    check('a configured provider is advertised', cfg.oauth?.some((p) => p.id === 'google'), JSON.stringify(cfg.oauth));
    check('an unconfigured one is not', !cfg.oauth?.some((p) => p.id === 'apple'), JSON.stringify(cfg.oauth));
    const off = await fetch(`${B}/api/auth/oauth/apple/start?device=d`, { redirect: 'manual' });
    check('and its route is closed', off.status === 404, String(off.status));
  }

  console.log('\n[a first sign-in]');
  {
    const r = await signIn();
    check('the callback came back with a one-time code', Boolean(r.code), JSON.stringify(r));
    check('and no session in the URL', !/session|token/i.test(r.code || ''), r.code);
    const res = await claim(r.code);
    const data = await res.json();
    check('the code buys a session', res.status === 200 && Boolean(data.session), JSON.stringify(data).slice(0, 120));
    check('for the address the provider vouched for', data.email === 'alice@example.com', data.email);
    check('the name came across', data.name === 'Alice', String(data.name));
    // The app asks a brand-new account who is coming; it must be able to tell
    // a sign-up from a sign-in to know when.
    check('and it is flagged as a new account', data.created === true, String(data.created));
    const u = db.users.get('alice@example.com');
    check('the account is verified without an emailed code', u?.verified === 1, JSON.stringify(u && { verified: u.verified }));
    check('and the identity is on file', Boolean(db.identities.get('google', 'sub-alice')));
    const again = await claim(r.code);
    check('the code cannot be spent twice', again.status === 403, String(again.status));
  }

  console.log('\n[coming back]');
  {
    const r = await signIn();
    const data = await (await claim(r.code)).json();
    check('the same person lands on the same account', data.email === 'alice@example.com', data.email);
    check('and is not treated as a new sign-up', data.created === false, String(data.created));
    const rows = db.identities.forEmail('alice@example.com');
    check('and is not linked twice', rows.length === 1, JSON.stringify(rows));
  }

  console.log('\n[the address is not the identity]');
  {
    // Same subject, new address at the provider: still their account.
    persona = { sub: 'sub-alice', email: 'alice.new@example.com', email_verified: true, given_name: 'Alice' };
    const r = await signIn();
    const data = await (await claim(r.code)).json();
    check('a changed email still reaches the original account', data.email === 'alice@example.com', data.email);
    // Different subject that claims the same address: a different person.
    persona = { sub: 'sub-mallory', email: 'alice@example.com', email_verified: true, given_name: 'M' };
    const r2 = await signIn();
    const d2 = await (await claim(r2.code)).json();
    check('a different subject with that address joins it only because the provider verified it', d2.email === 'alice@example.com', d2.email);
    check('  and both identities are on the account', db.identities.forEmail('alice@example.com').length === 1
      || db.identities.get('google', 'sub-mallory')?.email === 'alice@example.com');
  }

  console.log('\n[what the provider will not vouch for]');
  {
    persona = { sub: 'sub-unverified', email: 'nobody@example.com', email_verified: false, given_name: 'N' };
    const r = await signIn();
    check('an unverified address is refused', Boolean(r.error), JSON.stringify(r));
    check('  and says to use a code instead', /code/i.test(r.error || ''), r.error);
    check('  no account was created', !db.users.get('nobody@example.com'));
    persona = { sub: 'sub-noemail', email: '', email_verified: false, given_name: 'X' };
    const r2 = await signIn();
    check('so is an account that shares no address', Boolean(r2.error), JSON.stringify(r2));
  }

  console.log('\n[the token itself]');
  {
    // Everything above trusts verifyIdToken. These poke it directly, because
    // a signature check that never fails is the same as no signature check.
    const now = Math.floor(Date.now() / 1000);
    const mint = (claims, key = privateKey, kid = KID) => {
      const head = b64({ alg: 'RS256', kid, typ: 'JWT' });
      const payload = b64(claims);
      const sig = crypto.sign('sha256', Buffer.from(`${head}.${payload}`), key).toString('base64url');
      return `${head}.${payload}.${sig}`;
    };
    const good = { iss: ISS, aud: 'test-client-id', iat: now, exp: now + 600, nonce: 'N', sub: 's', email: 'e@x.y', email_verified: true };
    const refuses = async (label, token, nonce = 'N') => {
      try { await oauth.verifyIdToken('google', token, { nonce }); check(label, false, 'it was accepted'); }
      catch (err) { check(label, true); return err.message; }
    };
    await oauth.verifyIdToken('google', mint(good), { nonce: 'N' });
    check('a good token verifies', true);

    const t = mint(good).split('.');
    const tampered = `${t[0]}.${b64({ ...good, email: 'attacker@evil.example' })}.${t[2]}`;
    await refuses('a rewritten payload is caught by the signature', tampered);

    const otherKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    await refuses('so is a token signed with somebody else\'s key', mint(good, otherKey));
    await refuses('a token for another app is refused', mint({ ...good, aud: 'some-other-app' }));
    await refuses('so is one from another issuer', mint({ ...good, iss: 'https://evil.example' }));
    await refuses('an expired token is refused', mint({ ...good, exp: now - 3600 }));
    await refuses('and a replayed one, because the nonce will not match', mint({ ...good, nonce: 'from-an-older-login' }));
  }

  console.log('\n[a forged return]');
  {
    const bad = await fetch(`${B}/api/auth/oauth/google/callback?code=whatever&state=not-a-real-state`, { redirect: 'manual' });
    const frag = new URLSearchParams((bad.headers.get('location') || '').split('#')[1] || '');
    check('a callback with no valid state is rejected', Boolean(frag.get('autherr')), bad.headers.get('location'));
    const stolen = await claim('made-up-code');
    check('and an invented claim code buys nothing', stolen.status === 403, String(stolen.status));
  }

  console.log('\n[the code belongs to the device that started it]');
  {
    persona = { sub: 'sub-bob', email: 'bob@example.com', email_verified: true, given_name: 'Bob' };
    const r = await signIn('phone-a');
    const wrong = await claim(r.code, 'phone-b');
    check('another device cannot finish the sign-in', wrong.status === 403, String(wrong.status));
    // The hole this closes: ?device= comes from the caller, so a login started
    // as "unknown" used to skip the check entirely -- finish it with your own
    // Google account, hand the code to somebody else, and their app signs them
    // into yours.
    const anon = await fetch(`${B}/api/auth/oauth/google/start?device=unknown`, { redirect: 'manual' });
    const anonFrag = new URLSearchParams((anon.headers.get('location') || '').split('#')[1] || '');
    check('a login cannot start without a real device', Boolean(anonFrag.get('autherr')), anon.headers.get('location'));
    const blank = await fetch(`${B}/api/auth/oauth/google/start`, { redirect: 'manual' });
    check('nor with none at all', /autherr/.test(blank.headers.get('location') || ''), blank.headers.get('location'));
    const r2 = await signIn('phone-c');
    const noDev = await fetch(`${B}/api/auth/oauth/claim`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: r2.code }),
    });
    check('and a claim with no device is refused', noDev.status === 403, String(noDev.status));
  }

  console.log('\n[names that are not providers]');
  {
    // [a-z]+ in the route matches "constructor", and a plain object answers to
    // it: PROVIDERS.constructor.ready is not a function, which threw inside an
    // async handler and killed the process on an unauthenticated GET.
    for (const name of ['constructor', 'toString', 'hasOwnProperty', 'valueof']) {
      const res = await fetch(`${B}/api/auth/oauth/${name}/start?device=d`, { redirect: 'manual' });
      check(`  /${name} is a 404, not a crash`, res.status === 404, String(res.status));
    }
    const alive = await fetch(`${B}/api/config`);
    check('the server is still up afterwards', alive.ok, String(alive.status));
  }

  console.log('\n[a crafted return]');
  {
    // A valid state costs nothing: start a login and read it out of the
    // redirect. With one in hand, a link could name its own failure message,
    // which the app shows in a toast -- harmless as script, ideal for "call
    // this number". The reader now gets our sentence, not the caller's.
    const start = await fetch(`${B}/api/auth/oauth/google/start?device=dev-1`, { redirect: 'manual' });
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    check('a state is there for the taking', Boolean(state), start.headers.get('location'));
    const evil = 'Your pass has expired. Call 555-0100 to renew.';
    const res = await fetch(`${B}/api/auth/oauth/google/callback?state=${encodeURIComponent(state)}`
      + `&error=access_denied&error_description=${encodeURIComponent(evil)}`, { redirect: 'manual' });
    const frag = new URLSearchParams((res.headers.get('location') || '').split('#')[1] || '');
    check('the reader is told it failed', Boolean(frag.get('autherr')), res.headers.get('location'));
    check('but not in the caller\'s words', !(frag.get('autherr') || '').includes('555-0100'), frag.get('autherr'));
  }

  console.log('\n[a claim that was never issued]');
  {
    // The claim used to be spent by writing an empty value over it. That is an
    // upsert, so posting a code that had never existed CREATED the row -- an
    // unauthenticated write, on an endpoint with no rate limit, that nothing
    // ever cleaned up. 200 junk posts left 200 permanent rows.
    const junk = 'never-issued-' + crypto.randomBytes(6).toString('hex');
    const res = await claim(junk);
    check('a made-up code is refused', res.status === 403, String(res.status));
    check('and leaves no row behind it', db.kv.get(`oauthclaim:${junk}`) === null, JSON.stringify(db.kv.get(`oauthclaim:${junk}`)));

    // Nor should a real one: spending it should remove it, not tombstone it.
    const r = await signIn('dev-tidy');
    const ok = await claim(r.code, 'dev-tidy');
    check('a real sign-in still goes through', ok.status === 200, String(ok.status));
    check('and its code is gone, not blanked', db.kv.get(`oauthclaim:${r.code}`) === null, JSON.stringify(db.kv.get(`oauthclaim:${r.code}`)));
    const again = await claim(r.code, 'dev-tidy');
    check('so it cannot be spent twice', again.status === 403, String(again.status));
  }

  console.log('\n[deleting the account takes the link with it]');
  {
    persona = { sub: 'sub-carol', email: 'carol@example.com', email_verified: true, given_name: 'Carol' };
    const r = await signIn();
    await claim(r.code);
    check('linked before', Boolean(db.identities.get('google', 'sub-carol')));
    db.accounts.purge('carol@example.com');
    check('and gone after', !db.identities.get('google', 'sub-carol'));
  }

  console.log('\n[the terms box is consent, not decoration]');
  {
    const signup = (body) => fetch(`${B}/api/auth/signup`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const pw = { password: 'longenoughpw', device: 'd1', name: 'Ana' };

    // Enforced on the server as well as the page: this endpoint is reachable
    // without the form, and a tick only the browser checks is a rendering
    // choice rather than agreement.
    let r = await signup({ email: 'consent1@example.com', ...pw });
    check('signup without the box is refused', r.status === 400, String(r.status));
    check('and no account is left behind', !db.users.get('consent1@example.com'));

    r = await signup({ email: 'consent1@example.com', ...pw, terms: true });
    check('with the box it goes through', r.status === 200, String(r.status));

    const u = db.users.get('consent1@example.com');
    check('the moment is recorded', Boolean(u.terms_at) && !Number.isNaN(Date.parse(u.terms_at)), String(u.terms_at));
    // A stored "v1" nobody can map back to a wording proves nothing later, so
    // the version is the effective date printed on the Terms themselves.
    check('and which version they agreed to', Boolean(u.terms_version) && u.terms_version !== 'unversioned', String(u.terms_version));
    const termsHtml = require('node:fs').readFileSync(__dirname + '/../public/terms.html', 'utf8');
    check('taken from the Terms page itself', termsHtml.includes('Effective ' + u.terms_version), String(u.terms_version));

    // An unverified signup can be retried; the consent already given is not
    // rewritten to whatever version happens to be current on the retry.
    const first = u.terms_at;
    await new Promise((res) => setTimeout(res, 15));
    await signup({ email: 'consent1@example.com', ...pw, terms: true });
    check('a retry does not overwrite the original consent', db.users.get('consent1@example.com').terms_at === first);

    // Nobody is retro-consented: an account made before the box existed keeps
    // a null, because back-filling agreement nobody gave would be a fiction.
    db.users.create('older@example.com', 's', 'x', 1);
    check('accounts predating the box are not back-filled', db.users.get('older@example.com').terms_at == null,
      String(db.users.get('older@example.com').terms_at));
  }

  console.log(fail ? `\n=== ${fail} failures ===` : '\n=== they sign in, and only as themselves ===');
  provider.close();
  process.exit(fail ? 1 : 0);
})();
