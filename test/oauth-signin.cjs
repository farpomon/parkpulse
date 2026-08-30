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

  console.log(fail ? `\n=== ${fail} failures ===` : '\n=== they sign in, and only as themselves ===');
  provider.close();
  process.exit(fail ? 1 : 0);
})();
