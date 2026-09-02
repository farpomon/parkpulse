// Posts real alerts at a local server that enforces the rules Discord's webhook
// endpoint enforces, so a payload that would 400 in production fails here first.
//
//   npm run test:discord
//
// The rules below are from Discord's documented webhook-execute constraints,
// not a live capture. They cover the ways this project's payloads could be
// wrong; they are not a complete model of the endpoint.

import { createServer } from 'node:http';
import { notifyAll, buildMessage } from '../src/notify.mjs';

const received = [];

// Discord rejects: no content and no embeds; content over 2000; embed title
// over 256; embed description over 4096; more than 10 embeds; a non-integer or
// out-of-range colour. It returns 204 with an empty body on success.
function validate(payload) {
  const hasContent = typeof payload.content === 'string' && payload.content.length > 0;
  const embeds = payload.embeds || [];

  if (!hasContent && embeds.length === 0) return 'must contain content or embeds';
  if (hasContent && payload.content.length > 2000) return 'content over 2000 chars';
  if (embeds.length > 10) return 'more than 10 embeds';
  if ('content' in payload && payload.content !== undefined && !hasContent) {
    return 'content present but empty';
  }

  for (const embed of embeds) {
    if (embed.title && embed.title.length > 256) return 'embed title over 256 chars';
    if (embed.description && embed.description.length > 4096) return 'embed description over 4096';
    if (embed.color !== undefined) {
      if (!Number.isInteger(embed.color)) return 'embed colour not an integer';
      if (embed.color < 0 || embed.color > 0xffffff) return 'embed colour out of range';
    }
    if (embed.url !== undefined && !/^https?:\/\//.test(embed.url)) return 'embed url not http(s)';
    if (embed.timestamp && Number.isNaN(Date.parse(embed.timestamp))) {
      return 'embed timestamp not ISO8601';
    }
  }
  return null;
}

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    // Lets one case below exercise the failure path deliberately.
    if (req.url.includes('/reject')) {
      res.writeHead(500).end('server said no');
      return;
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      res.writeHead(400).end('invalid JSON');
      return;
    }
    // JSON.stringify drops undefined keys, which is what lets `content:
    // undefined` mean "no ping" rather than "empty message".
    const problem = validate(payload);
    received.push({ payload, problem });
    if (problem) res.writeHead(400).end(problem);
    else res.writeHead(204).end();
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/api/webhooks/1/token`;

const results = [];
const check = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
};

const logger = { info: () => {}, warn: () => {}, ok: () => {}, error: () => {} };
const cfg = (extra = {}) => ({
  baseUrl: 'https://prenotami.esteri.it',
  serviceLabel: "carta d'identità",
  notify: { discordWebhookUrl: url, discordMention: null, ...extra },
});

async function send(config, result) {
  received.length = 0;
  const sent = await notifyAll(config, logger, buildMessage(config, result));
  return { sent, last: received.at(-1) };
}

// Every outcome the monitor can report has to survive the round trip.
for (const outcome of ['available', 'booked', 'uncertain', 'skipped', 'needs-human', 'dry-run', 'blocked', 'challenge', 'error']) {
  const { sent, last } = await send(cfg(), {
    outcome,
    chosen: '2026-11-30',
    timeSlot: '09:30',
    bookingUrl: 'https://prenotami.esteri.it/Services/Booking/42',
    detail: 'detail text',
    consents: ['I accept the privacy policy'],
  });
  const ok = sent.every((r) => r.ok) && last && !last.problem;
  check(`Discord accepts a "${outcome}" alert`, ok, last?.problem || '');
}

// A mention should ping only when it is worth waking someone for.
let r = await send(cfg({ discordMention: '@here' }), { outcome: 'available', bookingUrl: 'https://x/1' });
check('high priority pings when a mention is set', r.last?.payload.content === '@here');

r = await send(cfg({ discordMention: '@here' }), { outcome: 'error', detail: 'x', bookingUrl: 'https://x/1' });
check('routine alerts do not ping', r.last?.payload.content === undefined, JSON.stringify(r.last?.payload.content));

r = await send(cfg(), { outcome: 'available', bookingUrl: 'https://x/1' });
check('no mention configured means no content field', r.last?.payload.content === undefined);
check('the embed links to the booking page', r.last?.payload.embeds[0].url === 'https://x/1');

// The long-body case: consent text and page excerpts are unbounded input.
r = await send(cfg(), {
  outcome: 'uncertain',
  chosen: '2026-11-30',
  detail: 'x'.repeat(9000),
  bookingUrl: 'https://x/1',
});
check('an over-long body is truncated, not rejected', r.sent.every((s) => s.ok) && !r.last.problem, r.last?.problem || '');

// A failing channel must not be reported as delivered.
r = await send(cfg({ discordWebhookUrl: `http://127.0.0.1:${server.address().port}/reject` }), {
  outcome: 'available',
  bookingUrl: 'https://x/1',
});
check(
  'a rejected post is reported as failed, not delivered',
  r.sent.some((s) => s.channel === 'discord' && !s.ok),
  JSON.stringify(r.sent)
);

server.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
