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
  /* On a phone the flex row squeezed the link group until "All parks" broke
     across two lines with the logo. Each label is now unbreakable and the row
     wraps as a whole instead. */
  nav{display:flex;justify-content:space-between;align-items:center;padding:.5rem 0 1.5rem;flex-wrap:wrap;gap:.35rem 1rem}
  .logo{font-weight:800;font-size:1.15rem;color:var(--brand);text-decoration:none;white-space:nowrap}
  nav>span{display:flex;flex-wrap:wrap;align-items:center;gap:0 1rem}
  nav a.plain{color:var(--ink);text-decoration:none;font-weight:500;white-space:nowrap}
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
  .months{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:3px;margin:.5rem 0 .25rem}
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
  .calcta{background:var(--card);border:1px solid var(--border);border-left:3px solid var(--brand);border-radius:12px;padding:.7rem .9rem;font-size:.94rem;margin:1.2rem 0}
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
  /* Twelve month names on a phone: a grid track can't shrink past its
     item's min-content width, so "Dec" pushed the whole page sideways.
     Shrink the type instead of letting the year run off the screen. */
  @media (max-width:430px){ .months{gap:2px} .months div{font-size:.56rem;padding:.45rem 0;letter-spacing:-.03em} }
`;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Mila hovering in the corner of the public wait-times and touring-plan
// pages, offering the pass. Twelve rotating lines; pass holders (pp-pass in
// localStorage) never see her, and a dismiss lasts the browsing session.
const MILA_HOVER_MSGS = [
  'This is just a sprinkle ✨ With a pass you get the whole spell — live waits, unlimited plans, and me by your side all day.',
  'Want this day to be even more magical? ✨ My wand never runs out with a pass — every park, every plan, me all day.',
  "I know a shortcut past every line here ✨ Grab a pass and let's make some magic — from $24.99.",
  "I can dodge every queue and stay with you till the fireworks ✨ Get a pass and let's go!",
  'Second star to the right, straight past the queues ✨ A pass unlocks every park — shall we fly?',
  "The lines don't know I exist ✨ With a pass, neither will you — unlimited plans, all 65 parks.",
  "I read the queues like a storybook ✨ Get a pass and I'll read yours all day long.",
  "One pass, every kingdom ✨ I'll plan each day to the minute — you just bring the snacks.",
  'Believe in magic? I run on data ✨ A pass gives you both, all day, in every park.',
  'Your feet will thank me, your kids will high-five you ✨ Passes start at $24.99.',
  'I saved families whole hours of queueing today ✨ Want yours back too? A pass makes it official.',
  'Why wait in line when you can walk with a fairy? ✨ Unlock every park with a pass.',
];

function milaHover() {
  return `<style>
  .mh{position:fixed;right:14px;bottom:14px;z-index:60;display:flex;flex-direction:column;align-items:flex-end;gap:8px;opacity:0;transform:translateY(8px);transition:opacity .5s,transform .5s;pointer-events:none}
  .mh.on{opacity:1;transform:none;pointer-events:auto}
  .mh-b{position:relative;background:var(--card);border:1px solid var(--border);border-radius:14px;padding:.7rem 1.9rem .7rem .9rem;max-width:250px;font-size:.88rem;line-height:1.45;box-shadow:0 12px 32px -12px rgba(0,0,0,.35)}
  .mh-b b{display:block;font-size:.68rem;letter-spacing:.08em;text-transform:uppercase;color:var(--brand);margin-bottom:.15rem}
  #mh-msg{transition:opacity .35s}
  .mh-x{position:absolute;top:.3rem;right:.4rem;border:none;background:none;color:var(--muted);font-size:1rem;cursor:pointer;padding:.15rem;line-height:1}
  .mh-cta{display:inline-block;margin-top:.45rem;background:var(--brand);color:#fff;border-radius:999px;padding:.35rem .9rem;font-weight:700;font-size:.82rem;text-decoration:none}
  .mh img{width:62px;height:62px;border-radius:50%;border:2px solid var(--brand);box-shadow:0 10px 26px -10px rgba(0,0,0,.5);animation:mhfloat 5s ease-in-out infinite}
  @keyframes mhfloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
  @media (prefers-reduced-motion:reduce){.mh img{animation:none}.mh{transition:none}}
  @media (max-width:480px){.mh-b{max-width:210px;font-size:.84rem}.mh img{width:52px;height:52px}}
</style>
<div class="mh" id="mh" role="complementary" aria-label="Mila suggests a ParkPulse pass">
  <div class="mh-b"><button class="mh-x" id="mh-x" aria-label="Dismiss Mila's suggestion">×</button><b>Mila · your park fairy</b><span id="mh-msg"></span><br><a class="mh-cta" href="/app?join=pass">Get a pass ✨</a></div>
  <img src="/img/mila/mila-wink-160.webp" alt="" width="62" height="62" loading="lazy">
</div>
<script>
(function(){
  try { if (localStorage.getItem('pp-pass')) return; } catch (e) {}
  try { if (sessionStorage.getItem('pp-mh-x')) return; } catch (e) {}
  var M = ${JSON.stringify(MILA_HOVER_MSGS)};
  var el = document.getElementById('mh'), msg = document.getElementById('mh-msg');
  if (!el || !msg) return;
  // These lines were injected raw, so Mila kept her sales pitch in English on
  // a page the visitor was reading in their own language. Not every page that
  // shows her loads i18n.js, so pull it in when it is missing.
  if (!window.PP_T && !document.querySelector('script[src="/i18n.js"]')) {
    var s = document.createElement('script'); s.src = '/i18n.js'; document.head.appendChild(s);
  }
  var T = function (k) { return (window.PP_T && window.PP_T(k)) || k; };
  var i = Math.floor(Math.random() * M.length);
  // She appears after 2.2s either way, which is ample for the dictionary to
  // land; awaiting PP_READY as well covers a slow network.
  setTimeout(function(){
    Promise.resolve(window.PP_READY).then(function(){
      msg.textContent = T(M[i]);
      el.classList.add('on');
    });
  }, 2200);
  setInterval(function(){
    i = (i + 1) % M.length;
    msg.style.opacity = 0;
    setTimeout(function(){ msg.textContent = T(M[i]); msg.style.opacity = 1; }, 350);
  }, 14000);
  document.getElementById('mh-x').addEventListener('click', function(){
    el.classList.remove('on');
    try { sessionStorage.setItem('pp-mh-x', '1'); } catch (e) {}
  });
})();
</script>`;
}
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
<p>ParkPulse shows every wait live with a "vs typical" marker, and your magical fairy will run the numbers for your party and date — including telling you to keep your money when the answer is no.</p>
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

// What's closed right now, straight from the feed. The competitors keep a
// hand-maintained refurbishment page for a handful of parks and it goes stale;
// this is generated for every park and dated so the reader can judge its freshness.
function closureSection(park, closures) {
  const current = (closures?.rides || []).filter((r) => r.current);
  const reopened = (closures?.rides || []).filter((r) => !r.current).slice(0, 6);
  if (!closures) {
    return `<h2 id="closed">What's closed at ${esc(park.name)}</h2>
<div class="card"><p>We detect long closures automatically from the live feed — a ride reporting closed all day, for three operating days running, is down for something structural. This park's archive is still filling; the list appears here as soon as there is enough history to be sure.</p></div>`;
  }
  const pretty = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const row = (r) => `<tr><td><b>${esc(r.name)}</b></td><td>${pretty(r.since)}</td><td class="cl-days">${r.days} operating day${r.days === 1 ? '' : 's'}</td></tr>`;
  return `<h2 id="closed">What's closed at ${esc(park.name)}</h2>
<div class="card">
${current.length
    ? `<p class="legend">Detected automatically from the live feed — each of these reported closed all day, every day, for at least three operating days. Observed through ${pretty(closures.observedTo)}.</p>
