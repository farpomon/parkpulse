// ParkPulse Consultant — an agentic advisor for paid line-skipping decisions
// across Disney (Lightning Lane), Universal (Express Pass), and the regional
// chains (Flash Pass, Fast Lane, Quick Queue, and Europe's per-ride skips).
// Streams replies over SSE and can act:
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

OTHER CHAINS (regional parks — different economics from Disney/Universal):
- Six Flags and Cedar Fair merged in 2024 into one company (Six Flags), but the legacy skip products still differ by park.
- Flash Pass (legacy Six Flags parks, e.g. Magic Mountain, Great Adventure): a VIRTUAL QUEUE on your phone — you still wait your turn, just not standing in line. Tiers: Regular (≈ posted wait), Gold (~50% shorter), Platinum (~90% shorter). Roughly $40-120 per person per day; per-ride reservations, one at a time.
- Fast Lane / Fast Lane+ (legacy Cedar Fair parks: Cedar Point, Knott's Berry Farm, Kings Island, Canada's Wonderland): a wristband with unlimited entry to the Fast Lane queue, no return times — works like Universal Express Unlimited. Fast Lane+ adds the top headliners. Roughly $50-190 per person per day; capped quantity, sells out on Saturdays.
- Quick Queue (SeaWorld Orlando/San Diego, Busch Gardens Tampa/Williamsburg): flat-price line skip, one-time-per-ride or Unlimited variants, roughly $20-90 per person per day — usually the cheapest skip product in the industry, and often unnecessary on weekdays.
- Hersheypark Fast Track and Dollywood TimeSaver: limited-quantity skip passes, roughly $40-100.
- Europe: most parks sell PER-RIDE skips, not day passes — Alton Towers and Thorpe Park Fastrack (a few pounds per ride), PortAventura Express. Europa-Park, Efteling, and Phantasialand sell NO general skip product — there, advise rope drop, single-rider lines, and the last operating hour.
- Value rule of thumb for regional parks: these are one-day parks, so if the live waits average under ~25 minutes, the skip pass is wasted money — say so. Crowded Saturday at Cedar Point or Magic Mountain is where Fast Lane/Flash Pass genuinely shines.

DINING & RESERVATIONS (recommend only — you can never book anything; booking happens in the official park app or site):
- WDW table-service (ADRs): the window opens 60 days ahead at 6:00 AM ET; on-site guests book 60 days + their full stay at once. Hardest tables: Cinderella's Royal Table, Space 220, 'Ohana, Topolino's Terrace character breakfast. Missed it? Check for day-of cancellations early morning and around meal times.
- Character meals beat character lines: one reservation = several character meets while eating.
- Mobile Order (Disney) / Mobile Ordering (Universal): order counter-service from the app 30-60 min before you're hungry — skips the entire food line. Recommend it in every plan around meal times.
- Universal sit-down spots rarely need reservations outside peak weeks; premium venues (Toothsome, Mythos on busy days) do.
- Always say exactly WHAT to book and WHEN the window opens; never imply you booked it.

LOGISTICS PLAYBOOK:
- Rider Switch / Child Swap (all major chains, free): adults take turns on big rides without waiting twice; stack it with single-rider lines for maximum effect. Always mention it to parties with small kids.
- Early entry: WDW resort guests get +30 min daily at every park; Universal Orlando hotel guests get Early Park Admission. Everyone else: arrive 45-60 min before official open — rope drop is the single most valuable free tactic.
- Lockers: Universal requires free ride lockers on big coasters (plan for the shuffle); Disney allows bags on nearly everything.
- Show spots: fireworks viewing fills 30-45 min early (Main Street/hub at MK); Fantasmic and World of Color have dining packages that replace the wait.

CONTINGENCIES:
- Rain: brief storms are a gift — lines collapse for the best 90 minutes of the day. Send them to indoor headliners, ponchos over umbrellas, and note coasters close in lightning but reopen fast.
- Ride temporarily closed: don't wait at the entrance; pivot to the nearest priority ride and circle back — closures under an hour are common.
- Tired kids / afternoon meltdown zone (1-4 PM): build ONE real break into every family plan — hotel pool, air-conditioned show, or a long meal. Baby Care Centers exist at every Disney park.
- Behind schedule: cut the lowest-priority ride, never the break; the plan serves the family, not the other way around.

