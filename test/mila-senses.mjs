// Mila's senses in the browser: a microphone, a speaker, a camera, and two
// buttons for the queue. The browser engines are stood in for -- what is under
// test is that the widget wires them, in the app's language, and sends what
// they produce the way the server expects it.
import { launchBrowser } from './browser.mjs';

const B = process.env.PP_BASE || 'http://127.0.0.1:9695';
let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };

const browser = await launchBrowser();
const ctx = await browser.newContext({ viewport: { width: 414, height: 900 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
await page.addInitScript(() => {
  localStorage.setItem('pp-onboarded', '1');
  localStorage.setItem('pp-park', 'magic-kingdom');
  localStorage.setItem('pp-lang', 'es');
  // Ears and a voice, stood in for.
  window.__rec = null; window.__spoken = [];
  window.SpeechRecognition = class { constructor() { window.__rec = this; this.started = false; } start() { this.started = true; } stop() { this.onend && this.onend(); } };
  // A read-only accessor on window in Chromium: a plain assignment is
  // silently ignored and the real engine speaks into the void.
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { speak: (u) => window.__spoken.push({ text: u.text, lang: u.lang }), cancel: () => {}, speaking: false } });
  window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
});
// What the server is handed, without a real model behind it.
const posted = [];
await page.route('**/api/consultant', (route) => { posted.push(JSON.parse(route.request().postData())); route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'log in first' }) }); });
await page.route('**/api/mila/story', (route) => { posted.push({ story: JSON.parse(route.request().postData()) }); route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: 'Había una vez un dragón muy paciente.', kind: 'story' }) }); });
await page.goto(B + '/app', { waitUntil: 'domcontentloaded', timeout: 25000 });
await page.waitForTimeout(2500);
await page.evaluate(() => document.getElementById('ppc-fab').click());
await page.waitForTimeout(400);

console.log('\n  the controls');
const ctl = await page.evaluate(() => ({
  mic: !document.getElementById('ppc-mic').hidden, cam: !document.getElementById('ppc-cam').hidden, voice: !document.getElementById('ppc-voice').hidden,
  micLabel: document.getElementById('ppc-mic').getAttribute('aria-label'),
  fun: [...document.querySelectorAll('#ppc-fun button')].map((b) => b.textContent.trim()),
}));
check('microphone, camera and speaker are offered when the browser has them', ctl.mic && ctl.cam && ctl.voice, JSON.stringify(ctl));
check('  labelled in the app\'s language', ctl.micLabel === 'Habla con Mila', ctl.micLabel);
check('the two queue buttons are there, translated', ctl.fun.length === 2 && /cola/.test(ctl.fun[0]) && /Quiz/.test(ctl.fun[1]), ctl.fun.join(' | '));

console.log('\n  speaking to her');
await page.evaluate(() => document.getElementById('ppc-mic').click());
const rec = await page.evaluate(() => ({ started: window.__rec && window.__rec.started, lang: window.__rec && window.__rec.lang, listening: document.getElementById('ppc-mic').classList.contains('listening') }));
check('the microphone starts listening in Spanish', rec.started && rec.lang === 'es-ES' && rec.listening, JSON.stringify(rec));
await page.evaluate(() => {
  const r = window.__rec;
  r.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: '¿Vale la pena el pase hoy?' }], { isFinal: true })] });
  r.onend();
});
// The first send gathers the app's context before it posts; give it a moment.
for (let i = 0; i < 30 && !posted.some((p) => p.messages); i++) await page.waitForTimeout(100);
const asked = posted.find((p) => p.messages);
check('what was heard is sent as the question', asked && asked.messages[asked.messages.length - 1].content === '¿Vale la pena el pase hoy?', JSON.stringify(asked && asked.messages));
check('  and shown as your bubble', await page.evaluate(() => [...document.querySelectorAll('.ppc-user')].some((b) => /Vale la pena/.test(b.textContent))));

console.log('\n  the speaker');
await page.evaluate(() => document.getElementById('ppc-voice').click());
check('the speaker toggle turns on and is remembered', await page.evaluate(() => document.getElementById('ppc-voice').classList.contains('on') && localStorage.getItem('pp-voice') === '1'));

console.log('\n  a photo');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVQIW2P8z8Dwn4GBgYEBAB8ABPZ0Hc4AAAAASUVORK5CYII=', 'base64');
await page.setInputFiles('#ppc-file', { name: 'menu.png', mimeType: 'image/png', buffer: png });
await page.waitForTimeout(600);
check('the photo shows as attached before sending', await page.evaluate(() => !document.getElementById('ppc-thumb').hidden && document.querySelector('#ppc-thumb img').src.startsWith('data:image/jpeg')));
await page.fill('#ppc-input', '¿Hay algo sin nueces?');
await page.evaluate(() => document.getElementById('ppc-form').requestSubmit());
await page.waitForTimeout(700);
const withShot = posted.filter((p) => p.messages).pop();
const lastMsg = withShot && withShot.messages[withShot.messages.length - 1];
check('it goes to the server as an image block ahead of the words', Array.isArray(lastMsg && lastMsg.content) && lastMsg.content[0].type === 'image' && lastMsg.content[0].source.media_type === 'image/jpeg' && lastMsg.content[1].text === '¿Hay algo sin nueces?', JSON.stringify(lastMsg).slice(0, 160));
check('  re-encoded as JPEG, downscaled', lastMsg && lastMsg.content[0].source.data.length > 100 && lastMsg.content[0].source.data.length < 50000);
check('  earlier turns stay plain text', withShot && withShot.messages.slice(0, -1).every((m) => typeof m.content === 'string'));
check('  the bubble shows the photo', await page.evaluate(() => Boolean(document.querySelector('.ppc-user img.ppc-shot'))));
check('  and the attachment chip is cleared', await page.evaluate(() => document.getElementById('ppc-thumb').hidden));

console.log('\n  a story for the queue');
await page.evaluate(() => document.querySelector('#ppc-fun button[data-fun="story"]').click());
await page.waitForTimeout(700);
const st = posted.find((p) => p.story);
check('the story button asks the light endpoint, in the language', st && st.story.kind === 'story' && st.story.park === 'magic-kingdom' && /Spanish|Español/i.test(st.story.lang), JSON.stringify(st));
check('  and the story is read on screen', await page.evaluate(() => [...document.querySelectorAll('.ppc-bot')].some((b) => /dragón muy paciente/.test(b.textContent))));
check('  and out loud, since the speaker is on', await page.evaluate(() => window.__spoken.some((s) => /dragón/.test(s.text) && s.lang === 'es-ES')), JSON.stringify(await page.evaluate(() => window.__spoken)));

await browser.close();
console.log(fail ? `\n${fail} check(s) failed` : '\nall checks passed');
process.exit(fail ? 1 : 0);