<div class="acc-scroll"><table class="acc-table"><thead><tr><th>Attraction</th><th>Closed since</th><th>Duration</th></tr></thead><tbody>${current.map(row).join('')}</tbody></table></div>`
    : `<p><b>Nothing is down long-term right now.</b> Every attraction we track at ${esc(park.name)} has reported open at some point in the last few days. Observed through ${pretty(closures.observedTo)}.</p>`}
${reopened.length ? `<h3>Recently back</h3><div class="acc-scroll"><table class="acc-table"><thead><tr><th>Attraction</th><th>Was closed from</th><th>Duration</th></tr></thead><tbody>${reopened.map(row).join('')}</tbody></table></div>` : ''}
<p class="legend">Generated from wait-feed observations, not an operator announcement: a long closure usually means refurbishment, but we report what the feed shows rather than guessing why. Always check the operator's own page before travelling for one specific ride.</p>
</div>`;
}

function renderParkPage(park, sample, allParks, bands, curves, actual, closures) {
  const seo = SEO[park.slug];
  // A park without authored content still gets a working page rather than a 500.
  if (!seo) return renderBasicParkPage(park, sample, allParks);

  const name = passName(park);
  const title = seo.worth === 'none'
    ? `${park.name} Wait Times: Live Queues, Rope Drop Order & Best Months`
    : `${park.name} Wait Times & Is ${name} Worth It? (Live Queues + Rope Drop)`;
  const desc = `Live ${park.name} wait times, hour-by-hour queue patterns, the best and worst months to visit, what to ride first, and a straight answer on whether ${seo.worth === 'none' ? 'you can skip the lines' : name + ' is worth it'}. Plus free ready-made ${park.name} touring plans.`;

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
<a class="cta" href="/app">See today's live waits free</a> <a class="cta" href="/plans/${park.slug}" style="background:var(--bg);color:var(--brand);border:1.5px solid var(--brand)">Ready-made touring plans</a></div>
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
<p class="calcta">Planning ahead? The free <a href="/parks/${park.slug}/calendar"><b>${esc(park.name)} crowd calendar</b></a> scores every day for the next four months, 1 to 10 &mdash; no sign-up.</p>
${curveChart(park, curves, actual)}
${closureSection(park, closures)}
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
</script>${milaHover()}<script src="/i18n.js"></script><script src="/chat-widget.js" data-park="${park.slug}" data-park-name="${esc(park.name)}" defer></script></body></html>`;
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
</div>${milaHover()}</body></html>`;
}

// /parks — the hub every park page links back to, so crawlers reach every park
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

