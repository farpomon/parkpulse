// Sign in with Google and with Apple.
//
// Server-side authorization-code flow, deliberately: the app holds a session
// token, not a cookie, and issuing that token here is what keeps the device
// registry and the five-device cap honest. It also keeps Apple's client
// secret -- a JWT this file signs on demand -- off the browser entirely.
//
// No dependencies. Node can verify RS256 and ES256 against a JWK directly,
// which is the only hard part of checking an ID token honestly.
const crypto = require('node:crypto');

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const seg = (obj) => b64url(JSON.stringify(obj));
const unseg = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

// Apple's client secret is a short-lived ES256 JWT signed with the .p8 key
// from the developer portal, not a static string. Regenerated per exchange:
// they are cheap, and a cached one that outlives its exp fails silently at
// the worst moment.
function appleClientSecret() {
  const raw = process.env.APPLE_PRIVATE_KEY || '';
  // Railway and friends deliver multi-line secrets with literal \n.
  const key = crypto.createPrivateKey(raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw);
  const now = Math.floor(Date.now() / 1000);
  const data = `${seg({ alg: 'ES256', kid: process.env.APPLE_KEY_ID })}.${seg({
    iss: process.env.APPLE_TEAM_ID,
    iat: now,
    exp: now + 3000,
    aud: 'https://appleid.apple.com',
    sub: process.env.APPLE_CLIENT_ID,
  })}`;
  // JWS wants the raw r||s pair; Node signs DER unless told otherwise.
  const sig = crypto.sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' });
  return `${data}.${b64url(sig)}`;
}

const PROVIDERS = {
  google: {
    label: 'Google',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    jwks: 'https://www.googleapis.com/oauth2/v3/certs',
    issuers: ['https://accounts.google.com', 'accounts.google.com'],
    scope: 'openid email profile',
    responseMode: null,
    extra: { access_type: 'online', prompt: 'select_account' },
    clientId: () => process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET || '',
    ready: () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
  },
  apple: {
    label: 'Apple',
    authorize: 'https://appleid.apple.com/auth/authorize',
    token: 'https://appleid.apple.com/auth/token',
    jwks: 'https://appleid.apple.com/auth/keys',
    issuers: ['https://appleid.apple.com'],
    scope: 'name email',
    // Asking for name or email makes Apple POST the callback as a form
    // instead of redirecting with a query string.
    responseMode: 'form_post',
    extra: {},
    clientId: () => process.env.APPLE_CLIENT_ID || '',
    clientSecret: appleClientSecret,
    ready: () => Boolean(process.env.APPLE_CLIENT_ID && process.env.APPLE_TEAM_ID
      && process.env.APPLE_KEY_ID && process.env.APPLE_PRIVATE_KEY),
  },
};

// Tests point these at a local fake so the whole round trip can run without
// the internet or a real developer account.
function _setProvider(name, patch) {
  if (!PROVIDERS[name]) throw new Error(`unknown provider ${name}`);
  Object.assign(PROVIDERS[name], patch);
}

const enabled = (name) => Boolean(PROVIDERS[name] && PROVIDERS[name].ready());
const list = () => Object.entries(PROVIDERS).filter(([, p]) => p.ready()).map(([id, p]) => ({ id, label: p.label }));

// --- JWKS --------------------------------------------------------------------
// Cached for an hour, and refetched immediately when a key id is missing:
// both providers rotate, and a rotation must not lock everybody out until
// the cache happens to expire.
const jwksCache = new Map(); // name -> { at, keys }
const JWKS_TTL = 60 * 60 * 1000;

async function fetchJwks(name) {
  const res = await fetch(PROVIDERS[name].jwks, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${name} JWKS ${res.status}`);
  const body = await res.json();
  const keys = Array.isArray(body.keys) ? body.keys : [];
  jwksCache.set(name, { at: Date.now(), keys });
  return keys;
}

async function keyFor(name, kid) {
  const hit = jwksCache.get(name);
  let keys = hit && Date.now() - hit.at < JWKS_TTL ? hit.keys : await fetchJwks(name);
  let jwk = keys.find((k) => k.kid === kid);
  if (!jwk) {
    keys = await fetchJwks(name);           // rotated since we last looked
    jwk = keys.find((k) => k.kid === kid);
  }
  if (!jwk) throw new Error(`${name} has no signing key ${kid}`);
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

// --- ID token ----------------------------------------------------------------
const SKEW = 5 * 60 * 1000; // clocks drift; five minutes either way

async function verifyIdToken(name, token, { nonce }) {
  if (typeof token !== 'string' || token.split('.').length !== 3) throw new Error('malformed id_token');
  const [h, p, s] = token.split('.');
  const head = unseg(h);
  const claims = unseg(p);
  if (head.alg !== 'RS256' && head.alg !== 'ES256') throw new Error(`unexpected alg ${head.alg}`);
  const key = await keyFor(name, head.kid);
  const data = Buffer.from(`${h}.${p}`);
  const sig = Buffer.from(s, 'base64url');
  const ok = head.alg === 'RS256'
    ? crypto.verify('sha256', data, key, sig)
    : crypto.verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig);
  if (!ok) throw new Error('id_token signature does not verify');

  const prov = PROVIDERS[name];
  if (!prov.issuers.includes(claims.iss)) throw new Error(`unexpected issuer ${claims.iss}`);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(prov.clientId())) throw new Error('id_token was not issued for this app');
  if (!(Number(claims.exp) * 1000 > Date.now() - SKEW)) throw new Error('id_token has expired');
  if (claims.iat && Number(claims.iat) * 1000 > Date.now() + SKEW) throw new Error('id_token is from the future');
  // The nonce is what ties this token to the login we started, so a token
  // lifted from somewhere else cannot be replayed into our callback.
  if (nonce && claims.nonce !== nonce) throw new Error('id_token nonce does not match');
  if (!claims.sub) throw new Error('id_token has no subject');
  return claims;
}

// --- Flow --------------------------------------------------------------------
function authorizeUrl(name, { redirectUri, state, nonce }) {
  const p = PROVIDERS[name];
  const q = new URLSearchParams({
    client_id: p.clientId(),
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: p.scope,
    state,
    nonce,
    ...p.extra,
    ...(p.responseMode ? { response_mode: p.responseMode } : {}),
  });
  return `${p.authorize}?${q}`;
}

async function exchange(name, { code, redirectUri }) {
  const p = PROVIDERS[name];
  const res = await fetch(p.token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: p.clientId(),
      client_secret: p.clientSecret(),
    }),
    signal: AbortSignal.timeout(10000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${name} token exchange ${res.status}: ${body.error_description || body.error || 'failed'}`);
  if (!body.id_token) throw new Error(`${name} returned no id_token`);
  return body;
}

// What we actually need out of a login. Apple sends the name once, on the
// very first authorisation, in a separate form field -- never again -- so the
// caller passes it in rather than hoping for it in the token.
function identityFrom(claims, firstNameHint) {
  return {
    subject: String(claims.sub),
    email: typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '',
    // Apple sends the string "true"; Google sends a boolean.
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    name: firstNameHint || (typeof claims.given_name === 'string' ? claims.given_name : ''),
  };
}

module.exports = { PROVIDERS, enabled, list, authorizeUrl, exchange, verifyIdToken, identityFrom, appleClientSecret, _setProvider };
