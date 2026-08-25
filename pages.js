// Server-rendered, indexable park pages — the SEO top of funnel.
// Each park gets /parks/<slug> answering the queries people actually type:
// "<park> wait times", "is Lightning Lane worth it at <park>", "best month
// to visit <park>", "what to ride first at <park>". Content comes from
// bundled data so a page is complete and useful even when the live feed is
// down, with live waits layered on top when they are available.

const fs = require('node:fs');
const path = require('node:path');

const SEO = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'park-seo.json'), 'utf8'));

const DISNEY_GROUPS = new Set([
  'Walt Disney World', 'Disneyland (California)', 'Disneyland Paris',
  'Tokyo Disney Resort', 'Hong Kong Disneyland', 'Shanghai Disneyland',
]);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// How a typical day's queue builds, as a share of that day's own peak.
// Sampled across the operating day so it scales to any park's hours — a
// coaster park that opens at 10 peaks later than a Disney park opening at 8.
const CURVES = {
  disney: [0.35, 0.55, 0.80, 0.95, 1.00, 1.00, 0.95, 0.88, 0.80, 0.70, 0.55, 0.40],
  universal: [0.40, 0.65, 0.88, 1.00, 1.00, 0.95, 0.90, 0.85, 0.75, 0.62, 0.48, 0.35],
  coaster: [0.30, 0.45, 0.65, 0.82, 0.95, 1.00, 1.00, 0.92, 0.78, 0.60, 0.42, 0.30],
  family: [0.35, 0.60, 0.85, 1.00, 0.98, 0.88, 0.72, 0.55, 0.42, 0.32, 0.25, 0.22],
  europe: [0.40, 0.62, 0.85, 0.97, 1.00, 0.98, 0.90, 0.78, 0.62, 0.45, 0.33, 0.28],
};