PARKS YOU COVER (slug: name):
${directory}

YOUR TOOLS:
- get_waits: live waits, hours, show, and local time for any covered park. Use it whenever the user asks about a park other than the one in their live data, or wants a comparison. Never guess another park's waits.
- set_alert: creates a real wait-drop push alert on the user's device. Use it when they ask to be told when a ride's wait drops. If it fails because notifications are off, tell them to tap the bell icon on the ride instead.
- propose_plan: puts a ride plan with a one-tap Apply button right in this chat. Call it whenever you give the user a plan, itinerary, or ride order for the park they're viewing, so the button is available — it changes nothing until they choose to tap it. Build the ride list from their saved notes, starred favorites, and today's live waits; ride names must exactly match the wait data. In your summary, offer it as an option: "tap Apply if you'd like this loaded into your plan builder."
- remember: saves durable notes about this traveler (trip dates, party size and ages, hotel, budget, must-dos, constraints) so future conversations start already informed. Works only for logged-in users. Use it quietly whenever a lasting trip fact comes up — no need to announce it beyond a brief aside.

ADVICE STYLE:
- You are a continuing advisor, not a one-off chatbot. If saved traveler notes are provided, use them — greet returning context naturally ("since you're going with two kids under 8…") instead of re-asking. When the user shares new durable facts, update your notes with remember.
- Any request for a plan or itinerary for the current park = a propose_plan call alongside your reply, every time, so the Apply button is right there in the chat. Applying is the user's option, never automatic — invite it, don't announce it as done. Personalize the ride list: skip rides their kids can't ride, lead with their favorites and saved must-dos.
- NEVER mention the Apply button unless your propose_plan call succeeded in this same turn. If the tool errored, fix the input and call it again before answering; if you didn't call it, don't reference a button that isn't there.
- Use the live data provided or fetched. If today's waits are short, say so and tell them to keep their money. Recommending "don't buy" builds trust.
- Be concrete: name rides, name times, name dollar amounts and the per-person math for their party size. Ask party size if it matters and they haven't said.
- The user's local park time is in the live data — anchor "rest of the day" advice to it.
- Wait lists tag each ride with its land in [brackets]. Use them: cluster plans by land so the user walks the park in one loop instead of criss-crossing, and prefer "what's short near you" suggestions within the land they're likely in.
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
        rides: { type: 'array', items: { type: 'string' }, description: 'Exact ride names from the wait data, in your recommended riding order' },
      },
      required: ['park', 'rides'],
    },
  },
  {
    name: 'remember',
    description: "Save durable notes about this traveler for future conversations: trip dates, party size and ages, hotel, budget, must-do rides, height or mobility constraints, preferences. The notes REPLACE all previously saved notes, so restate the still-true old facts along with the new ones. Only works when the user is logged in; if it errors, briefly suggest a free ParkPulse account so you can remember their trip.",
    input_schema: {
      type: 'object',
      properties: {
        notes: { type: 'string', description: 'Complete, compact traveler notes (facts only, no advice), max ~1200 characters' },
      },
      required: ['notes'],
    },
  },
];

const localTime = (tz) =>
  new Date().toLocaleString('en-US', { timeZone: tz, weekday: 'long', hour: 'numeric', minute: '2-digit' });

