// Premade touring plans: named personas run through a server-side scheduler,
// cached per park, served as indexable pages. The competition sells "120+
// premium touring plans"; ours are generated from the same tags, typical
// waits and hourly crowd shape the live planner uses — and they're free.
//
// This is deliberately NOT the client planner ported line for line. Premade
// plans are evergreen: they run on typical patterns, not live waits, and
// regenerate weekly. The live planner in the app remains the sharp tool;
// these pages are the shareable, crawlable doorway to it.
'use strict';

// One touch of Mila per persona — static flavor text, zero AI cost.
const PERSONAS = [
  {
    slug: 'first-visit', emoji: '🏰', title: 'First Visit Classics',
    who: 'First-timers who want the essentials, in the right order',
    mila: "Every classic, none of the criss-crossing — the park the way it was meant to unfold.",
    needsTags: false,
    filter: () => true,
    startOffset: 0, endOffset: 0, maxSteps: 12,
  },
  {
    slug: 'little-ones', emoji: '🧸', title: 'Parents with Little Ones',
    who: 'Crews with kids under 7 — nothing scary, nothing they must sit out',
    mila: 'Small legs, big eyes. Gentle rides up front, the nap-window respected, and not one "you must be this tall" tear.',
    needsTags: true,
    filter: (t) => (t.hmin === 0 || t.hmin == null) && (t.vibe === 'gentle' || t.vibe === 'family' || t.vibe === 'show') && t.minAge <= 3,
    startOffset: 0, endOffset: -2, maxSteps: 10,
  },
  {
    slug: 'thrill-seekers', emoji: '🎢', title: 'Thrill Seekers',
    who: 'Coasters and headliners first, gentle stuff never',
    mila: "The mountains before the crowds find their shoes — that's the whole trick.",
    needsTags: true,
    filter: (t) => t.vibe === 'thrill' || t.vibe === 'water',
    startOffset: 0, endOffset: 0, maxSteps: 11,
  },
  {
    slug: 'adults', emoji: '🥂', title: "Adults' Day Out",
    who: 'No kiddie rides, a civilised pace, the good stuff',
    mila: 'Headliners in the quiet hours, a real lunch, and a show when your feet vote for sitting.',
    needsTags: true,
    filter: (t) => t.minAge >= 3 || t.vibe === 'thrill' || t.vibe === 'show',
    startOffset: 1, endOffset: 0, maxSteps: 10,
  },
  {
    slug: 'one-big-day', emoji: '⚡', title: 'One Big Day',
    who: 'Open to close, maximum attractions, one park day done right',
    mila: "Rope drop to fireworks. Bring your walking shoes and I'll bring the order.",
    needsTags: false,
    filter: () => true,
    startOffset: 0, endOffset: 0, maxSteps: 14,
  },
  {
    slug: 'sleep-in', emoji: '🌙', title: 'Sleep In, Stay Late',
    who: 'Arrive after lunch, own the evening',
    mila: 'The secret nobody uses: the last two hours are as empty as the first — you just get them without the alarm clock.',
    needsTags: false,
    filter: () => true,
    startOffset: 4, endOffset: 0, maxSteps: 9,
  },
  {
    slug: 'rainy-day', emoji: '🌧', title: 'Rainy Day Indoors',
    who: 'A wet forecast, kept dry — indoor and covered attractions only',
    mila: 'Let it pour. This whole route happens under a roof, and the queues shrink when the sky opens.',
    needsTags: true,
    filter: (t) => t.in === 'indoor' || t.in === 'covered',
    startOffset: 0, endOffset: 0, maxSteps: 10,
  },
  {
    slug: 'beat-the-heat', emoji: '🥵', title: 'Beat the Heat',
    who: 'Scorching days: outdoors early and late, AC through the peak',
    mila: 'Outdoor mountains before eleven, air-conditioning from noon to five, and the splash rides exactly when you want to be soaked.',
    needsTags: true,
    filter: () => true,   // ordering does the work, not exclusion
    heatAware: true,
    startOffset: 0, endOffset: 0, maxSteps: 11,
  },
];

// Same hour-of-day crowd shape as the live planner and the backtest.
let SHAPE = {};
function init({ hourlyShape }) { SHAPE = hourlyShape; }

const hourLabel = (h) => {
  const whole = Math.floor(h), m = Math.round((h - whole) * 60);
  const twelve = ((whole + 11) % 12) + 1;
  return `${twelve}:${String(m).padStart(2, '0')} ${whole < 12 ? 'AM' : 'PM'}`;
};