const CSS = `
  :root { --bg:#f7f5ff; --card:#fff; --ink:#251d3d; --muted:#6b6485; --brand:#4f3ac9; --border:#e3dff2; --green:#1d7a4f; --green-soft:#e2f5ea; --gold:#a06f00; --gold-soft:#fdf3d7; --red:#b23a48; --red-soft:#fbe9ec; }
  @media (prefers-color-scheme: dark) { :root { --bg:#17122b; --card:#221b3d; --ink:#efecfc; --muted:#a79fc4; --brand:#8f7bf0; --border:#362c5c; --green:#5ecb96; --green-soft:#1c3a2c; --gold:#e5b955; --gold-soft:#3d331f; --red:#ef8b96; --red-soft:#46242a; } }
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 "Segoe UI",system-ui,sans-serif}
  .wrap{max-width:780px;margin:0 auto;padding:1.5rem 1.25rem 4rem}
  nav{display:flex;justify-content:space-between;align-items:center;padding:.5rem 0 1.5rem}
  .logo{font-weight:800;font-size:1.15rem;color:var(--brand);text-decoration:none}
  nav a.plain{color:var(--ink);text-decoration:none;font-weight:500;margin-left:1rem}
  h1{font-size:1.75rem;line-height:1.2;margin:.25rem 0 .5rem}
  .sub{color:var(--muted);margin:0 0 1.25rem}
  h2{font-size:1.3rem;margin:2.25rem 0 .6rem;scroll-margin-top:1rem}
  h3{font-size:1.02rem;margin:1.1rem 0 .3rem}
  .card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:1.1rem 1.35rem;margin:.75rem 0}
  .card p:first-child{margin-top:0} .card p:last-child{margin-bottom:0}
  table{width:100%;border-collapse:collapse;font-size:.95rem}
  th,td{text-align:left;padding:.5rem .6rem;border-bottom:1px solid var(--border)}
  th{color:var(--muted);font-weight:600;font-size:.85rem}
  .w{font-weight:800;border-radius:8px;padding:.15rem .6rem;display:inline-block;min-width:3.6rem;text-align:center}
  .w.low{background:var(--green-soft);color:var(--green)} .w.mid{background:var(--gold-soft);color:var(--gold)} .w.high{background:var(--red-soft);color:var(--red)}
  .cta{display:inline-block;background:var(--brand);color:#fff;border-radius:12px;padding:.7rem 1.4rem;font-weight:700;text-decoration:none;margin-top:.5rem}
  ul{padding-left:1.2rem} li{margin:.35rem 0}
  ol.drop{padding-left:0;list-style:none;counter-reset:d}
  ol.drop li{counter-increment:d;margin:.5rem 0;padding-left:2.4rem;position:relative}
  ol.drop li::before{content:counter(d);position:absolute;left:0;top:.05rem;width:1.7rem;height:1.7rem;border-radius:50%;background:var(--brand);color:#fff;font-weight:800;font-size:.85rem;display:flex;align-items:center;justify-content:center}
  .verdict{display:inline-block;border-radius:999px;padding:.2rem .8rem;font-weight:800;font-size:.8rem;letter-spacing:.02em;text-transform:uppercase}
  .verdict.often{background:var(--red-soft);color:var(--red)}
  .verdict.sometimes{background:var(--gold-soft);color:var(--gold)}
  .verdict.rarely{background:var(--green-soft);color:var(--green)}
  .verdict.none{background:var(--green-soft);color:var(--green)}
  .chart{display:flex;align-items:flex-end;gap:3px;height:150px;margin:.6rem 0 .3rem}
  .chart .bar{flex:1;border-radius:4px 4px 0 0;background:var(--brand);opacity:.35;position:relative;min-height:3px}
  .chart .bar.pk{opacity:1}
  .chart .bar.qt{opacity:.55;background:var(--green)}
  .xaxis{display:flex;gap:3px;color:var(--muted);font-size:.7rem}
  .xaxis span{flex:1;text-align:center;overflow:hidden}
  .months{display:grid;grid-template-columns:repeat(12,1fr);gap:3px;margin:.5rem 0 .25rem}
  .months div{text-align:center;font-size:.7rem;font-weight:700;padding:.45rem .1rem;border-radius:6px;background:var(--border);color:var(--muted)}
  .months div.pk{background:var(--red-soft);color:var(--red)}
  .months div.qt{background:var(--green-soft);color:var(--green)}
  .legend{color:var(--muted);font-size:.8rem;margin:.25rem 0 0}
  .tip{border-left:3px solid var(--brand);padding-left:.9rem;margin:1rem 0;color:var(--ink)}
  .sibs{display:flex;flex-wrap:wrap;gap:.5rem;margin:.5rem 0}
  .sibs a{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:.45rem .8rem;text-decoration:none;color:var(--ink);font-weight:600;font-size:.92rem}
  details{border-top:1px solid var(--border);padding:.7rem 0}
  details summary{cursor:pointer;font-weight:700}
  details p{margin:.6rem 0 0}
  footer{margin-top:3rem;color:var(--muted);font-size:.85rem;border-top:1px solid var(--border);padding-top:1rem}
  footer a{color:var(--muted)}
  .cv-fig{margin:.6rem 0 1.4rem}
  .cv-svg{display:block;max-width:100%;height:auto;overflow:visible}
  /* A light fill on a dark ground carries more weight than the same value on
     a light one, so the dark step is chosen rather than inherited. */
  .cv-band{opacity:.13}
  @media (prefers-color-scheme:dark){ .cv-band{opacity:.1} }
  .cv-ax{fill:var(--muted);font-size:11px}
  .cv-ev{fill:var(--muted);font-size:10.5px;font-weight:600;letter-spacing:.02em}
  .cv-peak{fill:var(--ink);font-size:11.5px;font-weight:700}
  .cv-lg{fill:var(--muted);font-size:10.5px;font-weight:600}
  .cv-cap{font-size:.78rem;color:var(--muted);line-height:1.55;margin-top:.5rem}
  .cv-dl{display:block;margin-top:.35rem;font-weight:600}
  .cv-dl a{color:var(--brand);text-decoration:none}
  .cv-dl a:hover{text-decoration:underline}
  .bt-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:.6rem 0 .5rem}
  .bandtable{border-collapse:collapse;width:100%;min-width:520px;font-size:.86rem}
  .bandtable th,.bandtable td{padding:.45rem .55rem;border-bottom:1px solid var(--border);text-align:center}
  .bandtable thead th{font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:700}
  .bandtable tbody th{text-align:left;font-weight:600;color:var(--ink);white-space:nowrap}
  .bt-lvl{display:block;font-size:.66rem;font-weight:500;opacity:.7;text-transform:none;letter-spacing:0}
  .bt-typ{display:block;font-size:.7rem;color:var(--muted);font-weight:400}
  .bt-none{color:var(--muted);opacity:.5}
  .bt-note{font-size:.78rem;color:var(--muted);line-height:1.55;margin:.2rem 0 1.2rem}
  .allparks{columns:3;column-gap:1.2rem;font-size:.82rem;margin:.6rem 0 1rem}
  .allparks a{display:block;color:var(--muted);text-decoration:none;padding:.1rem 0;break-inside:avoid}
  .allparks a:hover{color:var(--brand)}
  .allparks b{display:block;color:var(--ink);margin:.5rem 0 .15rem;break-after:avoid}
  @media (max-width:640px){ .allparks{columns:2} h1{font-size:1.45rem} }
`;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hour12 = (h) => {
  const whole = Math.floor(h), mins = Math.round((h - whole) * 60);
  return `${whole % 12 === 0 ? 12 : whole % 12}${mins ? ':' + String(mins).padStart(2, '0') : ''} ${whole >= 12 ? 'PM' : 'AM'}`;
};
const hourShort = (h) => `${h % 12 === 0 ? 12 : h % 12}${h >= 12 ? 'p' : 'a'}`;
const waitClass = (w) => (w >= 60 ? 'high' : w >= 30 ? 'mid' : 'low');
// Hours arrive as a sorted list that may hold two separate runs (the opening
// lull and the closing one). Describing them as one span would claim the busy
// middle of the day is quiet, so group contiguous runs and name each.
const span = (hrs) => {
  if (!hrs.length) return '';
  const runs = [];
  for (const h of hrs) {
    const last = runs[runs.length - 1];
    if (last && h === last[last.length - 1] + 1) last.push(h);
    else runs.push([h]);
  }
  const parts = runs.map((r) => `${hour12(r[0])}\u2013${hour12(r[r.length - 1] + 1)}`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
};
const passName = (park) => (park.skip && park.skip.name) || (DISNEY_GROUPS.has(park.group) ? 'Lightning Lane' : 'a skip-the-line pass');
// Turn a month-number list into "March, April and June".
const monthList = (nums) => {
  const names = nums.slice().sort((a, b) => a - b).map((m) => MONTHS_LONG[m - 1]);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] || '';
};

// Sample the archetype curve at each operating hour, so the shape stretches
// to the park's own day rather than assuming everyone opens at nine.
function hourlyCurve(park, seo) {
  const curve = CURVES[seo.arch] || CURVES.disney;
  const open = Math.floor(park.open), close = Math.ceil(park.close);
  const out = [];
  for (let h = open; h < close; h += 1) {
    const pos = (close - open) <= 1 ? 0 : (h - open) / (close - open - 1);
    const x = pos * (curve.length - 1);
    const i = Math.floor(x), frac = x - i;
    const v = curve[i] + (curve[Math.min(i + 1, curve.length - 1)] - curve[i]) * frac;
    out.push({ hour: h, v });
  }
  return out;
}

