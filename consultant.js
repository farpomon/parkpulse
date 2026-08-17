// ParkPulse Consultant — an agentic advisor for Lightning Lane (Disney) and
// Express Pass (Universal) decisions. Streams replies over SSE and can act:
// fetch live waits for any covered park mid-conversation, set wait-drop
// alerts on the user's device, and propose one-tap ride plans.
// Requires ANTHROPIC_API_KEY; the feature is hidden when unset.

const Anthropic = require('@anthropic-ai/sdk');

let client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const enabled = () => Boolean(process.env.ANTHROPIC_API_KEY);

const MODEL = 'claude-opus-5';
const MAX_TURNS = 6;

// Injected by server.js at boot (registry, live-waits fetcher, alert writer).
let deps = null;
function init(d) { deps = d; }

// Test hook: swap the Anthropic client for a fake.
function _setClient(c) { client = c; }

// --- Knowledge base (stable, prompt-cached) ----------------------------------
// Byte-stable: no dates, no interpolation except the park directory, which is
// built once from the registry at first use and identical across requests.
let SYSTEM_CACHE = null;
function systemPrompt() {
  if (SYSTEM_CACHE) return SYSTEM_CACHE;
  const directory = deps.registry
    .map((p) => `- ${p.slug}: ${p.name} (${p.group})`)
    .join('\n');
  SYSTEM_CACHE = `You are the ParkPulse Consultant, a friendly, sharp theme-park strategy advisor inside the ParkPulse app. Users are standing in a park (or planning a trip) and want fast, confident, personalized advice about paid line-skipping: whether to buy, which product, and how to squeeze the most from it. You are on the visitor's side — your job is to save them money and time, not to sell passes.

Knowledge:

DISNEY (Walt Disney World & Disneyland):
- FastPass is gone (retired 2021). The paid system is Lightning Lane.
- Lightning Lane Multi Pass: book return windows for a set of attractions all day (start with 3, rebook as you redeem). WDW pricing floats daily roughly $15-$45 per person per day — Magic Kingdom priciest, Animal Kingdom cheapest. Excludes the top headliners.
- Lightning Lane Single Pass: one-time paid access to a single excluded headliner (e.g. Rise of the Resistance, Slinky Dog Dash at times), roughly $12-$25 per ride depending on date.
- Lightning Lane Premier Pass: premium one-time entry to every eligible attraction, no return windows; costs several times Multi Pass and sells in limited quantity. Only worth it on the most crowded days or one-day-only trips with deep budgets.
- Booking: WDW resort guests book 7 days before check-in at 7:00 AM ET for their whole stay; off-site guests 3 days out. Sell-out risks: Slinky Dog Dash, Rise of the Resistance, Tiana's Bayou Adventure, Rock 'n' Roller Coaster. After redeeming a selection you can book another.
- Free alternatives: rope drop (first hour), the final operating hour (often the day's shortest waits), and parade/fireworks windows (30-50% wait drops on headliners).
- Rough value math: Multi Pass typically saves 2-4 hours of standing in line on a moderate-to-busy day at Magic Kingdom or Hollywood Studios; it saves least at Animal Kingdom and EPCOT.

UNIVERSAL (Orlando & Hollywood):
- The product is Express Pass, and it works differently from Disney: no return times — flash the pass and enter the Express line whenever.
- Two flavors: Express (one ride each on participating attractions) and Express Unlimited. Bought per park per day; price floats with date, roughly $80-$300 per person. At Universal Hollywood it's a single tier.
- The classic hack: guests of Universal Orlando's premier hotels (Hard Rock, Royal Pacific, Portofino Bay) get FREE Unlimited Express for their whole party, every day of the stay including check-in and check-out day. On busy dates a one-night stay can cost less than buying Express for a family.
- Epic Universe Express access is more limited and sells out; check availability early.
- Free alternatives: single-rider lines (Universal has many good ones), rope drop, and end of night.

PARKS YOU COVER (slug: name):
${directory}

YOUR TOOLS:
- get_waits: live waits, hours, show, and local time for any covered park. Use it whenever the user asks about a park other than the one in their live data, or wants a comparison. Never guess another park's waits.
- set_alert: creates a real wait-drop push alert on the user's device. Use it when they ask to be told when a ride's wait drops. If it fails because notifications are off, tell them to tap the bell icon on the ride instead.
- propose_plan: sends a concrete ride plan to the app with a one-tap Apply button. Use it when you've settled on a set of rides for the park the user is viewing; ride names must exactly match the wait data. Still summarize the plan briefly in words.

ADVICE STYLE:
- Use the live data provided or fetched. If today's waits are short, say so and tell them to keep their money. Recommending "don't buy" builds trust.
- Be concrete: name rides, name times, name dollar amounts and the per-person math for their party size. Ask party size if it matters and they haven't said.
- The user's local park time is in the live data — anchor "rest of the day" advice to it.
- Keep answers tight: a recommendation first, then the 2-4 supporting points. No headers, no bullet walls unless comparing options.
- Prices float daily. Present ranges as ranges, and tell users to confirm the exact price in the My Disney Experience or Universal app before buying.
- If asked about something outside theme parks, gently steer back — you're a parks consultant.
- Never invent wait times, prices, or availability beyond the ranges above and the data your tools return.`;
  return SYSTEM_CACHE;
}