// The accuracy scoreboard: the site saying in public how close its own
// predictions land. Server-rendered from the walk-forward backtest; the table
// IS the chart -- every percentage is printed as text with a single-hue meter
// beside it, so nothing is color-alone and there is nothing to hover for.
function renderAccuracyPage(acc, parks) {
  const pct = (v) => `${Math.round(v * 100)}%`;
  const hourLabel = (h) => `${((h + 11) % 12) + 1}${h < 12 ? 'am' : 'pm'}`;
  const meter = (v) => `<span class="acc-meter" aria-hidden="true"><i style="width:${Math.max(2, Math.round(v * 100))}%"></i></span>`;
  const MIN_CELL = 30;

  let body;
  let headline = 'How accurate are our wait-time predictions?';
  let desc = 'ParkPulse publishes its own report card: how close our crowd-model predictions land against the wait times parks actually posted.';
  if (!acc) {
    body = `<div class="card"><h2>The scoreboard is accruing</h2>
<p>This page scores our predictions against what really happened, and it refuses to invent a number before there is enough recorded history to compute an honest one. Every prediction is scored strictly walk-forward &mdash; made only from data available before the day it predicts &mdash; so the first scores appear once the archive holds a couple of weeks of snapshots.</p>
<p>No cherry-picking is possible by construction: the scoreboard recomputes from the full archive every few hours, embarrassing days included.</p></div>`;
  } else {
    const morning = acc.byHour.filter((h) => h.hour >= 8 && h.hour <= 11 && h.n >= MIN_CELL)
      .sort((a, b) => b.within10 - a.within10)[0];
    if (morning) headline = `Our ${hourLabel(morning.hour)} predictions landed within 10 minutes ${pct(morning.within10)} of the time`;
    desc = `Scored over the last ${acc.scoredDays} days: median error ${acc.overall.medAbs} min across ${acc.overall.n.toLocaleString('en-US')} predictions, all scored walk-forward against posted waits.`;

    const tiles = `<div class="acc-tiles">
  <div class="acc-tile"><b>${acc.overall.n.toLocaleString('en-US')}</b><span>predictions scored</span></div>
  <div class="acc-tile"><b>${acc.overall.medAbs} min</b><span>median error</span></div>
  <div class="acc-tile"><b>${pct(acc.overall.within10)}</b><span>within 10 minutes</span></div>
  <div class="acc-tile"><b>${acc.overall.medSigned > 0 ? '+' : ''}${acc.overall.medSigned} min</b><span>median bias (${acc.overall.medSigned > 0 ? 'we run high' : acc.overall.medSigned < 0 ? 'we run low' : 'centered'})</span></div>
</div>`;

    const hourRows = acc.byHour.filter((h) => h.n >= MIN_CELL).map((h) => `<tr>
  <td>${hourLabel(h.hour)}</td><td>${pct(h.within5)}</td>
  <td>${pct(h.within10)} ${meter(h.within10)}</td>
  <td>${pct(h.within15)}</td><td>${h.medAbs} min</td><td class="acc-n">${h.n.toLocaleString('en-US')}</td>
</tr>`).join('');

    const parkRows = acc.byPark.filter((r) => r.n >= MIN_CELL && parks[r.slug]).slice(0, 15).map((r) => `<tr>
  <td><a href="/parks/${r.slug}">${esc(parks[r.slug].name)}</a></td>
  <td>${pct(r.within10)} ${meter(r.within10)}</td>
  <td>${r.medAbs} min</td><td class="acc-n">${r.n.toLocaleString('en-US')}</td>
</tr>`).join('');

    body = `${tiles}
<div class="card"><h2>By hour of day</h2>
<p class="legend">How often the prediction for a ride landed within 5, 10 and 15 minutes of the posted wait, by park-local hour. Hours with under ${MIN_CELL} scored predictions are withheld rather than shown from noise.</p>
<div class="acc-scroll"><table class="acc-table"><thead><tr><th>Hour</th><th>&le;5 min</th><th>&le;10 min</th><th>&le;15 min</th><th>Median error</th><th>n</th></tr></thead>
<tbody>${hourRows}</tbody></table></div></div>
${parkRows ? `<div class="card"><h2>By park</h2>
<div class="acc-scroll"><table class="acc-table"><thead><tr><th>Park</th><th>&le;10 min</th><th>Median error</th><th>n</th></tr></thead>
<tbody>${parkRows}</tbody></table></div></div>` : ''}
<p class="legend">Window: ${esc(acc.from || '')} to ${esc(acc.to)} &middot; recomputed every few hours &middot; generated ${esc(acc.generatedAt.slice(0, 10))}</p>`;
  }

  const method = `<div class="card"><h2>How this is measured &mdash; and how it can't be gamed</h2>
<p><b>Walk-forward, no exceptions.</b> Each day is scored using only baselines and day-of-week factors built from the days before it &mdash; the numbers the model would genuinely have shown you. A prediction never sees its own day.</p>
<p><b>One prediction per ride per hour per day.</b> The hour's "actual" is the median of that hour's recorded snapshots. We do not score every polling tick, because that would let the sampling rate inflate the sample size.</p>
<p><b>Scored against posted waits.</b> The model predicts the wait the park will post, so that is what it is scored against. Visitor-reported actual waits are a separate dataset with its own page per ride.</p>
<p><b>Only predictions the model was ready to make.</b> A ride is scored once it has enough prior snapshots to carry a baseline &mdash; the same bar the product itself uses before showing a typical wait.</p>
<p><b>Everything counts.</b> The page recomputes from the complete archive on a timer. There is no mechanism for leaving a bad day out.</p></div>`;

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Prediction Accuracy | ParkPulse</title>
<meta name="description" content="${esc(desc)}">
<link rel="icon" href="/icon.svg" type="image/svg+xml"><meta name="theme-color" content="#2c2154">
<link rel="canonical" href="https://www.parkpulse.fun/accuracy">
<meta property="og:title" content="ParkPulse Prediction Accuracy">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="https://www.parkpulse.fun/og.png">
<style>${CSS}
  .acc-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:.6rem;margin:1rem 0}
  .acc-tile{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:.9rem .8rem;text-align:center}
  .acc-tile b{display:block;font-size:1.5rem;color:var(--ink)}
  .acc-tile span{font-size:.78rem;color:var(--muted)}
  .acc-scroll{overflow-x:auto}
  .acc-table{width:100%;border-collapse:collapse;font-size:.88rem}
  .acc-table th{text-align:left;color:var(--muted);font-size:.72rem;text-transform:uppercase;letter-spacing:.04em;padding:.35rem .5rem;border-bottom:1px solid var(--border)}
  .acc-table td{padding:.4rem .5rem;border-bottom:1px solid var(--border);white-space:nowrap}
  .acc-n{color:var(--muted)}
  .cl-days{color:var(--muted);white-space:nowrap}
  .acc-meter{display:inline-block;vertical-align:middle;width:72px;height:6px;margin-left:.4rem;background:var(--border);border-radius:3px;overflow:hidden}
  .acc-meter i{display:block;height:100%;background:var(--brand);border-radius:3px}