function curveSection(park, seo) {
  const pts = hourlyCurve(park, seo);
  const max = Math.max(...pts.map((p) => p.v));
  const min = Math.min(...pts.map((p) => p.v));
  const isPeak = (v) => v >= max * 0.97;
  const isQuiet = (v) => v <= min * 1.22;
  const peakHours = pts.filter((p) => isPeak(p.v)).map((p) => p.hour);
  const quietHours = pts.filter((p) => isQuiet(p.v)).map((p) => p.hour);
  const bars = pts.map((p) => {
    const cls = isPeak(p.v) ? 'pk' : isQuiet(p.v) ? 'qt' : '';
    return `<div class="bar ${cls}" style="height:${Math.round((p.v / max) * 100)}%" title="${hour12(p.hour)}: ${Math.round(p.v * 100)}% of peak"></div>`;
  }).join('');
  const axis = pts.map((p, i) => `<span>${pts.length > 10 && i % 2 ? '' : hourShort(p.hour)}</span>`).join('');
  const rows = pts.map((p) => `<tr><td>${hour12(p.hour)}</td><td>${Math.round(p.v * 100)}% of the day's peak</td></tr>`).join('');

  return `<h2 id="hourly">${esc(park.name)} wait times by hour</h2>
<div class="card">
<p>Queues here follow a predictable daily shape. Lines are shortest in the first hour and the last, and peak <strong>${span(peakHours)}</strong> — that is the window to spend on shows, meals or indoor attractions rather than headliners.</p>
<div class="chart" role="img" aria-label="Typical wait times at ${esc(park.name)} by hour of day, as a share of the day's peak. Busiest ${span(peakHours)}, quietest ${span(quietHours)}.">${bars}</div>
<div class="xaxis">${axis}</div>
<p class="legend">Typical shape of a ${esc(park.name)} day, shown as each hour's share of that day's own peak wait. Actual minutes vary by season and day of week — <a href="/app">check today's live waits</a>.</p>
<details><summary>See the hour-by-hour numbers</summary>
<table><tr><th>Hour</th><th>Typical wait level</th></tr>${rows}</table></details>
</div>
<div class="tip"><strong>Shortest lines:</strong> ${span(quietHours)}. <strong>Longest:</strong> ${span(peakHours)}.</div>`;
}

function monthsSection(park, seo) {
  const peak = new Set(seo.peak.months), quiet = new Set(seo.quiet.months);
  const strip = MONTHS.map((m, i) => {
    const n = i + 1;
    const cls = peak.has(n) ? 'pk' : quiet.has(n) ? 'qt' : '';
    const label = peak.has(n) ? 'busiest' : quiet.has(n) ? 'quietest' : 'moderate';
    return `<div class="${cls}" title="${m}: ${label}">${m}</div>`;
  }).join('');
  return `<h2 id="months">Best and worst months to visit ${esc(park.name)}</h2>
<div class="card">
<div class="months" role="img" aria-label="Crowd levels by month at ${esc(park.name)}. Busiest: ${monthList(seo.peak.months)}. Quietest: ${monthList(seo.quiet.months)}.">${strip}</div>
<p class="legend">Red = busiest, green = quietest, grey = moderate.</p>
<h3>Busiest: ${monthList(seo.peak.months)}</h3>
<p>Expect the year's longest waits during ${esc(seo.peak.why)}.</p>
<h3>Quietest: ${monthList(seo.quiet.months)}</h3>
<p>The best value for short lines is ${esc(seo.quiet.why)}.</p>
</div>`;
}

function dropSection(park, seo) {
  const items = seo.drop.map((r) => `<li><strong>${esc(r)}</strong></li>`).join('');
  return `<h2 id="rope-drop">What to ride first at ${esc(park.name)}: rope drop order</h2>
<div class="card">
<p>Be at the gate 30–45 minutes before opening and ride in this order. ${esc(seo.dropWhy)}</p>
<ol class="drop">${items}</ol>
<p class="legend">The first hour is the cheapest capacity of the day — no pass, no fee, and typically the shortest waits you will see.</p>
</div>`;
}

const VERDICT_LABEL = {
  often: 'Usually worth it',
  sometimes: 'Worth it on busy days',
  rarely: 'Usually not worth it',
  none: 'Not sold here',
};

function passSection(park, seo) {
  const name = passName(park);
  const price = park.skip && park.skip.low != null
    ? `<p><strong>Price:</strong> roughly ${park.skip.cur || '$'}${park.skip.low}–${park.skip.cur || '$'}${park.skip.high} ${esc(park.skip.note || 'per person, per day')}. Prices change often and by date — treat this as a range, not a quote.</p>`
    : '';
  const q = seo.worth === 'none'
    ? `Does ${esc(park.name)} have a skip-the-line pass?`
    : `Is ${esc(name)} worth it at ${esc(park.name)}?`;
  return `<h2 id="pass">${q}</h2>
<div class="card">
<p><span class="verdict ${seo.worth}">${VERDICT_LABEL[seo.worth]}</span></p>
<p>${esc(seo.verdict)}</p>
${price}
<p>ParkPulse shows every wait live with a "vs typical" marker, and its AI consultant will run the numbers for your party and date — including telling you to keep your money when the answer is no.</p>
<a class="cta" href="/app">Check today's waits before you buy</a>
</div>`;
}