function waitsBlock(park, waits) {
  const rides = waits.rides
    .map((r) => `- ${r.name}${r.land ? ` [${r.land}]` : ''}: ${r.open ? `${r.wait} min${r.typical != null ? ` (typical ${r.typical})` : ''}` : 'closed'}`)
    .join('\n');
  return `Park: ${park.name} (${park.group})${park.slug ? ` — slug for tool calls: ${park.slug}` : ''}
Local time now: ${localTime(park.tz)}
Typical hours: ${park.open}:00-${park.close}:00 local.
${park.show ? `Tonight's show: ${park.show.name} around ${park.show.hour}:00.` : 'No headline evening show.'}
Data: ${waits.source === 'live' ? 'live, updated within minutes' : 'TYPICAL-DAY ESTIMATES (live feed unavailable) — caveat advice accordingly'}
${waits.forecast ? `7-day crowd outlook (based on ${waits.forecast.basis}): ${waits.forecast.days.map((d) => `${d.dow} ${d.label}${d.holiday ? ` (${d.holiday})` : ''}`).join(', ')}. Lightest day: ${waits.forecast.best}.\n` : ''}Standby waits:
${rides}`;
}

// Models sometimes pass the park's display name (or a stale slug) instead of
// the slug; resolve generously, then fall back to the park being viewed —
// both tools are documented as current-park-only anyway.
function resolvePark(ref, ctx) {
  if (typeof ref === 'string' && ref) {
    if (deps.parks[ref]) return deps.parks[ref];
    const needle = ref.trim().toLowerCase();
    const byName = Object.values(deps.parks).find((p) => p.name.toLowerCase() === needle || p.slug === needle);
    if (byName) return byName;
  }
  return ctx.park || null;
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
      const park = resolvePark(input.park, ctx);
      const threshold = Math.round(Number(input.threshold));
      const ride = typeof input.ride === 'string' ? input.ride.slice(0, 120) : null;
      if (!park || !ride || !Number.isFinite(threshold) || threshold < 5 || threshold > 240) {
        return { text: 'Invalid alert parameters (need a valid park slug, exact ride name, and a threshold of 5-240 minutes).', isError: true };
      }
      if (!ctx.subscription) {
        return { text: 'The user has not enabled push notifications on this device, so no alert can be created. Tell them to tap the bell icon next to the ride to enable notifications first.', isError: true };
      }
      deps.createAlert(ctx.subscription, park.slug, ride, threshold);
      ctx.send('action', { type: 'alert', park: park.slug, ride, threshold });
      return { text: `Alert created: the user will get a push notification when ${ride} drops to ${threshold} minutes or less.` };
    }
    if (block.name === 'propose_plan') {
      const park = resolvePark(input.park, ctx);
      const rides = Array.isArray(input.rides) ? input.rides.filter((r) => typeof r === 'string').slice(0, 20) : [];
      if (!park || !rides.length) return { text: 'Invalid plan (need a valid park slug and at least one ride name).', isError: true };
      ctx.send('action', { type: 'plan', park: park.slug, rides });
      if (ctx.channel === 'whatsapp') {
        return { text: 'Noted — but this conversation is over WhatsApp, where there is NO Apply button. Do not mention any button; instead write the plan as a clear numbered ride order they can follow, and mention they can also build it in the ParkPulse app.' };
      }
      return { text: 'Plan delivered to the chat — the user now sees an OPTIONAL Apply button. Briefly summarize the plan and invite them to tap Apply if they want it loaded into their plan builder; do not say it was applied.' };
    }
    if (block.name === 'remember') {
      const notes = typeof input.notes === 'string' ? input.notes.trim().slice(0, 1200) : '';
      if (!notes) return { text: 'Invalid notes (need a non-empty string).', isError: true };
      if (!ctx.email) {
        return { text: 'The user is not logged in, so nothing can be saved. Briefly suggest creating a free ParkPulse account (the 👤 button in the app) so you can remember their trip.', isError: true };
      }
      deps.saveMemory(ctx.email, notes);
      ctx.send('action', { type: 'memory' });
      return { text: 'Traveler notes saved — future conversations will start with them.' };
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
  // A client-trimmed window can start mid-conversation on an assistant turn;
  // the API requires the first message to be from the user, so drop leaders.
  while (clean.length && clean[0].role !== 'user') clean.shift();
  if (!clean.length || clean[clean.length - 1].role !== 'user') return null;
  return clean;
}

function userContextBlock({ favorites, planPicks, subscription, email, memory, lang, trip, profile, done }) {
  const favs = Array.isArray(favorites) ? favorites.filter((f) => typeof f === 'string').slice(0, 30) : [];
  const picks = Array.isArray(planPicks) ? planPicks.filter((f) => typeof f === 'string').slice(0, 30) : [];
  const rode = Array.isArray(done) ? done.filter((f) => typeof f === 'string').slice(0, 40) : [];
  const lines = [];
  if (rode.length) lines.push(`Already ridden today (ticked off in the app): ${rode.join(', ')}. Don't schedule these again unless they ask for a re-ride.`);
  if (profile && (profile.party || profile.ages.length || profile.vibes.length || profile.onsite !== null)) {
    const bits = [];
    if (profile.party) bits.push(`party of ${profile.party}`);
    if (profile.ages.length) bits.push(`ages in group: ${profile.ages.join(', ')}`);
    if (profile.vibes.length) bits.push(`ride tastes: ${profile.vibes.join(', ')}`);
    if (profile.onsite !== null) bits.push(profile.onsite ? 'staying at an on-site park hotel' : 'staying off-site');
    lines.push(`Their group (from the setup wizard): ${bits.join('; ')}. Tailor pacing, ride picks and pass math to this group — e.g. Rider Switch when toddlers are along, single-rider only if splitting up fits them.`);
  }
  if (memory) lines.push(`Saved traveler notes from earlier conversations (kept current via your remember tool):\n${memory}`);
  if (trip) {
    let plan = [];
    try { plan = JSON.parse(trip.plan); } catch {}
    if (plan.length) lines.push(`Their saved trip plan (${trip.dest}, starting ${trip.start}, staying ${trip.onsite ? 'AT AN ON-SITE PARK HOTEL — apply on-site booking windows and hotel perks (e.g. WDW 7-day Lightning Lane window, free Express at Universal Orlando premier hotels, early entry)' : 'off-site — apply off-site rules (e.g. WDW 3-day Lightning Lane window, no hotel skip perks)'}): ${plan.map((p) => `${p.date}: ${p.park}`).join('; ')}. Anchor multi-day advice to this schedule.`);
  }
  if (favs.length) lines.push(`Starred favorite rides: ${favs.join(', ')}`);
  if (picks.length) lines.push(`Rides currently checked in their plan builder: ${picks.join(', ')}`);
  lines.push(`App language setting: ${lang || 'English'}. Reply in ${lang || 'English'} — even if earlier messages in this conversation are in a different language, the current setting wins.`);
  lines.push(`Logged in: ${email ? 'yes (remember will work)' : 'no (remember will fail)'}`);
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
async function consult({ park, waits, messages, favorites, planPicks, subscription, email, memory, lang, trip, profile, done, channel, send }) {
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
      content: `<live_data>\n${waitsBlock(park, waits)}\n</live_data>\n<user_context>\n${userContextBlock({ favorites, planPicks, subscription, email, memory, lang, trip, profile, done })}\n</user_context>\n\n${last.content}`,
    },
  ];
  // Actions are emitted the moment their side effect happens, so a later
  // turn failing (or the client disconnecting) can't orphan a created alert.
  const ctx = { subscription, email: email || null, park, channel: channel || 'app', send };
  let emittedText = false;
  let turnEmitted = false;

  let continuations = 0;
  let continuing = false; // true while resuming a max_tokens cut — no separator
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 3000,
      output_config: { effort: 'medium' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [{ type: 'text', text: systemPrompt(), cache_control: { type: 'ephemeral' } }],
      tools: TOOL_DEFS,
      messages: convo,
    });

    turnEmitted = false;
    for await (const ev of stream) {
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta' && ev.delta.text) {
        if (!turnEmitted && emittedText && !continuing) send('delta', { text: '\n\n' }); // separate pre-tool preamble from post-tool answer
        turnEmitted = true;
        emittedText = true;
        send('delta', { text: ev.delta.text });
      }
    }
    const msg = await stream.finalMessage();
    continuing = false;

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
    // Ran out of output budget mid-answer: pick up exactly where it stopped
    // instead of leaving the user a sentence cut in half. One retry is plenty.
    if (msg.stop_reason === 'max_tokens' && continuations < 1) {
      continuations++;
      continuing = true;
      convo.push({ role: 'user', content: 'Your answer was cut off by the output limit. Continue exactly where it stopped — mid-sentence if needed, same language — without repeating anything or adding a preamble.' });
      continue;
    }
    break; // end_turn
  }

  send('done', {});
}

