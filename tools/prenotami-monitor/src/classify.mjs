// Deciding what a booking page means, kept free of the browser so it can be
// tested directly -- see test/classify.test.mjs.

// Order matters: "you already have a booking" and "no dates available" can both
// appear on the same page, and the blocked state is the more useful thing to say.
export function classifyBookingPage(pageText, config) {
  const text = (pageText || '').toLowerCase().replace(/\s+/g, ' ');

  const blocked = config.blockedPhrases.find((p) => text.includes(p.toLowerCase()));
  if (blocked) return { outcome: 'blocked', matched: blocked };

  const unavailable = config.unavailablePhrases.find((p) => text.includes(p.toLowerCase()));
  if (unavailable) return { outcome: 'unavailable', matched: unavailable };

  return { outcome: 'available', matched: null };
}