function faqSection(park, seo) {
  const name = passName(park);
  const pts = hourlyCurve(park, seo);
  const max = Math.max(...pts.map((p) => p.v)), min = Math.min(...pts.map((p) => p.v));
  const peakH = pts.filter((p) => p.v >= max * 0.97).map((p) => p.hour);
  const quietH = pts.filter((p) => p.v <= min * 1.22).map((p) => p.hour);
  const fmt = span;

  const qa = [
    [`What time should I arrive at ${park.name}?`,
      `Aim to be at the gate 30–45 minutes before the posted opening time of ${hour12(park.open)}. The first hour consistently has the day's shortest waits, and arriving even 45 minutes late typically costs you two headliners.`],
    [`When are wait times shortest at ${park.name}?`,
      `${fmt(quietH)} — the opening hour and the final hour of the operating day. Waits peak ${fmt(peakH)}, so plan meals, shows and indoor attractions for that window.`],
    [`What should I ride first at ${park.name}?`,
      `${seo.drop[0]}, then ${seo.drop.slice(1, 3).join(' and ')}. ${seo.dropWhy}`],
    [`What is the best month to visit ${park.name}?`,
      `${monthList(seo.quiet.months)} — ${seo.quiet.why}. Avoid ${monthList(seo.peak.months)}, when ${seo.peak.why}.`],
    [seo.worth === 'none' ? `Does ${park.name} sell a skip-the-line pass?` : `Is ${name} worth it at ${park.name}?`,
      seo.verdict],
  ];
  const html = qa.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('');
  return { html: `<h2 id="faq">${esc(park.name)} FAQ</h2><div class="card" style="padding-top:.2rem">${html}</div>`, qa };
}

// Every park, grouped by region, on every page — the crawl path that turns
// 56 separate pages into one site.
function allParksIndex(allParks, currentSlug) {
  const order = ['Florida', 'California', 'US & Canada', 'Europe', 'Asia'];
  const byRegion = {};
  for (const p of allParks) (byRegion[p.region] || (byRegion[p.region] = [])).push(p);
  const regions = [...order.filter((r) => byRegion[r]), ...Object.keys(byRegion).filter((r) => !order.includes(r))];
  return regions.map((r) => `<b>${esc(r)}</b>` + byRegion[r]
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => (p.slug === currentSlug
      ? `<a href="/parks/${p.slug}" aria-current="page"><strong>${esc(p.name)}</strong></a>`
      : `<a href="/parks/${p.slug}">${esc(p.name)}</a>`))
    .join('')).join('');
}