</style></head><body><div class="wrap">
<nav><a class="logo" href="/"><img src="/icon.svg" alt="" width="22" height="22" style="vertical-align:-4px;margin-right:.2rem"> ParkPulse</a><span><a class="plain" href="/app">Live waits</a><a class="plain" href="/parks">Parks</a><a class="plain" href="/guide">Guide</a></span></nav>
<h1>${esc(headline)}</h1>
<p class="sub">Most wait-time apps ask you to trust them. We publish the scoreboard instead &mdash; recomputed from our own archive on a timer, bad days included.</p>
${body}
${method}
<footer>Unofficial fan guide &mdash; not affiliated with the park operators. Live wait-time data powered by <a href="https://queue-times.com" rel="nofollow">Queue-Times.com</a>. <a href="/">ParkPulse home</a> &middot; <a href="/parks">All parks</a> &middot; <a href="/terms">Terms</a> &middot; <a href="/privacy">Privacy</a></footer>
</div></body></html>`;
}

// A wrong URL is a marketing moment too: sad Mila, a one-liner, and the two
// links that recover the visit. noindex -- error pages must never rank.
function renderNotFoundPage() {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Page not found | ParkPulse</title>
<meta name="robots" content="noindex">
<link rel="icon" href="/icon.svg" type="image/svg+xml"><meta name="theme-color" content="#2c2154">
<style>${CSS}
  .nf{max-width:430px;margin:8vh auto 0;text-align:center;padding:0 1rem}
  .nf img{width:150px;height:150px;border-radius:50%;border:4px solid var(--border)}
  .nf h1{margin:.9rem 0 .3rem}
  .nf p{color:var(--muted);margin:0 0 1.2rem}
  .nf .btns{display:flex;gap:.6rem;justify-content:center;flex-wrap:wrap}
  .nf a.b{display:inline-block;background:var(--brand);color:#fff;font-weight:800;padding:.65rem 1.3rem;border-radius:10px;text-decoration:none}
  .nf a.b.ghost{background:var(--card);color:var(--brand);border:1.5px solid var(--brand)}
</style></head><body><div class="wrap">
<nav><a class="logo" href="/"><img src="/icon.svg" alt="" width="22" height="22" style="vertical-align:-4px;margin-right:.2rem"> ParkPulse</a></nav>
<div class="nf">
  <img src="/img/mila/mila-sad-320.webp" alt="Mila the ParkPulse fairy, looking disappointed">
  <h1>This page doesn't exist</h1>
  <p>Mila checked twice. The queue for it is infinite, and not in the fun way.</p>
  <div class="btns"><a class="b" href="/app">Open live waits</a><a class="b ghost" href="/parks">Browse all 65 parks</a></div>
</div>
<footer style="margin-top:5rem">Unofficial fan guide &mdash; not affiliated with the park operators. <a href="/">ParkPulse home</a></footer>
</div></body></html>`;
}