// One-shot ride description: short, family-focused, honest about uncertainty.
// Generated once per ride per language, then cached by the caller.
async function describeRide(parkName, rideName, lang) {
  const msg = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 250,
    output_config: { effort: 'low' },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: 'You write tiny attraction blurbs for a theme-park app. At most 2 short sentences: what kind of ride or experience it is, thrill level, and who it suits (small kids? thrill seekers?). If you are not confident about this specific attraction, infer only its likely type from the name and park and keep it generic — never invent specifics like drops, speeds, or heights you are unsure of. No preamble, no quotes.',
    messages: [{ role: 'user', content: `Attraction: "${rideName}" at ${parkName}. Reply in ${lang || 'English'}.` }],
  });
  if (msg.stop_reason === 'refusal') return null;
  return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim() || null;
}

// One-shot park dining guide as strict JSON, generated once per park per
// language and cached by the caller. Honesty-guarded: only well-known spots.
// Strict-JSON responses occasionally arrive wrapped in a stray sentence.
// Parse the whole string first, then fall back to the outermost [...] block.
function parseJsonArray(raw) {
  try { return JSON.parse(raw); } catch {}
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}

async function diningGuide(parkName, group, lang) {
  const msg = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 1500,
    output_config: { effort: 'low' },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: 'You produce dining guides for a theme-park app as STRICT JSON — no markdown, no code fences, no commentary. Output a JSON array of 5-8 objects: {"name": string, "type": "table"|"quick"|"character", "price": "$"|"$$"|"$$$", "blurb": string (one short sentence: cuisine + why it stands out), "mustBook": boolean (true only if reservations are genuinely hard to get)}. Include ONLY restaurants you are confident actually exist at this specific park — fewer correct entries beat more invented ones. Blurbs in the requested language; names in their official form.',
    messages: [{ role: 'user', content: `Park: ${parkName} (${group}). Language for blurbs: ${lang || 'English'}.` }],
  }, { timeout: 90000, maxRetries: 1 }); // a hung call must fail, not pin the job
  if (msg.stop_reason === 'refusal') return null;
  const raw = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim()
    .replace(/^```json?\s*/i, '').replace(/```\s*$/, '');
  // Be forgiving about a stray sentence around the array — a whole guide
  // shouldn't be lost to one word of preamble.
  const list = parseJsonArray(raw);
  if (!Array.isArray(list)) return null;
  return list.slice(0, 8).map((r) => ({
    name: String(r.name || '').slice(0, 80),
    type: ['table', 'quick', 'character'].includes(r.type) ? r.type : 'quick',
    price: ['$', '$$', '$$$'].includes(r.price) ? r.price : '$$',
    blurb: String(r.blurb || '').slice(0, 200),
    mustBook: Boolean(r.mustBook),
  })).filter((r) => r.name);
}