// The hourly wait curve. One series -- the median posted wait through the day --
// with its interquartile range as a soft band behind it, and the park's own
// milestones marked on the x-axis.
//
// Deliberately ONE line. The obvious second line, "time actually spent in
// line", would be the most useful thing on the page, and we do not draw it
// because we do not have it: every figure we hold is a POSTED wait, the number
// on the sign. Inventing the second line from the first would be drawing a
// model and calling it a measurement.
//
// Colour comes from the page's own tokens, so the deliberate dark palette
// applies rather than an automatic inversion.
function curveChart(park, curves, actual) {
  if (!curves) return '';
  // Prefer a middling day: it is what most visitors get, and it is the honest
  // default for "what does a normal day look like here".
  const level = [3, 4, 2, 5, 1].find((l) => curves[l]);
  if (!level) return '';
  const pts = curves[level];
  if (pts.length < 3) return '';
  const LEVEL_NAMES = { 1: 'Light', 2: 'Mild', 3: 'Moderate', 4: 'Busy', 5: 'Packed' };

  const W = 720, H = 300, ML = 44, MR = 16, MT = 22, MB = 46;
  const PW = W - ML - MR, PH = H - MT - MB;
  const h0 = pts[0].hour, h1 = pts[pts.length - 1].hour;
  const yMax = Math.max(10, Math.ceil(Math.max(...pts.map((p) => p.high)) / 10) * 10);
  const x = (h) => ML + ((h - h0) / Math.max(1, h1 - h0)) * PW;
  const y = (v) => MT + PH - (v / yMax) * PH;
  const hourLabel = (h) => (h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`);

  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.hour).toFixed(1)} ${y(p.median).toFixed(1)}`).join(' ');
  const bandPath = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.hour).toFixed(1)} ${y(p.high).toFixed(1)}`).join(' ')
    + ' ' + [...pts].reverse().map((p) => `L${x(p.hour).toFixed(1)} ${y(p.low).toFixed(1)}`).join(' ') + ' Z';

  // Solid hairlines. Dashing a grid reads as "threshold" when it is just a grid.
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(yMax * f));
  const grid = ticks.map((v) => `<line x1="${ML}" y1="${y(v).toFixed(1)}" x2="${W - MR}" y2="${y(v).toFixed(1)}" stroke="var(--border)" stroke-width="1"/>`
    + `<text x="${ML - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" class="cv-ax">${v}</text>`).join('');

  const xt = pts.filter((p, i) => i === 0 || i === pts.length - 1 || p.hour % 3 === 0)
    .map((p) => `<text x="${x(p.hour).toFixed(1)}" y="${H - MB + 18}" text-anchor="middle" class="cv-ax">${hourLabel(p.hour)}</text>`).join('');

  // Park milestones. Distinct from the grid by tone and by carrying a label, so
  // they read as annotation rather than as another gridline.
  const events = [
    { hour: park.open, label: 'Open' },
    ...(park.show && park.show.hour ? [{ hour: park.show.hour, label: park.show.name.replace(/ (fireworks|parade|show)$/i, '') }] : []),
    { hour: park.close, label: 'Close' },
  ].filter((e) => Number.isFinite(e.hour) && e.hour >= h0 && e.hour <= h1);
  const evMarks = events.map((e) => {
    const ex = x(e.hour);
    const anchor = ex < ML + 40 ? 'start' : ex > W - MR - 40 ? 'end' : 'middle';
    return `<line x1="${ex.toFixed(1)}" y1="${MT}" x2="${ex.toFixed(1)}" y2="${MT + PH}" stroke="var(--muted)" stroke-width="1" opacity=".45"/>`
      + `<text x="${ex.toFixed(1)}" y="${MT - 7}" text-anchor="${anchor}" class="cv-ev">${esc(e.label)}</text>`;
  }).join('');

  // Direct-label the peak only. A number on every point is unreadable.
  const peak = pts.reduce((a, b) => (b.median > a.median ? b : a));
  const px = x(peak.hour), py = y(peak.median);
  const peakAnchor = px > W - MR - 60 ? 'end' : 'middle';
  const peakLabel = `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="4" fill="var(--brand)" stroke="var(--card)" stroke-width="2"/>`
    + `<text x="${px.toFixed(1)}" y="${(py - 12).toFixed(1)}" text-anchor="${peakAnchor}" class="cv-peak">${peak.median} min at ${hourLabel(peak.hour)}</text>`;

  // Native SVG tooltips: a hover layer with no JavaScript, and it survives with
  // scripting off, which a canvas chart would not.
  const hoverDots = pts.map((p) => `<circle cx="${x(p.hour).toFixed(1)}" cy="${y(p.median).toFixed(1)}" r="9" fill="transparent"><title>${hourLabel(p.hour)} — typically ${p.median} min (middle half ${p.low}–${p.high}, ${p.n} readings)</title></circle>`).join('');

  // The second series, drawn only when visitors have actually reported enough
  // waits to support it. The distance between the two lines is the reason this
  // chart exists: the sign says one thing, the queue does another.
  const act = (actual || []).filter((a) => a.hour >= h0 && a.hour <= h1);
  const hasActual = act.length >= 3;
  const actLine = hasActual
    ? `<path d="${act.map((a, i) => `${i ? 'L' : 'M'}${x(a.hour).toFixed(1)} ${y(a.actual).toFixed(1)}`).join(' ')}" fill="none" stroke="var(--gold)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`
      + act.map((a) => `<circle cx="${x(a.hour).toFixed(1)}" cy="${y(a.actual).toFixed(1)}" r="9" fill="transparent"><title>${hourLabel(a.hour)} — actually waited about ${a.actual} min${a.posted != null ? `, sign said ${a.posted}` : ''} (${a.n} report${a.n === 1 ? '' : 's'})</title></circle>`).join('')
    : '';
  // Two series means a legend, always. Identity must never be colour alone.
  const legend = hasActual
    ? `<g class="cv-leg"><rect x="${ML + 6}" y="${MT + 6}" width="10" height="2.5" rx="1.2" fill="var(--brand)"/><text x="${ML + 21}" y="${MT + 12}" class="cv-lg">Posted on the sign</text>`
      + `<rect x="${ML + 6}" y="${MT + 22}" width="10" height="2.5" rx="1.2" fill="var(--gold)"/><text x="${ML + 21}" y="${MT + 28}" class="cv-lg">Actually waited</text></g>`
    : '';

  const gapNote = (() => {
    if (!hasActual) return '';
    const paired = act.filter((a) => a.delta != null);
    if (paired.length < 3) return '';
    const deltas = paired.map((a) => a.delta).sort((p1, p2) => p1 - p2);
    const mid = deltas[deltas.length >> 1];
    if (mid === 0) return ' Reported waits are matching the posted figure almost exactly.';
    const dir = mid < 0 ? 'shorter than' : 'longer than';
    return ` Across ${paired.length} hours, visitors report waiting about <b>${Math.abs(mid)} minutes ${dir}</b> the posted figure.`;
  })();

  const days = LEVEL_NAMES[level];
  return `<h2 id="curve">How the wait moves through the day at ${esc(park.name)}</h2>
<p>Median posted wait across the rides we track, on <b>${days.toLowerCase()}</b> days &mdash; the crowd level most visitors get. The shaded band is the middle half of readings at that hour.${gapNote}</p>
<figure class="cv-fig">
<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Hourly posted wait curve for ${esc(park.name)} on ${days.toLowerCase()} days, peaking at ${peak.median} minutes around ${hourLabel(peak.hour)}." class="cv-svg">
  ${grid}${evMarks}
  <path d="${bandPath}" fill="var(--brand)" class="cv-band"/>
  <path d="${line}" fill="none" stroke="var(--brand)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
  ${actLine}${peakLabel}${hoverDots}${legend}${xt}
  <text x="${ML - 8}" y="${MT - 8}" text-anchor="end" class="cv-ax">min</text>
</svg>
<figcaption class="cv-cap">${hasActual
  ? 'Purple: posted standby minutes from our own recorded snapshots. Gold: what visitors report actually waiting, median per hour. Reported figures are self-submitted and shown only where enough people have reported.'
  : 'Posted standby minutes, from our own recorded snapshots. Posted waits are what the park displays &mdash; not necessarily how long you stand there.'}
<span class="cv-dl"><a href="/api/curve/${park.slug}.csv" download>Download CSV</a> &middot; <a href="#" data-cv-png>Save PNG</a> &middot; <a href="#" data-cv-share>Share</a></span></figcaption>
</figure>`;
}