const renderSitemap = (origin, slugs, planParks = []) => {
  const today = new Date().toISOString().slice(0, 10);
  const entries = [
    { p: '', pri: '1.0' },
    { p: '/app', pri: '0.9' },
    { p: '/parks', pri: '0.9' },
    { p: '/plans', pri: '0.9' },
    // The premade library: a page per park, a page per always-available
    // persona. Tag-dependent personas are linked from the park pages and
    // crawled from there, so a URL here never 404s.
    ...planParks.map((pp) => ({ p: `/plans/${pp.slug}`, pri: '0.8' })),
    ...planParks.flatMap((pp) => pp.personas.map((per) => ({ p: `/plans/${pp.slug}/${per}`, pri: '0.7' }))),
    { p: '/guide', pri: '0.8' },
    ...slugs.map((s) => ({ p: `/parks/${s}`, pri: '0.8' })),
    // The calendars are the free wedge — they should be crawled as eagerly
    // as the wait-time pages they feed.
    ...slugs.map((s) => ({ p: `/parks/${s}/calendar`, pri: '0.8' })),
    // The trust page: the public scoreboard of our own accuracy.
    { p: '/accuracy', pri: '0.7' },
    { p: '/terms', pri: '0.3' },
    { p: '/privacy', pri: '0.3' },
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.map((e) => `  <url><loc>${origin}${e.p}</loc><lastmod>${today}</lastmod><priority>${e.pri}</priority></url>`).join('\n')}
</urlset>`;
};

const renderRobots = (origin) => `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`;

// --- Crowd calendar ----------------------------------------------------------
// A month grid per park, free and indexable. The scale is 1-10 rather than the
// five named levels because the underlying factor is continuous; the levels are
// how we colour it, the score is how we number it.
function renderCalendarPage(park, days, bestByDate, allParks, origin) {
  const seo = SEO[park.slug] || null;
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const byMonth = {};
  for (const d of days) {
    const [y, m] = d.date.split('-').map(Number);
    (byMonth[`${y}-${String(m).padStart(2, '0')}`] ??= []).push(d);
  }

  const cell = (d) => {
    if (!d) return '<div class="cal-cell cal-pad"></div>';
    const day = Number(d.date.slice(8, 10));
    const bp = bestByDate && bestByDate.byDate[d.date];
    const isHere = bp && bp.slug === park.slug;
    // Two distinct reasons to send someone next door: lower crowds, or this
    // park closing early to day tickets for a confirmed hard-ticket night.
    const altWhy = bp && (bp.reason === 'hours'
      ? `${bp.name} keeps full evening hours — ${park.name} closes early for ${bp.event}`
      : `${bp.name} is lighter this day${bp.closesEarly ? ` — but closes early to day tickets for ${bp.closesEarly}` : ''}`);
    // A confirmed hard-ticket night is on the day itself, best-park or not:
    // the park closes to day tickets in the early evening. Confirmed only --
    // month-level "possible" seasons stay in the prose, not on dates.
    const hardEv = (d.events || []).find((e) => e.kind === 'hard-ticket' && e.certainty === 'confirmed');
    const title = `${d.label} — crowd ${d.score} of 10${d.holiday ? ` · ${d.holiday}` : ''}${hardEv ? ` · ${hardEv.name} — closes early to day tickets` : ''}${bp && !isHere ? ` · try ${bp.name}${bp.closesEarly ? ' (closes early that night)' : ''}` : ''}`;
    return `<div class="cal-cell l${d.level}${isHere ? ' cal-pick' : ''}" title="${esc(title)}">
      <span class="cal-d">${day}</span><span class="cal-s">${d.score}</span>
      ${hardEv ? '<span class="cal-e" aria-hidden="true">\ud83c\udf9f</span>' : d.holiday ? '<span class="cal-h" aria-hidden="true">\u2726</span>' : ''}
      ${bp && !isHere ? `<a class="cal-alt${bp.reason === 'hours' ? ' cal-alt-ev' : ''}" href="/parks/${bp.slug}/calendar" title="${esc(altWhy)}">${bp.reason === 'hours' ? '🎟 ' : ''}${esc(bp.name.split(' ')[0])}</a>` : ''}
    </div>`;
  };

  const months = Object.entries(byMonth).map(([key, list]) => {
    const [y, m] = key.split('-').map(Number);
    // Monday-first grid. getUTCDay() is 0=Sunday, so shift it.
    const firstDow = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
    const lead = Array.from({ length: firstDow }, () => null);
    const known = new Map(list.map((d) => [Number(d.date.slice(8, 10)), d]));
    const inMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    let cells = [...lead, ...Array.from({ length: inMonth }, (_, i) => known.get(i + 1) || null)];
    // The current month opens on today, so its early weeks are all padding.
    // Drop whole leading rows that carry no day at all — three and a half empty
    // rows above the first real square reads as a broken grid.
    while (cells.length > 7 && cells.slice(0, 7).every((c) => !c)) cells = cells.slice(7);
    return `<section class="cal-month"><h3>${MONTHS[m - 1]} ${y}</h3>
      <div class="cal-grid" role="table" aria-label="${MONTHS[m - 1]} ${y} crowd forecast">
        ${DOW.map((w) => `<div class="cal-w">${w}</div>`).join('')}
        ${cells.map(cell).join('')}
      </div></section>`;
  }).join('');

  const lightest = [...days].sort((a, b) => a.factor - b.factor).slice(0, 3);
  const busiest = [...days].sort((a, b) => b.factor - a.factor)[0];
  const pretty = (iso) => {
    const [y, m, dd] = iso.split('-').map(Number);
    return `${DOW[(new Date(Date.UTC(y, m - 1, dd)).getUTCDay() + 6) % 7]} ${dd} ${MONTHS[m - 1].slice(0, 3)}`;
  };

  const title = `${park.name} Crowd Calendar — Every Day Scored 1-10`;
  const desc = `Free crowd calendar for ${park.name}: every day for the next ${days.length} days scored 1 to 10, with the quietest dates and the lightest park to visit each day. No sign-up.`;
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${origin}/parks/${park.slug}/calendar">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<style>${CSS}
  .cal-lead{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:1rem 1.1rem;margin:.8rem 0 1.4rem}
  .cal-lead b{color:var(--ink)}
  .cal-month{margin:0 0 1.6rem}
  .cal-month h3{font-size:1rem;margin:0 0 .5rem}
  .cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px}
  .cal-w{font-size:.68rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:700;text-align:center;padding:.2rem 0}
  .cal-cell{position:relative;min-height:52px;border-radius:9px;padding:.25rem .3rem;border:1px solid transparent}
  .cal-pad{background:none}
  .cal-d{font-size:.72rem;color:var(--muted);font-weight:600}
  .cal-s{position:absolute;left:0;right:0;top:50%;transform:translateY(-42%);text-align:center;font-size:1.05rem;font-weight:800;color:var(--ink)}
  .cal-h{position:absolute;top:.2rem;right:.3rem;font-size:.6rem;color:var(--gold)}
  .cal-alt{position:absolute;left:0;right:0;bottom:.15rem;text-align:center;font-size:.56rem;font-weight:700;color:var(--brand);text-decoration:none;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;padding:0 .15rem}
  .cal-alt-ev{color:var(--gold)}
  .cal-e{position:absolute;top:.1rem;right:.2rem;font-size:.6rem}
  .cal-pick{outline:2px solid var(--brand);outline-offset:-2px}
  .cal-cell.l1{background:var(--green-soft)} .cal-cell.l2{background:var(--green-soft);opacity:.75}
  .cal-cell.l3{background:var(--gold-soft)} .cal-cell.l4{background:var(--red-soft);opacity:.85}
  .cal-cell.l5{background:var(--red-soft)}
  .cal-season{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:14px;margin:.6rem 0 1rem}
  .cs-card{border:1px solid var(--border);border-radius:14px;padding:.9rem 1rem;background:var(--card)}
  .cs-card h3{margin:0 0 .3rem;font-size:.78rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
  .cs-card p{margin:0;font-size:.92rem;line-height:1.6}
  .cs-busy{border-left:3px solid var(--red)} .cs-quiet{border-left:3px solid var(--green)}
  .cal-tip{background:var(--gold-soft);border-radius:10px;padding:.7rem .9rem;font-size:.9rem;margin:0 0 1.4rem}
  .cal-key{display:flex;gap:.9rem;flex-wrap:wrap;align-items:center;font-size:.76rem;color:var(--muted);margin:.2rem 0 1.2rem}
  .cal-key i{display:inline-block;width:14px;height:10px;border-radius:3px;margin-right:.25rem;vertical-align:-1px}
  @media (max-width:520px){ .cal-cell{min-height:44px} .cal-s{font-size:.92rem} .cal-alt{display:none} }
</style></head><body>
<div class="wrap">
<nav><a class="logo" href="/">ParkPulse</a><a href="/app" class="navbtn">Open live waits</a></nav>
<h1>${esc(park.name)} crowd calendar</h1>
<p class="sub">Every day scored 1 to 10 for the next ${days.length} days. Free, no sign-up, no email.</p>

<div class="cal-lead">
  <p style="margin:0 0 .5rem"><b>Quietest days coming up:</b> ${lightest.map((d) => `${pretty(d.date)} <span class="cal-inline">(${d.score}/10)</span>`).join(' &middot; ')}</p>
  <p style="margin:0"><b>Busiest:</b> ${pretty(busiest.date)} (${busiest.score}/10)${busiest.holiday ? ` &mdash; ${esc(busiest.holiday)}` : ''}${bestByDate && Object.keys(bestByDate.byDate).length
    ? `. On days when one ${esc(bestByDate.group)} park is clearly lighter than the rest, it is named in the square.`
    : ''}</p>
</div>

<div class="cal-key">
  <span><i style="background:var(--green-soft)"></i>1&ndash;3 quiet</span>
  <span><i style="background:var(--gold-soft)"></i>4&ndash;6 moderate</span>
  <span><i style="background:var(--red-soft)"></i>7&ndash;10 busy</span>
  <span><span style="color:var(--gold)">\u2726</span> holiday</span>
</div>

${months}

${seo ? `<h2>The months that actually matter at ${esc(park.name)}</h2>
<div class="cal-season">
  <div class="cs-card cs-busy"><h3>Busiest months</h3><p><b>${monthList(seo.peak.months)}</b> &mdash; ${esc(seo.peak.why)}.</p></div>
  <div class="cs-card cs-quiet"><h3>Quietest months</h3><p><b>${monthList(seo.quiet.months)}</b> &mdash; ${esc(seo.quiet.why)}.</p></div>
</div>
<p class="cal-tip"><b>Local knowledge:</b> ${esc(seo.tip)}</p>` : ''}

<h2>How this is worked out</h2>
<p>Each day starts from how that weekday normally runs at ${esc(park.name)}, learned from our own recorded wait snapshots as they accumulate, and is raised for public holidays and school-holiday periods.${bestByDate && !Object.keys(bestByDate.byDate).length ? ` We are still accumulating enough per-park history to separate the ${esc(bestByDate.group)} parks from one another, so for now they share a weekday pattern; the months below are specific to ${esc(park.name)}.` : ''} It is a forecast of <em>relative</em> busyness, not a promise: a 3 means a day that usually runs quiet for this park, not a guarantee of short lines. The further out a date sits, the more it leans on the weekday pattern alone.</p>
<p>Want the live picture instead? <a href="/parks/${park.slug}">${esc(park.name)} wait times</a> has today's queues, the hour-by-hour curve and what counts as a normal wait here. Planning a specific day? <a href="/app">Open the planner</a> and it will build a route around these crowd levels.</p>

<h2 id="all">All parks we track</h2>
<div class="allparks">${allParksIndex(allParks, park.slug)}</div>
<footer>Unofficial fan guide &mdash; not affiliated with the park operators. Crowd levels are forecasts and can be wrong; verify hours and ticket availability with the operator. <a href="/">ParkPulse home</a> &middot; <a href="/parks">All parks</a> &middot; <a href="/terms">Terms</a> &middot; <a href="/privacy">Privacy</a></footer>
</div><script src="/i18n.js"></script></body></html>`;
}


