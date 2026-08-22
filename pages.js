// Server-rendered, indexable park pages — the SEO top of funnel.
// Each park gets /parks/<slug> with typical waits, hours, show info, and
// pass strategy (Lightning Lane for Disney, Express Pass for Universal),
// rendered from bundled data so pages are complete without the live feed.

const DISNEY_GROUPS = new Set([
  'Walt Disney World', 'Disneyland (California)', 'Disneyland Paris',
  'Tokyo Disney Resort', 'Hong Kong Disneyland', 'Shanghai Disneyland',
]);

const CSS = `
  :root { --bg:#f7f5ff; --card:#fff; --ink:#251d3d; --muted:#6b6485; --brand:#4f3ac9; --border:#e3dff2; --green:#1d7a4f; --green-soft:#e2f5ea; --gold:#a06f00; --gold-soft:#fdf3d7; --red:#b23a48; --red-soft:#fbe9ec; }
  @media (prefers-color-scheme: dark) { :root { --bg:#17122b; --card:#221b3d; --ink:#efecfc; --muted:#a79fc4; --brand:#8f7bf0; --border:#362c5c; --green:#5ecb96; --green-soft:#1c3a2c; --gold:#e5b955; --gold-soft:#3d331f; --red:#ef8b96; --red-soft:#46242a; } }
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 "Segoe UI",system-ui,sans-serif}
  .wrap{max-width:760px;margin:0 auto;padding:1.5rem 1.25rem 4rem}
  nav{display:flex;justify-content:space-between;align-items:center;padding:.5rem 0 1.5rem}
  .logo{font-weight:800;font-size:1.15rem;color:var(--brand);text-decoration:none}
  nav a.plain{color:var(--ink);text-decoration:none;font-weight:500;margin-left:1rem}
  h1{font-size:1.7rem;line-height:1.2;margin:.25rem 0 .5rem}
  .sub{color:var(--muted);margin:0 0 1.25rem}
  h2{font-size:1.25rem;margin:2rem 0 .6rem}
  .card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:1.1rem 1.35rem;margin:.75rem 0}
  table{width:100%;border-collapse:collapse;font-size:.95rem}
  th,td{text-align:left;padding:.5rem .6rem;border-bottom:1px solid var(--border)}
  th{color:var(--muted);font-weight:600;font-size:.85rem}
  .w{font-weight:800;border-radius:8px;padding:.15rem .6rem;display:inline-block;min-width:3.6rem;text-align:center}
  .w.low{background:var(--green-soft);color:var(--green)} .w.mid{background:var(--gold-soft);color:var(--gold)} .w.high{background:var(--red-soft);color:var(--red)}
  .cta{display:inline-block;background:var(--brand);color:#fff;border-radius:12px;padding:.7rem 1.4rem;font-weight:700;text-decoration:none;margin-top:.5rem}
  ul{padding-left:1.2rem} li{margin:.35rem 0}
  footer{margin-top:3rem;color:var(--muted);font-size:.85rem;border-top:1px solid var(--border);padding-top:1rem}
  footer a{color:var(--muted)}
`;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hour12 = (h) => {
  const whole = Math.floor(h), mins = Math.round((h - whole) * 60);
  return `${whole % 12 === 0 ? 12 : whole % 12}${mins ? ':' + String(mins).padStart(2, '0') : ''} ${whole >= 12 ? 'PM' : 'AM'}`;
};
const waitClass = (w) => (w >= 60 ? 'high' : w >= 30 ? 'mid' : 'low');

function passStrategy(park) {
  if (DISNEY_GROUPS.has(park.group)) {
    return `<h2>Is Lightning Lane worth it at ${esc(park.name)}?</h2>
<div class="card"><p>Disney's paid line-skipping system is <strong>Lightning Lane</strong> (FastPass was retired in 2021). Multi Pass runs roughly $15&ndash;$45 per person per day depending on park and date; Single Pass covers excluded headliners for about $12&ndash;$25 per ride. Resort guests book 7 days ahead at 7:00&nbsp;AM ET, off-site guests 3 days ahead &mdash; and the top headliners can sell out in minutes.</p>
<p>Whether it's worth it depends on the day: on light-crowd days, rope drop plus the final operating hour covers most headliners for free. ParkPulse shows every wait live with a "vs typical" marker so you can decide with data &mdash; and the built-in AI consultant will run the math for your party.</p></div>`;
  }
  return `<h2>Is Express Pass worth it at ${esc(park.name)}?</h2>
<div class="card"><p>Universal's system is <strong>Express Pass</strong> &mdash; no return times, just enter the Express line whenever. It's sold per park per day (roughly $80&ndash;$300 per person depending on date) in one-ride-each and Unlimited flavors.</p>
<p>The classic money-saver at Universal Orlando: guests of the premier hotels (Hard Rock, Royal Pacific, Portofino Bay) get <strong>free Unlimited Express for the whole stay</strong> &mdash; on busy dates a one-night stay can cost less than buying passes for a family. Also check the single-rider lines, which are excellent here. ParkPulse shows every wait live so you can judge whether today needs Express at all.</p></div>`;
}