// One-shot ride classification for a park: vibe + minimum enjoyment age,
// strict JSON, generated once per park and cached by the caller.
async function rideTags(parkName, rideNames) {
  const msg = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: 'low' },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: 'You classify theme-park attractions for a family app as STRICT JSON — no markdown, no commentary. Output a JSON array with one object per input attraction, same names verbatim: {"name": string, "vibe": "gentle"|"family"|"thrill"|"water"|"show", "minAge": 0|3|7|12, "sr": boolean}. vibe: gentle = slow/calm (carousels, dark rides, boats); family = moderate excitement everyone rides; thrill = coasters/drops/intense; water = gets you wet; show = theater/entertainment. minAge = youngest age that genuinely enjoys it (0 anyone, 3 preschool, 7 school age, 12 teens+). sr = true ONLY if this specific attraction genuinely operates a single-rider line (e.g. VelociCoaster, Smugglers Run, Test Track, Expedition Everest, Rock \'n\' Roller Coaster); when unsure, false. If you do not know a specific attraction, infer conservatively from its name.',
    messages: [{ role: 'user', content: `Park: ${parkName}. Attractions:\n${rideNames.map((n) => `- ${n}`).join('\n')}` }],
  });
  if (msg.stop_reason === 'refusal') return null;
  const raw = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim()
    .replace(/^```json?\s*/i, '').replace(/```\s*$/, '');
  const list = JSON.parse(raw);
  if (!Array.isArray(list)) return null;
  const out = {};
  for (const r of list) {
    if (!r || typeof r.name !== 'string') continue;
    out[r.name] = {
      vibe: ['gentle', 'family', 'thrill', 'water', 'show'].includes(r.vibe) ? r.vibe : 'family',
      minAge: [0, 3, 7, 12].includes(r.minAge) ? r.minAge : 3,
      sr: Boolean(r.sr),
    };
  }
  return out;
}

module.exports = { enabled, init, consult, throttled, describeRide, diningGuide, rideTags, _setClient, _internal: { runTool, waitsBlock, validateMessages } };