// --- Premade touring plans (the free library) --------------------------------
// One page per park+persona, a hub per park, a hub for everything. Evergreen,
// crawlable, and every page funnels into the live app where the same plan
// updates against real waits.

function renderPlansHub(allParks, personas) {
  const order = ['Florida', 'California', 'US & Canada', 'Europe', 'Asia'];
  const byRegion = {};
  for (const p of allParks) (byRegion[p.region] || (byRegion[p.region] = [])).push(p);
  const regions = [...order.filter((r) => byRegion[r]), ...Object.keys(byRegion).filter((r) => !order.includes(r))];
  const total = allParks.length * personas.length;
  const sections = regions.map((r) => `<h2>${esc(r)}</h2>` + byRegion[r].slice().sort((a, b) => a.name.localeCompare(b.name)).map((p) =>
    `<a href="/plans/${p.slug}" style="display:block;text-decoration:none;color:inherit;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:.75rem 1rem;margin:.4rem 0">
<strong>${esc(p.name)} touring plans</strong><br><span style="color:var(--muted);font-size:.85rem">${esc(p.group)} &middot; ${personas.length} ready-made days</span></a>`).join('')).join('');
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Free Theme Park Touring Plans: ${total}+ Ready-Made Days | ParkPulse</title>
<meta name="description" content="${total}+ free touring plans for ${allParks.length} theme parks — for families with little ones, thrill seekers, rainy days, scorchers and more. Built from real crowd patterns, free to open live in the app.">
<link rel="icon" href="/icon.svg" type="image/svg+xml"><meta name="theme-color" content="#2c2154">
<link rel="canonical" href="https://www.parkpulse.fun/plans">
<meta property="og:title" content="${total}+ Free Theme Park Touring Plans | ParkPulse">
<meta property="og:description" content="Ready-made park days for every kind of crew — free, and live in the app.">
<meta property="og:image" content="https://www.parkpulse.fun/og.png">
<style>${CSS}</style></head><body><div class="wrap">
<nav><a class="logo" href="/"><img src="/icon.svg" alt="" width="22" height="22" style="vertical-align:-4px;margin-right:.2rem"> ParkPulse</a><span><a class="plain" href="/app">Live waits</a><a class="plain" href="/parks">All parks</a></span></nav>
<h1>${total}+ free touring plans</h1>
<p class="sub">A ready-made day for every kind of crew — parents with little ones, thrill seekers, rainy days, heat waves, late sleepers. Built from each park's real crowd patterns, and every one opens live in the app where the waits update in real time.</p>
${sections}
<footer>Unofficial fan guide &mdash; not affiliated with the park operators. Wait-time data powered by <a href="https://queue-times.com" rel="nofollow">Queue-Times.com</a>. <a href="/">ParkPulse home</a> &middot; <a href="/parks">All parks</a> &middot; <a href="/terms">Terms</a> &middot; <a href="/privacy">Privacy</a></footer>
</div>${milaHover()}</body></html>`;
}

function renderParkPlansPage(park, planList, allParks) {
  const cards = planList.map(({ persona, plan }) => `<a href="/plans/${park.slug}/${persona.slug}" style="display:block;text-decoration:none;color:inherit;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:.85rem 1rem;margin:.5rem 0">
<strong>${persona.emoji} ${esc(persona.title)}</strong><br>
<span style="color:var(--muted);font-size:.88rem">${esc(persona.who)}</span><br>
<span style="color:var(--muted);font-size:.82rem">${plan.stats.attractions} attractions &middot; ${esc(plan.stats.span)}${plan.stats.headliner ? ` &middot; headliner: ${esc(plan.stats.headliner)}` : ''}</span></a>`).join('');
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(park.name)} Touring Plans: ${planList.length} Ready-Made Days | ParkPulse</title>
<meta name="description" content="Free ${esc(park.name)} touring plans — for families with small children, thrill seekers, one big day, rainy days and more. Hour-by-hour running orders from real crowd patterns.">
<link rel="icon" href="/icon.svg" type="image/svg+xml"><meta name="theme-color" content="#2c2154">
<link rel="canonical" href="https://www.parkpulse.fun/plans/${park.slug}">
<meta property="og:title" content="${esc(park.name)} Touring Plans | ParkPulse">
<meta property="og:description" content="${planList.length} ready-made ${esc(park.name)} days, free.">
<meta property="og:image" content="https://www.parkpulse.fun/og.png">
<style>${CSS}</style></head><body><div class="wrap">
<nav><a class="logo" href="/"><img src="/icon.svg" alt="" width="22" height="22" style="vertical-align:-4px;margin-right:.2rem"> ParkPulse</a><span><a class="plain" href="/plans">All plans</a><a class="plain" href="/parks/${park.slug}">${esc(park.name)}</a></span></nav>
<h1>${esc(park.name)} touring plans</h1>
<p class="sub">${esc(park.group)} &middot; ${planList.length} ready-made days, built from ${esc(park.name)}'s typical crowd patterns. Pick the one that sounds like your crew, then open it live in the app.</p>
${cards}
<div class="card" style="margin-top:1rem"><p><b>None of these exactly your crew?</b> The app builds a custom plan in one tap — your picks, your hours, your kids' heights — and Mila, your park fairy, reviews the order before you walk a step.</p><a class="cta" href="/app?park=${park.slug}">Build my own plan</a></div>
<h2>More parks</h2><div class="allparks">${allParksIndex(allParks, park.slug)}</div>
<footer>Unofficial fan guide &mdash; not affiliated with the park operators. <a href="/plans">All touring plans</a> &middot; <a href="/parks/${park.slug}">${esc(park.name)} wait times</a> &middot; <a href="/">Home</a></footer>
</div>${milaHover()}</body></html>`;
}