// The wait-by-crowd-level table. This is the page's most linkable asset: it
// converts a bare "45 min" into "45 is bad for a Tuesday here". Rendered only
// when there are enough recorded days -- an empty or half-filled table would
// misrepresent how much we actually know.
function bandsTable(park, bands) {
  if (!bands || !bands.length) return '';
  const LEVELS = [1, 2, 3, 4, 5];
  const NAMES = { 1: 'Light', 2: 'Mild', 3: 'Moderate', 4: 'Busy', 5: 'Packed' };
  const shown = bands.slice(0, 18);
  // Only print columns that some ride actually has data for; a column of
  // dashes reads as a broken table rather than as an honest gap.
  const cols = LEVELS.filter((l) => shown.some((r) => r.levels[l]));
  if (!cols.length) return '';
  const rows = shown.map((r) => `<tr><th scope="row">${esc(r.name)}</th>` + cols.map((l) => {
    const c = r.levels[l];
    return c ? `<td><b>${c.low}&ndash;${c.high}</b><span class="bt-typ">${c.typical} typical</span></td>`
             : '<td class="bt-none">&mdash;</td>';
  }).join('') + '</tr>').join('');
  const days = Math.max(...shown.flatMap((r) => Object.values(r.levels).map((c) => c.days)));
  return `<h2 id="bands">What counts as a normal wait at ${esc(park.name)}</h2>
<p>Every wait we have recorded here, grouped by how busy the day turned out to be. The bold figure is the middle half of what we saw &mdash; a quarter of the time it was shorter, a quarter of the time longer. Read it against today&rsquo;s crowd level to know whether the number on the sign is good or bad.</p>
<div class="bt-wrap"><table class="bandtable">
<thead><tr><th scope="col">Ride</th>${cols.map((l) => `<th scope="col">${NAMES[l]}<span class="bt-lvl">level ${l}</span></th>`).join('')}</tr></thead>
<tbody>${rows}</tbody>
</table></div>
<p class="bt-note">Minutes of posted standby wait, from our own recorded snapshots &mdash; up to ${days} day${days === 1 ? '' : 's'} per figure. Cells stay blank until a ride has enough observations at that crowd level to be worth printing. Posted waits are what the park displays, which is not always what you queue.</p>`;
}