function renderParkPage(park, sample, allParks) {
  const waitsRows = sample
    ? sample.rides.map((r) => `<tr><td>${esc(r.name)}</td><td><span class="w ${waitClass(r.wait)}">${r.wait} min</span></td></tr>`).join('')
    : '';
  const waitsSection = sample
    ? `<h2>Typical wait times at ${esc(park.name)}</h2>
<div class="card"><table><tr><th>Attraction</th><th>Typical midday wait</th></tr>${waitsRows}</table>
<p style="color:var(--muted);font-size:.85rem">Typical midday standby waits on a moderate day. <a href="/app">See today's live waits &rarr;</a></p></div>`
    : `<h2>Wait times at ${esc(park.name)}</h2>
<div class="card"><p>ParkPulse tracks live standby waits for every attraction at ${esc(park.name)}, updated every few minutes.</p><a class="cta" href="/app">See live waits</a></div>`;

  const showLine = park.show ? `The headline evening show is <strong>${esc(park.show.name)}</strong>, typically around ${hour12(park.show.hour)} &mdash; ride headliners while the crowds watch it and waits drop 30&ndash;50%.` : 'There is no headline evening show, so the final operating hour is usually the quietest time to ride.';

  const others = allParks.filter((p) => p.slug !== park.slug).map((p) => `<a href="/parks/${p.slug}">${esc(p.name)}</a>`).join(' &middot; ');

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(park.name)} Wait Times &amp; ${DISNEY_GROUPS.has(park.group) ? 'Lightning Lane' : 'Express Pass'} Strategy | ParkPulse</title>
<meta name="description" content="Live ${esc(park.name)} wait times, typical waits for every ride, park hours, and whether ${DISNEY_GROUPS.has(park.group) ? 'Lightning Lane' : 'Express Pass'} is worth it today.">
<link rel="icon" href="/icon.svg" type="image/svg+xml"><meta name="theme-color" content="#2c2154">
<link rel="canonical" href="https://www.parkpulse.fun/parks/${park.slug}">
<style>${CSS}</style></head><body><div class="wrap">
<nav><a class="logo" href="/"><img src="/icon.svg" alt="" width="22" height="22" style="vertical-align:-4px;margin-right:.2rem"> ParkPulse</a><span><a class="plain" href="/app">Live waits</a><a class="plain" href="/guide">Guide</a></span></nav>
<h1>${esc(park.name)} Wait Times &amp; Strategy</h1>
<p class="sub">${esc(park.group)} &middot; typical hours ${hour12(park.open)}&ndash;${hour12(park.close)}</p>
<div class="card"><p><strong>The one-minute version:</strong> arrive before opening and ride a headliner first &mdash; the first hour has the day's shortest lines. Waits peak from 11&nbsp;AM to 4&nbsp;PM (do shows and meals then), and the final hour is often as quiet as rope drop. ${showLine}</p>
<a class="cta" href="/app">See today's live waits free</a></div>
${waitsSection}
${passStrategy(park)}
<h2>Beat the lines without paying</h2>
<div class="card"><ul>
<li><strong>Rope drop:</strong> be at the gate 45&ndash;60 minutes before opening and walk onto one or two headliners.</li>
<li><strong>The last hour:</strong> often the day's shortest waits &mdash; if you're in line at close, you ride.</li>
<li><strong>Show windows:</strong> ${park.show ? `during ${esc(park.show.name)}, major attractions quietly shrink` : 'evening hours thin out steadily after dinner'}.</li>
<li><strong>Live data:</strong> a wait that's 15+ minutes below its typical level is a "go now" signal &mdash; ParkPulse flags these automatically.</li>
</ul></div>
<h2>More parks</h2><p>${others}</p>
<footer>Unofficial fan guide &mdash; not affiliated with the park operators. Wait-time data powered by <a href="https://queue-times.com">Queue-Times.com</a>. <a href="/">ParkPulse home</a> &middot; <a href="/guide">Free strategy guide</a> &middot; <a href="/terms">Terms</a> &middot; <a href="/privacy">Privacy</a></footer>
</div><script src="/i18n.js"></script><script src="/chat-widget.js" data-park="${park.slug}" data-park-name="${esc(park.name)}" defer></script></body></html>`;
}

const renderSitemap = (origin, slugs) => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${['', '/app', '/guide', '/terms', '/privacy', ...slugs.map((s) => `/parks/${s}`)].map((p) => `  <url><loc>${origin}${p}</loc></url>`).join('\n')}
</urlset>`;

const renderRobots = (origin) => `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`;

module.exports = { renderParkPage, renderSitemap, renderRobots };