function renderPremadePlanPage(park, plan, planList, allParks) {
  const rows = plan.steps.map((st) => st.name
    ? `<tr><td style="white-space:nowrap;font-weight:700;color:var(--brand);padding:.45rem .8rem .45rem 0;vertical-align:top">${esc(st.time)}</td>
<td style="padding:.45rem 0"><b>${esc(st.name)}</b>${st.land ? ` <span style="color:var(--muted)">&middot; ${esc(st.land)}</span>` : ''} <span style="color:var(--muted)">&middot; ~${st.wait} min</span><br><span style="color:var(--muted);font-size:.85rem">${esc(st.why)}</span></td></tr>`
    : `<tr><td style="white-space:nowrap;font-weight:700;color:var(--muted);padding:.45rem .8rem .45rem 0;vertical-align:top">${esc(st.time)}</td>
<td style="padding:.45rem 0"><b style="color:var(--muted)">${esc(st.break)}</b><br><span style="color:var(--muted);font-size:.85rem">${esc(st.why)}</span></td></tr>`).join('');
  const others = planList.filter((x) => x.persona.slug !== plan.persona)
    .map((x) => `<a class="plain" href="/plans/${park.slug}/${x.persona.slug}">${x.persona.emoji} ${esc(x.persona.title)}</a>`).join(' ');
  const schema = {
    '@context': 'https://schema.org', '@type': 'ItemList',
    name: `${plan.title} — ${park.name} touring plan`,
    numberOfItems: plan.stats.attractions,
    itemListElement: plan.steps.filter((st) => st.name).map((st, i) => ({ '@type': 'ListItem', position: i + 1, name: st.name })),
  };
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(park.name)}: ${esc(plan.title)} Touring Plan | ParkPulse</title>
<meta name="description" content="${esc(plan.title)} at ${esc(park.name)}: ${plan.stats.attractions} attractions from ${esc(plan.stats.first)}, ordered around typical crowds. ${esc(plan.who)}. Free, and live in the app.">
<link rel="icon" href="/icon.svg" type="image/svg+xml"><meta name="theme-color" content="#2c2154">
<link rel="canonical" href="https://www.parkpulse.fun/plans/${park.slug}/${plan.persona}">
<meta property="og:title" content="${esc(park.name)}: ${esc(plan.title)} | ParkPulse">
<meta property="og:description" content="${plan.stats.attractions} attractions, ${esc(plan.stats.span)} — free touring plan.">
<meta property="og:image" content="https://www.parkpulse.fun/og.png">
<script type="application/ld+json">${JSON.stringify(schema)}</script>
<style>${CSS}</style></head><body><div class="wrap">
<nav><a class="logo" href="/"><img src="/icon.svg" alt="" width="22" height="22" style="vertical-align:-4px;margin-right:.2rem"> ParkPulse</a><span><a class="plain" href="/plans/${park.slug}">${esc(park.name)} plans</a><a class="plain" href="/app?park=${park.slug}&premade=${plan.persona}">Open live</a></span></nav>
<h1>${plan.emoji} ${esc(plan.title)} &mdash; ${esc(park.name)}</h1>
<p class="sub">${esc(plan.who)} &middot; ${plan.stats.attractions} attractions &middot; ${esc(plan.stats.span)}</p>
<div class="card" style="display:flex;gap:.7rem;align-items:center">
<img src="/img/mila/mila-wink-160.webp" alt="" width="44" height="44" style="border-radius:50%;border:2px solid var(--brand)">
<p style="margin:0;font-size:.92rem"><b>Mila says:</b> ${esc(plan.mila)}</p></div>
<div class="card"><table style="border-collapse:collapse;width:100%">${rows}</table></div>
<div class="card"><p><b>Make it live.</b> This is the typical-day version. Open it in the app and the same plan re-times itself against today's real waits — and re-shuffles when the day changes.</p>
<a class="cta" href="/app?park=${park.slug}&premade=${plan.persona}">Open this plan live</a></div>
<p style="color:var(--muted);font-size:.82rem">Built from ${esc(park.name)}'s typical crowd patterns; times are a guide, not a promise. Refreshes weekly.</p>
${others ? `<h2>Other ${esc(park.name)} plans</h2><p>${others}</p>` : ''}
<footer>Unofficial fan guide &mdash; not affiliated with the park operators. <a href="/plans/${park.slug}">All ${esc(park.name)} plans</a> &middot; <a href="/parks/${park.slug}">${esc(park.name)} wait times</a> &middot; <a href="/plans">Every park's plans</a> &middot; <a href="/">Home</a></footer>
</div>${milaHover()}</body></html>`;
}

module.exports = { renderParkPage, renderCalendarPage, renderParksIndex, renderAccuracyPage, renderNotFoundPage, renderSitemap, renderRobots, allParksIndex, renderPlansHub, renderParkPlansPage, renderPremadePlanPage };