function renderParkPage(park, sample, allParks, bands, curves, actual) {
  const seo = SEO[park.slug];
  // A park without authored content still gets a working page rather than a 500.
  if (!seo) return renderBasicParkPage(park, sample, allParks);

  const name = passName(park);
  const title = seo.worth === 'none'
    ? `${park.name} Wait Times: Live Queues, Rope Drop Order & Best Months`
    : `${park.name} Wait Times & Is ${name} Worth It? (Live Queues + Rope Drop)`;
  const desc = `Live ${park.name} wait times, hour-by-hour queue patterns, the best and worst months to visit, what to ride first, and a straight answer on whether ${seo.worth === 'none' ? 'you can skip the lines' : name + ' is worth it'}.`;

  const waitsRows = sample
    ? sample.rides.map((r) => `<tr><td>${esc(r.name)}</td><td><span class="w ${waitClass(r.wait)}">${r.wait} min</span></td></tr>`).join('')
    : '';
  const waitsSection = sample
    ? `<h2 id="typical">Typical waits by ride at ${esc(park.name)}</h2>
<div class="card"><table><tr><th>Attraction</th><th>Typical midday wait</th></tr>${waitsRows}</table>
<p class="legend">Typical midday standby waits on a moderate day. <a href="/app">See today's live waits &rarr;</a></p></div>`
    : '';

  const showLine = park.show
    ? `The headline evening show is <strong>${esc(park.show.name)}</strong>, typically around ${hour12(park.show.hour)} — ride headliners while the crowds watch it and waits drop 30–50%.`
    : 'There is no headline evening show, so the final operating hour is usually the quietest time to ride.';

  const siblings = allParks.filter((p) => p.group === park.group && p.slug !== park.slug);
  const sibSection = siblings.length
    ? `<h2 id="resort">Other parks at ${esc(park.group)}</h2>
<div class="card"><p>Planning more than one day? These share the resort — and usually the crowd calendar.</p>
<div class="sibs">${siblings.map((p) => `<a href="/parks/${p.slug}">${esc(p.name)} wait times &rarr;</a>`).join('')}</div></div>`
    : '';

  const nearby = allParks
    .filter((p) => p.region === park.region && p.group !== park.group)
    .slice(0, 8);
  const nearbySection = nearby.length
    ? `<h2 id="nearby">More parks in ${esc(park.region)}</h2>
<div class="sibs">${nearby.map((p) => `<a href="/parks/${p.slug}">${esc(p.name)}</a>`).join('')}</div>`
    : '';

  const faq = faqSection(park, seo);

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | ParkPulse</title>
<meta name="description" content="${esc(desc)}">
<link rel="icon" href="/icon.svg" type="image/svg+xml"><meta name="theme-color" content="#2c2154">
<link rel="canonical" href="https://www.parkpulse.fun/parks/${park.slug}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="https://www.parkpulse.fun/og.png">
<meta property="og:url" content="https://www.parkpulse.fun/parks/${park.slug}">
<meta property="og:type" content="article">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${jsonLd(park, faq.qa)}</script>
<style>${CSS}</style></head><body><div class="wrap">
<nav><a class="logo" href="/"><img src="/icon.svg" alt="" width="22" height="22" style="vertical-align:-4px;margin-right:.2rem"> ParkPulse</a><span><a class="plain" href="/app">Live waits</a><a class="plain" href="/parks">All parks</a><a class="plain" href="/guide">Guide</a></span></nav>
<h1>${esc(park.name)} Wait Times &amp; Strategy</h1>
<p class="sub">${esc(park.group)} &middot; ${esc(park.region)} &middot; typical hours ${hour12(park.open)}&ndash;${hour12(park.close)}</p>
<div class="card"><p><strong>The one-minute version:</strong> be at the gate 30–45 minutes before opening and ride <strong>${esc(seo.drop[0])}</strong> first. Waits peak from late morning to mid-afternoon — do shows and meals then. The final hour is often as quiet as rope drop. ${showLine}</p>
<p><strong>${VERDICT_LABEL[seo.worth]}:</strong> ${esc(seo.verdict.split('. ')[0])}.</p>
<a class="cta" href="/app">See today's live waits free</a></div>
${curveSection(park, seo)}
${dropSection(park, seo)}
${monthsSection(park, seo)}
${passSection(park, seo)}
${waitsSection}
<h2 id="free">Beat the lines without paying at ${esc(park.name)}</h2>
<div class="card"><ul>
<li><strong>Rope drop:</strong> at the gate 30–45 minutes early, straight to ${esc(seo.drop[0])}.</li>
<li><strong>The last hour:</strong> often the day's shortest waits — if you are in line at close, you ride.</li>
<li><strong>Show windows:</strong> ${park.show ? `during ${esc(park.show.name)}, major attractions quietly shrink` : 'evening hours thin out steadily after dinner'}.</li>
<li><strong>Live data:</strong> a wait 15+ minutes below its typical level is a "go now" signal — ParkPulse flags these automatically.</li>
</ul>
<div class="tip"><strong>Local knowledge:</strong> ${esc(seo.tip)}</div>
</div>
${curveChart(park, curves, actual)}
${bandsTable(park, bands)}
${faq.html}
${sibSection}
${nearbySection}
<h2 id="all">All parks we track</h2>
<div class="allparks">${allParksIndex(allParks, park.slug)}</div>
<footer>Unofficial fan guide &mdash; not affiliated with the park operators. Prices, hours and ride line-ups change; verify with the operator before you buy. Live wait-time data powered by <a href="https://queue-times.com" rel="nofollow">Queue-Times.com</a>. <a href="/">ParkPulse home</a> &middot; <a href="/parks">All parks</a> &middot; <a href="/guide">Free strategy guide</a> &middot; <a href="/terms">Terms</a> &middot; <a href="/privacy">Privacy</a></footer>
</div><script>
(function(){
  var fig = document.querySelector('.cv-fig'); if (!fig) return;
  var svg = fig.querySelector('svg');
  fig.addEventListener('click', function (ev) {
    var png = ev.target.closest('[data-cv-png]'), share = ev.target.closest('[data-cv-share]');
    if (!png && !share) return;
    ev.preventDefault();
    if (share) {
      var url = location.origin + location.pathname + '#curve';
      var title = document.title;
      if (navigator.share) { navigator.share({ title: title, url: url }).catch(function(){}); return; }
      // Clipboard needs a secure context; fall back to showing the link.
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(url).then(function () { share.textContent = 'Link copied'; setTimeout(function(){ share.textContent = 'Share'; }, 2000); });
      } else { prompt('Copy this link:', url); }
      return;
    }
    // Rasterise at 2x so the saved file is usable in a slide or a post. The SVG
    // is serialised with its computed colours inlined, because the exported file
    // has no page stylesheet to inherit var(--brand) from.
    var clone = svg.cloneNode(true), cs = getComputedStyle(document.body);
    var vars = ['--brand','--ink','--muted','--border','--card','--bg'];
    var map = {}; vars.forEach(function(v){ map[v] = cs.getPropertyValue(v).trim(); });
    clone.querySelectorAll('*').forEach(function (n) {
      ['fill','stroke'].forEach(function (a) {
        var val = n.getAttribute(a);
        if (val && val.indexOf('var(') === 0) n.setAttribute(a, map[val.slice(4, -1).trim()] || '#5b3df5');
      });
    });
    // Every rule the SVG relies on has to be carried into the export. The
    // interquartile band's opacity is one of them: without it the band renders
    // solid in the saved file and buries the line it is meant to sit behind.
    var bandEl = svg.querySelector('.cv-band');
    var bandOp = bandEl ? getComputedStyle(bandEl).opacity : '0.13';
    var css = '.cv-band{opacity:' + bandOp + '}'
      + '.cv-ax{fill:' + map['--muted'] + ';font-size:11px}'
      + '.cv-ev{fill:' + map['--muted'] + ';font-size:10.5px;font-weight:600}'
      + '.cv-peak{fill:' + map['--ink'] + ';font-size:11.5px;font-weight:700}';
    var st = document.createElementNS('http://www.w3.org/2000/svg','style'); st.textContent = css; clone.insertBefore(st, clone.firstChild);
    clone.setAttribute('xmlns','http://www.w3.org/2000/svg');
    var vb = svg.getAttribute('viewBox').split(' ').map(Number), scale = 2;
    var img = new Image();
    img.onload = function () {
      var c = document.createElement('canvas');
      c.width = vb[2] * scale; c.height = vb[3] * scale;
      var g = c.getContext('2d');
      g.fillStyle = map['--card'] || '#fff'; g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0, c.width, c.height);
      var a = document.createElement('a');
      a.download = location.pathname.split('/').pop() + '-wait-curve.png';
      a.href = c.toDataURL('image/png'); a.click();
    };
    img.onerror = function () { alert('Could not build the image here — the CSV download has the same numbers.'); };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(clone));
  });
})();
</script><script src="/i18n.js"></script><script src="/chat-widget.js" data-park="${park.slug}" data-park-name="${esc(park.name)}" defer></script></body></html>`;
}

// Fallback for a park in the registry that has no authored content yet.
function renderBasicParkPage(park, sample, allParks) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(park.name)} Wait Times | ParkPulse</title>
<meta name="description" content="Live ${esc(park.name)} wait times, updated continuously.">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="canonical" href="https://www.parkpulse.fun/parks/${park.slug}">
<style>${CSS}</style></head><body><div class="wrap">
<nav><a class="logo" href="/">ParkPulse</a><span><a class="plain" href="/app">Live waits</a><a class="plain" href="/parks">All parks</a></span></nav>
<h1>${esc(park.name)} Wait Times</h1>
<p class="sub">${esc(park.group)} &middot; typical hours ${hour12(park.open)}&ndash;${hour12(park.close)}</p>
<div class="card"><p>ParkPulse tracks live standby waits for every attraction at ${esc(park.name)}.</p><a class="cta" href="/app">See live waits</a></div>
<h2>All parks we track</h2><div class="allparks">${allParksIndex(allParks, park.slug)}</div>
<footer>Unofficial fan guide. Wait-time data powered by <a href="https://queue-times.com" rel="nofollow">Queue-Times.com</a>. <a href="/">Home</a></footer>
</div></body></html>`;
}