// --- Tools -------------------------------------------------------------------
const TOOL_DEFS = [
  {
    name: 'get_waits',
    description: 'Get current wait times (with typical-wait baselines), park hours, evening show, and current local time for any covered park. Use for any park other than the one in the provided live data, or to compare parks. Input is the park slug from the directory.',
    input_schema: {
      type: 'object',
      properties: { park: { type: 'string', description: "Park slug, e.g. 'epcot' or 'islands-of-adventure'" } },
      required: ['park'],
    },
  },
  {
    name: 'set_alert',
    description: "Create a wait-drop push alert on the user's device: they get a notification when the ride's standby wait drops to or below the threshold. Use when the user asks to be notified about a wait. The ride name must exactly match a name from wait data.",
    input_schema: {
      type: 'object',
      properties: {
        park: { type: 'string', description: 'Park slug' },
        ride: { type: 'string', description: 'Exact ride name from wait data' },
        threshold: { type: 'integer', description: 'Alert when the wait is at or below this many minutes' },
      },
      required: ['park', 'ride', 'threshold'],
    },
  },
  {
    name: 'propose_plan',
    description: "Send a concrete ride plan to the ParkPulse app; the user sees an Apply button that loads it into the plan builder. Only for the park the user is currently viewing. Ride names must exactly match names from that park's wait data.",
    input_schema: {
      type: 'object',
      properties: {
        park: { type: 'string', description: 'Park slug (must be the park the user is viewing)' },
        rides: { type: 'array', items: { type: 'string' }, description: 'Exact ride names, in no particular order' },
      },
      required: ['park', 'rides'],
    },
  },
];

const localTime = (tz) =>
  new Date().toLocaleString('en-US', { timeZone: tz, weekday: 'long', hour: 'numeric', minute: '2-digit' });

