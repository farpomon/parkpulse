// ParkPulse Consultant — AI advisor for Lightning Lane (Disney) and
// Express Pass (Universal) decisions, grounded in the app's live wait data.
// Requires ANTHROPIC_API_KEY; the feature is hidden when unset.

const Anthropic = require('@anthropic-ai/sdk');

const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const enabled = () => Boolean(client);

const MODEL = 'claude-opus-5';

// Stable knowledge base — cached via cache_control so repeat questions only
// pay for the volatile live-data block. Keep this byte-stable: no dates,
// no interpolation.
const SYSTEM = `You are the ParkPulse Consultant, a friendly, sharp theme-park strategy advisor inside the ParkPulse app. Users are standing in a park (or planning a trip) and want fast, confident, personalized advice about paid line-skipping: whether to buy, which product, and how to squeeze the most from it. You are on the visitor's side — your job is to save them money and time, not to sell passes.

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

ADVICE STYLE:
- Use the live wait data provided in the conversation. If today's waits are short, say so and tell them to keep their money. Recommending "don't buy" builds trust.
- Be concrete: name rides, name times, name dollar amounts and the per-person math for their party size. Ask party size if it matters and they haven't said.
- Keep answers tight: a recommendation first, then the 2-4 supporting points. No headers, no bullet walls unless comparing options.
- Prices float daily. Present ranges as ranges, and tell users to confirm the exact price in the My Disney Experience or Universal app before buying.
- If asked about something outside theme parks, gently steer back — you're a parks consultant.
- Never invent wait times, prices, or availability beyond the ranges above and the live data given to you.`;

// Per-user throttle: 30 consultant messages per 6 hours.
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

function liveContext(park, waits) {
  const rides = waits.rides
    .map((r) => `- ${r.name}: ${r.open ? `${r.wait} min${r.typical != null ? ` (typical ${r.typical})` : ''}` : 'closed'}`)
    .join('\n');
  const show = park.show ? `Tonight's show: ${park.show.name} around ${park.show.hour}:00 park time.` : 'No headline evening show at this park.';
  return `<live_data>
Park: ${park.name} (${park.group})
Typical hours: ${park.open}:00-${park.close}:00 local time.
${show}
Wait data source: ${waits.source === 'live' ? 'live, updated within the last few minutes' : 'TYPICAL-DAY ESTIMATES ONLY (live feed unavailable) — caveat your advice accordingly'}
Current standby waits:
${rides}
</live_data>`;
}

// Returns the assistant's reply text.
async function consult({ park, waits, messages }) {
  const clean = validateMessages(messages);
  if (!clean) {
    const err = new Error('invalid messages');
    err.code = 'bad_request';
    throw err;
  }
  // Prepend the volatile live data to the final user turn so the stable
  // system prompt stays cacheable and roles keep alternating.
  const last = clean[clean.length - 1];
  const finalMessages = [
    ...clean.slice(0, -1),
    { role: 'user', content: `${liveContext(park, waits)}\n\n${last.content}` },
  ];

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 1500,
    output_config: { effort: 'medium' },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: finalMessages,
  });

  if (response.stop_reason === 'refusal') {
    return "I'll pass on that one — but ask me anything about beating the lines and I'm all yours! 🎢";
  }
  return response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

module.exports = { enabled, consult, throttled };