// /parks — the hub every park page links back to, so crawlers reach all 56
// from any entry point in two clicks.
function renderParksIndex(allParks) {
  const order = ['Florida', 'California', 'US & Canada', 'Europe', 'Asia'];
  const byRegion = {};
  for (const p of allParks) (byRegion[p.region] || (byRegion[p.region] = [])).push(p);
  const regions = [...order.filter((r) => byRegion[r]), ...Object.keys(byRegion).filter((r) => !order.includes(r))];
  const sections = regions.map((r) => {
    const cards = byRegion[r].slice().sort((a, b) => a.name.localeCompare(b.name)).map((p) => {
      const seo = SEO[p.slug];
      const line = seo ? `${VERDICT_LABEL[seo.worth]} · ${esc(passName(p))}` : 'Live wait times';
      return `<a href="/parks/${p.slug}" style="display:block;text-decoration:none;color:inherit;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:.75rem 1rem;margin:.4rem 0">
<strong>${esc(p.name)} wait times</strong><br><span style="color:var(--muted);font-size:.85rem">${esc(p.group)} &middot; ${line}</span></a>`;
    }).join('');
    return `<h2>${esc(r)}</h2>${cards}`;
  }).join('');

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Theme Park Wait Times: All ${allParks.length} Parks | ParkPulse</title>
<meta name="description" content="Live wait times, rope drop orders, best months and skip-the-line verdicts for ${allParks.length} theme parks across the US, Europe and Asia.">
<link rel="icon" href="/icon.svg" type="image/svg+xml"><meta name="theme-color" content="#2c2154">
<link rel="canonical" href="https://www.parkpulse.fun/parks">
<meta property="og:title" content="Theme Park Wait Times: All ${allParks.length} Parks | ParkPulse">
<meta property="og:description" content="Live wait times, rope drop orders and skip-the-line verdicts for ${allParks.length} parks.">
<meta property="og:image" content="https://www.parkpulse.fun/og.png">
<style>${CSS}</style></head><body><div class="wrap">
<nav><a class="logo" href="/"><img src="/icon.svg" alt="" width="22" height="22" style="vertical-align:-4px;margin-right:.2rem"> ParkPulse</a><span><a class="plain" href="/app">Live waits</a><a class="plain" href="/guide">Guide</a></span></nav>
<h1>Theme park wait times — all ${allParks.length} parks</h1>
<p class="sub">Hour-by-hour queue patterns, rope drop orders, best and worst months, and a straight answer on whether the skip-the-line pass is worth it.</p>
${sections}
<footer>Unofficial fan guide &mdash; not affiliated with the park operators. Live wait-time data powered by <a href="https://queue-times.com" rel="nofollow">Queue-Times.com</a>. <a href="/">ParkPulse home</a> &middot; <a href="/guide">Free strategy guide</a> &middot; <a href="/terms">Terms</a> &middot; <a href="/privacy">Privacy</a></footer>
</div></body></html>`;
}

// Structured data: what the place is, where it is, how the page sits in the
// site, and the FAQ block that can win its own result. Escaped against
// </script> breakout.
function jsonLd(park, qa) {
  const data = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'ParkPulse', item: 'https://www.parkpulse.fun/' },
          { '@type': 'ListItem', position: 2, name: 'Parks', item: 'https://www.parkpulse.fun/parks' },
          { '@type': 'ListItem', position: 3, name: `${park.name} Wait Times`, item: `https://www.parkpulse.fun/parks/${park.slug}` },
        ],
      },
      {
        '@type': 'TouristAttraction',
        name: park.name,
        url: `https://www.parkpulse.fun/parks/${park.slug}`,
        ...(park.lat && park.lng ? { geo: { '@type': 'GeoCoordinates', latitude: park.lat, longitude: park.lng } } : {}),
        isPartOf: { '@type': 'Organization', name: park.group },
      },
      ...(qa && qa.length ? [{
        '@type': 'FAQPage',
        mainEntity: qa.map(([q, a]) => ({
          '@type': 'Question',
          name: q,
          acceptedAnswer: { '@type': 'Answer', text: a },
        })),
      }] : []),
    ],
  };
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

const renderSitemap = (origin, slugs) => {
  const today = new Date().toISOString().slice(0, 10);
  const entries = [
    { p: '', pri: '1.0' },
    { p: '/app', pri: '0.9' },
    { p: '/parks', pri: '0.9' },
    { p: '/guide', pri: '0.8' },
    ...slugs.map((s) => ({ p: `/parks/${s}`, pri: '0.8' })),
    { p: '/terms', pri: '0.3' },
    { p: '/privacy', pri: '0.3' },
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.map((e) => `  <url><loc>${origin}${e.p}</loc><lastmod>${today}</lastmod><priority>${e.pri}</priority></url>`).join('\n')}
</urlset>`;
};

const renderRobots = (origin) => `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`;

module.exports = { renderParkPage, renderParksIndex, renderSitemap, renderRobots, allParksIndex };