function waitsBlock(park, waits) {
  const rides = waits.rides
    .map((r) => `- ${r.name}: ${r.open ? `${r.wait} min${r.typical != null ? ` (typical ${r.typical})` : ''}` : 'closed'}`)
    .join('\n');
  return `Park: ${park.name} (${park.group})
Local time now: ${localTime(park.tz)}
Typical hours: ${park.open}:00-${park.close}:00 local.
${park.show ? `Tonight's show: ${park.show.name} around ${park.show.hour}:00.` : 'No headline evening show.'}
Data: ${waits.source === 'live' ? 'live, updated within minutes' : 'TYPICAL-DAY ESTIMATES (live feed unavailable) — caveat advice accordingly'}
Standby waits:
${rides}`;
}

async function runTool(block, ctx) {
  const input = block.input || {};
  try {
    if (block.name === 'get_waits') {
      const park = deps.parks[input.park];
      if (!park) return { text: `Unknown park slug "${input.park}". Valid slugs are in your park directory.`, isError: true };
      return { text: waitsBlock(park, await deps.getWaits(park.slug)) };
    }
    if (block.name === 'set_alert') {
      const park = deps.parks[input.park];
      const threshold = Math.round(Number(input.threshold));
      if (!park || typeof input.ride !== 'string' || !Number.isFinite(threshold) || threshold < 5 || threshold > 240) {
        return { text: 'Invalid alert parameters (need a valid park slug, exact ride name, and a threshold of 5-240 minutes).', isError: true };
      }
      if (!ctx.subscription) {
        return { text: 'The user has not enabled push notifications on this device, so no alert can be created. Tell them to tap the bell icon next to the ride to enable notifications first.', isError: true };
      }
      deps.createAlert(ctx.subscription, park.slug, input.ride.slice(0, 120), threshold);
      ctx.actions.push({ type: 'alert', park: park.slug, ride: input.ride, threshold });
      return { text: `Alert created: the user will get a push notification when ${input.ride} drops to ${threshold} minutes or less.` };
    }
    if (block.name === 'propose_plan') {
      const park = deps.parks[input.park];
      const rides = Array.isArray(input.rides) ? input.rides.filter((r) => typeof r === 'string').slice(0, 20) : [];
      if (!park || !rides.length) return { text: 'Invalid plan (need a valid park slug and at least one ride name).', isError: true };
      ctx.actions.push({ type: 'plan', park: park.slug, rides });
      return { text: 'Plan sent to the app — the user now sees an Apply button for it. Briefly summarize the plan and the reasoning in your reply.' };
    }
    return { text: `Unknown tool ${block.name}.`, isError: true };
  } catch (err) {
    return { text: `Tool failed: ${err.message}`, isError: true };
  }
}

// --- Request validation ------------------------------------------------------
function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 24) return null;
  const clean = [];
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') return null;
    const content = m.content.trim().slice(0, 2000);
    if (!content) return null;
    clean.push({ role: m.role, content });
  }
  if (clean[clean.length - 1].role !== 'user') return null;
  return clean;
}

function userContextBlock({ favorites, planPicks, subscription }) {
  const favs = Array.isArray(favorites) ? favorites.filter((f) => typeof f === 'string').slice(0, 30) : [];
  const picks = Array.isArray(planPicks) ? planPicks.filter((f) => typeof f === 'string').slice(0, 30) : [];
  const lines = [];
  if (favs.length) lines.push(`Starred favorite rides: ${favs.join(', ')}`);
  if (picks.length) lines.push(`Rides currently checked in their plan builder: ${picks.join(', ')}`);
  lines.push(`Push notifications on this device: ${subscription ? 'enabled (set_alert will work)' : 'not enabled (set_alert will fail)'}`);
  return lines.join('\n');
}

// --- Per-user throttle: 30 consultant messages per 6 hours -------------------
const usage = new Map();
function throttled(key) {
  const now = Date.now();
  const u = usage.get(key);
  if (!u || now > u.resetAt) {
    usage.set(key, { n: 1, resetAt: now + 6 * 3600 * 1000 });
    return false;
  }
  u.n += 1;
  return u.n > 30;
}

// --- The agent loop ----------------------------------------------------------
// `send(event, data)` emits an SSE event. Emits `delta` (streamed text),
// `action` (client-side effects: applied plans / created alerts), and `done`.
async function consult({ park, waits, messages, favorites, planPicks, subscription, send }) {
  const clean = validateMessages(messages);
  if (!clean) {
    const err = new Error('invalid messages');
    err.code = 'bad_request';
    throw err;
  }
  const last = clean[clean.length - 1];
  const convo = [
    ...clean.slice(0, -1),
    {
      role: 'user',
      content: `<live_data>\n${waitsBlock(park, waits)}\n</live_data>\n<user_context>\n${userContextBlock({ favorites, planPicks, subscription })}\n</user_context>\n\n${last.content}`,
    },
  ];
  const ctx = { subscription, actions: [] };

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 2000,
      output_config: { effort: 'medium' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [{ type: 'text', text: systemPrompt(), cache_control: { type: 'ephemeral' } }],
      tools: TOOL_DEFS,
      messages: convo,
    });

    for await (const ev of stream) {
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta' && ev.delta.text) {
        send('delta', { text: ev.delta.text });
      }
    }
    const msg = await stream.finalMessage();

    if (msg.stop_reason === 'refusal') {
      send('delta', { text: "I'll pass on that one — but ask me anything about beating the lines and I'm all yours! 🎢" });
      break;
    }

    convo.push({ role: 'assistant', content: msg.content });

    if (msg.stop_reason === 'tool_use') {
      const results = [];
      for (const block of msg.content) {
        if (block.type !== 'tool_use') continue;
        const r = await runTool(block, ctx);
        results.push({ type: 'tool_result', tool_use_id: block.id, content: r.text, ...(r.isError && { is_error: true }) });
      }
      convo.push({ role: 'user', content: results });
      continue;
    }
    if (msg.stop_reason === 'pause_turn') continue;
    break; // end_turn / max_tokens
  }

  for (const action of ctx.actions) send('action', action);
  send('done', {});
}

module.exports = { enabled, init, consult, throttled, _setClient, _internal: { runTool, waitsBlock, validateMessages } };