// entries: [{ name, land, base (typical minutes), tags|null }]
function buildPremade(park, entries, persona) {
  const withTags = entries.filter((e) => e.tags);
  // A tag-dependent persona with almost nothing tagged would produce a
  // 2-stop "plan" — worse than absent. The caller hides it for this park.
  if (persona.needsTags && withTags.length < Math.min(6, entries.length)) return null;

  let pool = entries.filter((e) => {
    if (!persona.filter) return true;
    if (!e.tags) return !persona.needsTags;      // untagged rides only join generic personas
    return persona.filter(e.tags);
  });
  if (pool.length < 4) return null;

  // Popularity = typical wait. The longest lines are the rides people came
  // for; that ranking IS the demand signal, park by park.
  pool = [...pool].sort((a, b) => (b.base || 0) - (a.base || 0)).slice(0, persona.maxSteps + 4);

  const start = Math.max(7, (park.open ?? 9) + (persona.startOffset || 0));
  const end = Math.min(24, (park.close ?? 21) + (persona.endOffset || 0));

  // Rope-drop the two biggest queues, then walk land by land (largest cluster
  // first) instead of criss-crossing the park.
  const headliners = pool.slice(0, 2);
  const rest = pool.slice(2);
  const byLand = new Map();
  for (const e of rest) {
    const land = e.land || (e.tags && e.tags.land) || 'the park';
    if (!byLand.has(land)) byLand.set(land, []);
    byLand.get(land).push(e);
  }
  let ordered = [...headliners];
  for (const [, group] of [...byLand.entries()].sort((a, b) => b[1].length - a[1].length)) {
    ordered.push(...group);
  }

  // Beat-the-heat: outdoor rides keep the cool edges of the day, indoor rides
  // take the furnace hours. Stable partition, then re-merge around 12–17.
  if (persona.heatAware) {
    const outdoor = ordered.filter((e) => e.tags && e.tags.in === 'outdoor');
    const sheltered = ordered.filter((e) => !e.tags || e.tags.in !== 'outdoor');
    const morningSlots = Math.max(1, Math.round((12 - start) / 1.2));
    ordered = [
      ...outdoor.slice(0, morningSlots),
      ...sheltered,
      ...outdoor.slice(morningSlots),
    ];
  }

  const steps = [];
  let t = start;
  let lunched = false, dinnered = false;
  const avgShape = 1;
  // Rides stop when the night show starts — a step scheduled during the
  // fireworks is a step nobody takes, and it printed after them besides.
  const showHour = park.show && park.show.hour < end ? park.show.hour : null;
  const rideEnd = showHour != null ? Math.min(end, showHour) : end;
  for (const e of ordered) {
    if (steps.length >= persona.maxSteps || t >= rideEnd) break;
    if (!lunched && t >= 12 && t < 15) {
      steps.push({ time: hourLabel(t), break: 'Lunch', why: 'Eat at the peak — the queues are at their worst anyway.' });
      t += 0.75; lunched = true;
    }
    if (!dinnered && t >= 18 && t < 20.5 && rideEnd - t > 1.5) {
      steps.push({ time: hourLabel(t), break: 'Dinner', why: 'The evening lull starts while everyone else eats late.' });
      t += 0.75; dinnered = true;
    }
    if (t >= rideEnd) break;
    const shape = SHAPE[Math.floor(t)] ?? avgShape;
    const wait = Math.max(5, Math.round((e.base || 15) * shape / 5) * 5);
    const dur = (e.tags && e.tags.dur) || 8;
    steps.push({
      time: hourLabel(t),
      name: e.name,
      land: e.land || (e.tags && e.tags.land) || '',
      wait,
      why: t < start + 1.5 ? 'Rope-drop window — the shortest this line gets all day.'
        : shape >= 1.05 ? 'Peak crowds — expect the posted wait; everything after this gets easier.'
        : 'Crowds easing — a good slot for it.',
    });
    t += (wait + dur + 10) / 60;
  }
  if (park.show && persona.slug !== 'little-ones' && Math.floor(park.show.hour) < end) {
    steps.push({ time: hourLabel(park.show.hour), break: park.show.name, why: 'Cap off the night.' });
  }

  const named = steps.filter((s) => s.name);
  if (named.length < 4) return null;
  return {
    park: park.slug, parkName: park.name, persona: persona.slug,
    title: persona.title, emoji: persona.emoji, who: persona.who, mila: persona.mila,
    steps,
    stats: {
      attractions: named.length,
      first: named[0].time,
      headliner: named.reduce((a, b) => (b.wait > (a?.wait || 0) ? b : a), null)?.name || null,
      span: `${named[0].time} → ${steps[steps.length - 1].time}`,
    },
    basis: 'typical crowd patterns',
  };
}

module.exports = { PERSONAS, buildPremade, init };
