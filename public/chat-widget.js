// ParkPulse floating consultant widget. Self-contained: injects its own
// styles and DOM (a bottom-right chat bubble + panel), streams replies from
// /api/consultant over SSE, and renders agent actions.
//
// Auto-initializes on plain pages (park slug from the script tag's data-park
// attribute). The app sets window.PP_CHAT_MANUAL = true and calls
// ParkPulseChat.init({...}) itself to wire in live park state, plan
// application, and alert syncing. Conversation history persists for the tab
// via sessionStorage.
(function () {
  const script = document.currentScript;
  const T = () => window.PP_T || ((k) => k); // resolved lazily so load order never matters
  // Same, with placeholders: a sentence with a park name in the middle has to
  // be translated whole, because the name does not sit in the same place in
  // every language.
  const F = () => (key, vals) => String(T()(key)).replace(/\{(\w+)\}/g, (m, k) => (vals[k] != null ? vals[k] : m));
  const state = { history: [], busy: false, opts: null, locked: false, park: null };
  try { state.park = sessionStorage.getItem('ppc-park'); } catch {}
  try { state.history = JSON.parse(sessionStorage.getItem('ppc-history') || '[]'); } catch {}
  const saveHistory = () => { try { sessionStorage.setItem('ppc-history', JSON.stringify(state.history.slice(-24))); } catch {} };

  const CSS = `
    #ppc-fab { position: fixed; right: 1rem; bottom: calc(1rem + env(safe-area-inset-bottom)); z-index: 90;
      width: 3.4rem; height: 3.4rem; border-radius: 50%; border: none; cursor: pointer; font-size: 1.5rem; padding: 3px;
      background: linear-gradient(135deg, #4f3ac9, #7b5fe0); color: #fff; box-shadow: 0 6px 20px rgba(44,33,84,.4);
      display: none; align-items: center; justify-content: center; transition: transform .15s; }
    #ppc-fab:active { transform: scale(.92); }
    #ppc-fab.ppc-show { display: flex; }
    #ppc-panel { position: fixed; right: 1rem; bottom: calc(1rem + env(safe-area-inset-bottom)); z-index: 95;
      width: min(400px, calc(100vw - 2rem)); height: min(600px, calc(100dvh - 6rem));
      background: var(--ppc-card); color: var(--ppc-ink); border: 1px solid var(--ppc-border); border-radius: 18px;
      box-shadow: 0 12px 40px rgba(0,0,0,.35); display: none; flex-direction: column; overflow: hidden;
      font: 15px/1.5 "Segoe UI", system-ui, sans-serif; }
    #ppc-panel.ppc-open { display: flex; }
    /* With no composer and no chips, the fixed 600px panel is mostly empty
       white, which reads as a broken chat rather than a deliberate gate. */
    #ppc-panel.ppc-locked { height: auto; }
    #ppc-panel.ppc-locked #ppc-scrollwrap { flex: 0 0 auto; }
    #ppc-head { display: flex; justify-content: space-between; align-items: center; padding: .8rem 1rem;
      background: linear-gradient(135deg, #2c2154, #4f3ac9); color: #fff; flex-shrink: 0; }
    #ppc-head b { font-size: .98rem; }
    #ppc-head span { display: block; font-size: .74rem; opacity: .8; font-weight: 400; }
    #ppc-close { border: none; background: none; color: #fff; font-size: 1.15rem; cursor: pointer; padding: .25rem .4rem; }
    #ppc-scrollwrap { flex: 1; min-height: 0; position: relative; display: flex; }
    #ppc-msgs { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: .55rem; padding: .85rem; }
    #ppc-jump { position: absolute; bottom: .6rem; left: 50%; transform: translateX(-50%);
      border: 1px solid var(--ppc-border); background: var(--ppc-card); color: var(--ppc-ink);
      border-radius: 999px; padding: .32rem .8rem; font: inherit; font-size: .8rem; font-weight: 700;
      cursor: pointer; box-shadow: 0 3px 12px rgba(0,0,0,.22); display: none; z-index: 2; }
    #ppc-jump.ppc-show { display: block; }
    .ppc-bubble { max-width: 86%; border-radius: 13px; padding: .55rem .85rem; white-space: pre-wrap; word-wrap: break-word; }
    .ppc-bubble.ppc-user { align-self: flex-end; background: #4f3ac9; color: #fff; border-bottom-right-radius: 4px; }
    .ppc-bubble.ppc-bot { align-self: flex-start; background: var(--ppc-bg); border: 1px solid var(--ppc-border); border-bottom-left-radius: 4px; }
    .ppc-bubble.ppc-typing { color: var(--ppc-muted); font-style: italic; }
    .ppc-bubble a { color: #7b5fe0; font-weight: 700; }
    /* The bubble is pre-wrap for streamed text; paragraphs only appear in the
       locked panel, and default <p> margins are far too tall inside one. */
    .ppc-bubble p { margin: 0 0 .6rem; }
    .ppc-bubble p:last-child { margin-bottom: 0; }
    .ppc-bubble button { display: block; margin-top: .5rem; border: none; border-radius: 9px; padding: .45rem .9rem;
      background: #4f3ac9; color: #fff; font-weight: 700; font-size: .85rem; cursor: pointer; }
    .ppc-fb { display: flex; gap: .35rem; align-self: flex-start; margin: -.25rem 0 0 .25rem; }
    .ppc-fb button { border: 1px solid var(--ppc-border); background: var(--ppc-bg); border-radius: 999px;
      padding: .15rem .55rem; font-size: .8rem; cursor: pointer; opacity: .75; }
    .ppc-fb button:hover { opacity: 1; }
    .ppc-fb span { color: var(--ppc-muted); font-size: .75rem; align-self: center; }
    #ppc-chips { display: flex; gap: .4rem; flex-wrap: wrap; padding: 0 .85rem .5rem; }
    #ppc-chips button { border: 1px solid var(--ppc-border); background: var(--ppc-bg); color: #7b5fe0;
      border-radius: 999px; padding: .35rem .75rem; font-size: .8rem; font-weight: 600; cursor: pointer; }
    #ppc-form { display: flex; gap: .5rem; padding: .6rem .85rem calc(.75rem + env(safe-area-inset-bottom)); border-top: 1px solid var(--ppc-border); flex-shrink: 0; }
    #ppc-input { flex: 1; border: 1px solid var(--ppc-border); background: var(--ppc-bg); color: var(--ppc-ink);
      border-radius: 11px; padding: .6rem .85rem; font-size: 16px; min-width: 0; }
    #ppc-send { border: none; border-radius: 11px; padding: .6rem 1rem; background: #4f3ac9; color: #fff; font-weight: 700; cursor: pointer; }
    .ppc-icon { border: 1px solid var(--ppc-border); background: var(--ppc-bg); color: var(--ppc-ink); border-radius: 11px; width: 2.4rem; flex: 0 0 auto; font-size: 1.05rem; cursor: pointer; padding: 0; }
    .ppc-icon[hidden] { display: none; }
    .ppc-icon.on { background: #4f3ac9; color: #fff; border-color: #4f3ac9; }
    .ppc-icon.listening { background: #e5484d; color: #fff; border-color: #e5484d; animation: ppc-pulse 1s infinite; }
    @keyframes ppc-pulse { 50% { opacity: .6; } }
    #ppc-fun { display: flex; gap: .4rem; padding: 0 .85rem .4rem; flex-shrink: 0; }
    #ppc-fun button { border: 1px dashed var(--ppc-border); background: transparent; color: #7b5fe0; border-radius: 999px; padding: .28rem .7rem; font-size: .78rem; cursor: pointer; }
    #ppc-thumb { display: flex; align-items: center; gap: .5rem; padding: .3rem .85rem; font-size: .8rem; color: var(--ppc-ink); }
    #ppc-thumb[hidden] { display: none; }
    #ppc-thumb img { width: 42px; height: 42px; object-fit: cover; border-radius: 8px; }
    #ppc-thumb button { margin-left: auto; border: none; background: transparent; color: var(--ppc-ink); cursor: pointer; }
    .ppc-user img.ppc-shot { display: block; max-width: 160px; max-height: 160px; border-radius: 10px; margin-bottom: .35rem; }
    #ppc-root { --ppc-bg: #f7f5ff; --ppc-card: #fff; --ppc-ink: #251d3d; --ppc-muted: #6b6485; --ppc-border: #e3dff2; }
    @media (prefers-color-scheme: dark) {
      #ppc-root { --ppc-bg: #17122b; --ppc-card: #221b3d; --ppc-ink: #efecfc; --ppc-muted: #a79fc4; --ppc-border: #362c5c; }
    }
    @media (max-width: 480px) {
      #ppc-panel { right: .5rem; left: .5rem; width: auto; height: min(600px, calc(100dvh - 4rem)); }
    }
  `;

  // Trim the outgoing history window: newest messages first, capped by count
  // and total characters (the server rejects oversized bodies), and always
  // starting on a user turn (the API requires it).
  // The last user turn carries the photo, as an image block ahead of the text.
  function withPhoto(msgs, shot, text) {
    if (!shot) return msgs;
    const out = msgs.slice();
    out[out.length - 1] = { role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: shot.media_type, data: shot.data } },
      { type: 'text', text },
    ] };
    return out;
  }
  function historyWindow() {
    const out = [];
    let chars = 0;
    for (let i = state.history.length - 1; i >= 0 && out.length < 12; i--) {
      const m = state.history[i];
      if ((m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') continue;
      if (chars + m.content.length > 9000 && out.length) break;
      out.unshift(m);
      chars += m.content.length;
    }
    while (out.length && out[0].role !== 'user') out.shift();
    return out;
  }

  const authHeaders = () => {
    const h = { 'content-type': 'application/json' };
    const pass = localStorage.getItem('pp-pass');
    const session = localStorage.getItem('pp-session');
    if (pass) h['x-pass'] = pass;
    if (session) h['x-session'] = session;
    return h;
  };

  let root, msgs;
  const $id = (id) => root.querySelector('#' + id);

  // Auto-scroll follows new content only while the reader is already at the
  // bottom. Scroll up to re-read and the view stays put, even mid-answer.
  let stick = true;
  const atBottom = () => msgs.scrollHeight - msgs.clientHeight - msgs.scrollTop < 24;
  function syncJump() {
    const btn = root && $id('ppc-jump');
    if (btn) btn.classList.toggle('ppc-show', !stick && !atBottom());
  }
  function scrollDown(force) {
    if (force) stick = true;
    if (stick) msgs.scrollTop = msgs.scrollHeight;
    syncJump();
  }

  function mount() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    root = document.createElement('div');
    root.id = 'ppc-root';
    root.innerHTML = `
      <button id="ppc-fab"><img src="/img/mila/mila-wink-160.webp" alt="" style="width:100%;height:100%;border-radius:50%;object-fit:cover"></button>
      <div id="ppc-panel" role="dialog">
        <div id="ppc-head"><div><b id="ppc-title"></b><span id="ppc-sub"></span></div>
          <button id="ppc-close">✕</button></div>
        <div id="ppc-scrollwrap">
          <div id="ppc-msgs"></div>
          <button id="ppc-jump" type="button"></button>
        </div>
        <div id="ppc-chips">
          <button data-q="Is it worth buying line-skipping passes here today?"></button>
          <button data-q="What's the smartest plan for the rest of my day here?"></button>
          <button data-q="How do I do this park well without paying for any passes?"></button>
        </div>
        <div id="ppc-fun">
          <button type="button" data-fun="story">📖 <span></span></button>
          <button type="button" data-fun="quiz">❓ <span></span></button>
        </div>
        <div id="ppc-thumb" hidden><img alt=""><span></span><button type="button" id="ppc-thumb-x" aria-label="✕">✕</button></div>
        <form id="ppc-form">
          <button type="button" class="ppc-icon" id="ppc-cam" hidden>📷</button>
          <button type="button" class="ppc-icon" id="ppc-mic" hidden>🎤</button>
          <input id="ppc-input" autocomplete="off" maxlength="500">
          <button id="ppc-send" type="submit"></button>
          <button type="button" class="ppc-icon" id="ppc-voice" hidden>🔈</button>
          <input type="file" id="ppc-file" accept="image/*" hidden>
        </form>
      </div>`;
    document.body.appendChild(root);
    retextChrome();
    msgs = $id('ppc-msgs');

    msgs.addEventListener('scroll', () => { stick = atBottom(); syncJump(); }, { passive: true });
    $id('ppc-jump').addEventListener('click', () => scrollDown(true));

    $id('ppc-fab').addEventListener('click', openPanel);
    $id('ppc-close').addEventListener('click', () => $id('ppc-panel').classList.remove('ppc-open'));
    $id('ppc-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const text = $id('ppc-input').value;
      $id('ppc-input').value = '';
      send(text);
    });
    root.querySelectorAll('#ppc-chips button').forEach((b) => b.addEventListener('click', () => send(window.PP_LANG && window.PP_LANG !== 'en' ? b.textContent : b.dataset.q)));
    wireSenses();
  }

  // --- Ears, a voice, and eyes ------------------------------------------------
  // Typing is the wrong interface for a park: one hand on a stroller, the
  // other holding a churro. Speech in and out use the browser's own engines
  // in the app's language; a photo is downscaled here so a menu or a sign
  // costs one modest image, not a twelve-megapixel upload.
  const BCP47 = { en: 'en-US', es: 'es-ES', pt: 'pt-BR', fr: 'fr-FR', de: 'de-DE', it: 'it-IT', zh: 'zh-CN', ja: 'ja-JP', ko: 'ko-KR', ru: 'ru-RU', ar: 'ar-SA', hi: 'hi-IN', bn: 'bn-IN', id: 'id-ID', mr: 'mr-IN', ta: 'ta-IN', te: 'te-IN', tr: 'tr-TR', ur: 'ur-PK', vi: 'vi-VN' };
  const speechLang = () => BCP47[window.PP_LANG] || window.PP_LANG || 'en-US';
  let pendingImage = null;   // { media_type, data, preview }
  let recognizer = null;
  function wireSenses() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const mic = $id('ppc-mic'), voice = $id('ppc-voice'), cam = $id('ppc-cam'), file = $id('ppc-file');
    root.querBySel = null;
    root.querySelectorAll('#ppc-fun button').forEach((b) => {
      b.querySelector('span').textContent = T()(b.dataset.fun === 'quiz' ? 'Ride quiz' : 'Story for the queue');
      b.addEventListener('click', () => story(b.dataset.fun));
    });
    if (SR) {
      mic.hidden = false;
      mic.title = mic.getAttribute('aria-label') || T()('Talk to Mila');
      mic.setAttribute('aria-label', T()('Talk to Mila'));
      mic.addEventListener('click', () => {
        if (recognizer) { try { recognizer.stop(); } catch {} return; }
        const rec = new SR();
        recognizer = rec;
        rec.lang = speechLang();
        rec.interimResults = true;
        rec.maxAlternatives = 1;
        let finalText = '';
        mic.classList.add('listening');
        const input = $id('ppc-input');
        const before = input.placeholder;
        input.placeholder = T()('Listening…');
        rec.onresult = (e) => {
          let interim = '';
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const t = e.results[i][0].transcript;
            if (e.results[i].isFinal) finalText += t; else interim += t;
          }
          input.value = (finalText + interim).trim();
        };
        rec.onerror = () => {};
        rec.onend = () => {
          recognizer = null;
          mic.classList.remove('listening');
          input.placeholder = before;
          const text = (finalText || input.value || '').trim();
          if (text) { state.speakNext = true; input.value = ''; send(text); }
        };
        try { rec.start(); } catch { recognizer = null; mic.classList.remove('listening'); }
      });
    }
    if ('speechSynthesis' in window) {
      voice.hidden = false;
      try { state.voice = localStorage.getItem('pp-voice') === '1'; } catch {}
      const paint = () => { voice.textContent = state.voice ? '🔊' : '🔈'; voice.classList.toggle('on', Boolean(state.voice)); voice.setAttribute('aria-label', T()('Read replies aloud')); voice.title = T()('Read replies aloud'); };
      paint();
      voice.addEventListener('click', () => {
        state.voice = !state.voice;
        try { localStorage.setItem('pp-voice', state.voice ? '1' : '0'); } catch {}
        if (!state.voice) { try { speechSynthesis.cancel(); } catch {} }
        paint();
      });
    }
    if (window.File && window.FileReader && window.HTMLCanvasElement) {
      cam.hidden = false;
      cam.setAttribute('aria-label', T()('Add a photo'));
      cam.title = T()('Add a photo');
      cam.addEventListener('click', () => file.click());
      file.addEventListener('change', async () => {
        const f = file.files && file.files[0];
        file.value = '';
        if (!f) return;
        try {
          pendingImage = await shrink(f);
          const thumb = $id('ppc-thumb');
          thumb.querySelector('img').src = pendingImage.preview;
          thumb.querySelector('span').textContent = T()('Photo attached');
          thumb.hidden = false;
          $id('ppc-input').focus();
        } catch { pendingImage = null; }
      });
      $id('ppc-thumb-x').addEventListener('click', () => { pendingImage = null; $id('ppc-thumb').hidden = true; });
    }
  }
  // A phone photo is 3-12 MB. The longest side goes to 1280 pixels and the
  // JPEG to quality .72: a menu stays legible, and the request stays small.
  function shrink(fileObj) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(fileObj);
      const img = new Image();
      img.onload = () => {
        try {
          const max = 1280;
          const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(img.naturalWidth * scale));
          c.height = Math.max(1, Math.round(img.naturalHeight * scale));
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          const preview = c.toDataURL('image/jpeg', 0.72);
          URL.revokeObjectURL(url);
          resolve({ media_type: 'image/jpeg', data: preview.split(',')[1], preview });
        } catch (e) { URL.revokeObjectURL(url); reject(e); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad image')); };
      img.src = url;
    });
  }
  // Markdown, emoji and links are for eyes; the ear gets the sentences.
  function speak(text) {
    if (!('speechSynthesis' in window)) return;
    const clean = String(text).replace(/\*\*/g, '').replace(/https?:\/\/\S+/g, '').replace(/\p{Extended_Pictographic}/gu, '').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(clean.slice(0, 1200));
      u.lang = speechLang();
      u.rate = 1.02;
      speechSynthesis.speak(u);
    } catch {}
  }
  // A story or a quiz for the queue, from the light tier, outside the
  // conversation proper -- and into it afterwards, so Mila knows what was told.
  async function story(kind) {
    if (state.busy) return;
    syncPark();
    state.busy = true;
    const ask = T()(kind === 'quiz' ? 'Quiz us on this ride' : 'Tell us a story for the queue');
    bubble('user', ask);
    const out = bubble('bot', T()('Thinking…'));
    out.classList.add('ppc-typing');
    try {
      const context = await state.opts.getContext();
      const ages = (((context || {}).profile || {}).kids || []).map((k) => Number(k && k.age)).filter((a) => a > 0);
      const ride = (context && (context.ride || (Array.isArray(context.planPicks) && context.planPicks[0]))) || '';
      const res = await fetch('/api/mila/story', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ park: state.opts.getPark(), kind, ride, ages, lang: window.PP_USER_LANG_NAME || window.PP_LANG_NAME || 'English' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'error');
      out.classList.remove('ppc-typing');
      out.innerHTML = renderMd(data.text);
      state.history.push({ role: 'user', content: ask }, { role: 'assistant', content: data.text });
      saveHistory();
      if (state.voice) speak(data.text);
    } catch (e) {
      out.classList.remove('ppc-typing');
      out.textContent = (e.message && e.message.length < 130) ? T()(e.message) : T()('Your magical fairy is having a moment — try again shortly.');
    } finally {
      state.busy = false;
      scrollDown();
    }
  }

  // The advisor writes light markdown; render just **bold** safely and keep
  // everything else as escaped plain text.
  const renderMd = (t) => String(t)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');

  function bubble(role, text) {
    const div = document.createElement('div');
    div.className = 'ppc-bubble ppc-' + role;
    if (role === 'bot') div.innerHTML = renderMd(text);
    else div.textContent = text;
    msgs.appendChild(div);
    scrollDown(role === 'user'); // your own message always pulls the view down
    return div;
  }

  // Built as DOM rather than through renderMd: renderMd escapes HTML on purpose
  // (it renders model output), so a markdown link there would either print as
  // literal text or open an injection path for whatever the model returns.
  function lockedBubble(parkName) {
    const div = document.createElement('div');
    div.className = 'ppc-bubble ppc-bot';
    const p1 = document.createElement('p');
    p1.textContent = F()('Mila, your park fairy, reads today\'s live waits at {park} and tells you whether the paid line-skipping pass is worth it, what to ride and in what order, and when to walk straight on instead of queueing — with a little magic in the telling.', { park: parkName });
    const p2 = document.createElement('p');
    p2.textContent = T()('It comes with any pass.') + ' ';
    const a = document.createElement('a');
    a.href = '/#pricing';
    a.textContent = T()("See what's included");
    p2.appendChild(a);
    div.append(p1, p2);
    msgs.appendChild(div);
    return div;
  }

  // A transcript belongs to the park it was written about. Switching park
  // invalidates it twice over: it reads as advice for somewhere else, and
  // historyWindow() would send it as context for a question about here.
  // Which day the visitor is planning: null for today, 'YYYY-MM-DD' otherwise.
  // Optional, so the park pages -- which mount this widget with no planner
  // behind them -- keep behaving as "today" without having to pass anything.
  const planDateOf = () => (state.opts && state.opts.getPlanDate ? state.opts.getPlanDate() : null) || null;
  const planDateLabel = () => {
    const d = planDateOf();
    if (!d) return '';
    try {
      return new Date(d + 'T12:00:00Z').toLocaleDateString(window.PP_LANG || undefined,
        { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
    } catch { return d; }
  };

  // The starter chips are written into the panel at mount, long before a day is
  // chosen -- so "Worth buying today?" would still be asking about today after
  // the visitor moved to next Thursday. Rewrite them each time the panel opens.
  // Every label on the panel's chrome, in one place. The chrome is written
  // once at mount, from whichever dictionary was in hand -- and a returning
  // visitor mounts from the localStorage mirror, which is one release behind.
  // Called again when the real dictionary lands, so a string added since the
  // last visit does not sit in English until the visitor reloads twice.
  function retextChrome() {
    if (!root) return;
    const t = T();
    const set = (id, fn) => { const el = $id(id); if (el) fn(el); };
    set('ppc-fab', (el) => {
      el.title = t('Ask Mila, your park fairy');
      el.setAttribute('aria-label', t('Ask Mila, your park fairy'));
    });
    set('ppc-panel', (el) => el.setAttribute('aria-label', t('Chat with your magical fairy')));
    set('ppc-title', (el) => { el.textContent = t('Mila — your park fairy'); });
    set('ppc-close', (el) => el.setAttribute('aria-label', t('Close chat')));
    set('ppc-jump', (el) => { el.textContent = '↓ ' + t('Jump to latest'); });
    set('ppc-input', (el) => { el.placeholder = t('Ask about passes, plans, strategy…'); });
    set('ppc-mic', (el) => { el.title = t('Talk to Mila'); el.setAttribute('aria-label', t('Talk to Mila')); });
    set('ppc-cam', (el) => { el.title = t('Add a photo'); el.setAttribute('aria-label', t('Add a photo')); });
    set('ppc-voice', (el) => { el.title = t('Read replies aloud'); el.setAttribute('aria-label', t('Read replies aloud')); });
    root.querySelectorAll('#ppc-fun button').forEach((b) => { const s = b.querySelector('span'); if (s) s.textContent = t(b.dataset.fun === 'quiz' ? 'Ride quiz' : 'Story for the queue'); });
    set('ppc-send', (el) => { el.textContent = t('Send'); });
    syncChips();
  }
  try { document.addEventListener('pp-dict', retextChrome); } catch {}

  function syncChips() {
    const box = $id('ppc-chips');
    if (!box) return;
    // The label is what the visitor reads, so it is localised. The question is
    // what Mila reads, so it carries the plain ISO date -- a Portuguese label
    // dropped into an English sentence read like neither language.
    const when = planDateOf();
    const specs = when
      ? [[`Is it worth buying line-skipping passes here on ${when}?`, T()('Worth buying?')],
         [`What's the smartest plan for ${when} here?`, T()('Plan my day')],
         ['How do I do this park well without paying for any passes?', T()('Do it free')]]
      : [['Is it worth buying line-skipping passes here today?', T()('Worth buying today?')],
         ["What's the smartest plan for the rest of my day here?", T()('Plan my day')],
         ['How do I do this park well without paying for any passes?', T()('Do it free')]];
    box.querySelectorAll('button').forEach((b, i) => {
      if (!specs[i]) return;
      b.dataset.q = specs[i][0];
      b.textContent = specs[i][1];
    });
  }

  function syncPark() {
    const now = state.opts && state.opts.getPark ? state.opts.getPark() : null;
    if (!now) return;
    if (state.park && state.park !== now) {
      state.history = [];
      saveHistory();
      const box = $id('ppc-msgs');
      if (box) box.innerHTML = '';
      const chips = $id('ppc-chips');
      if (chips) chips.style.display = '';
    }
    state.park = now;
    try { sessionStorage.setItem('ppc-park', now); } catch {}
  }

  function openPanel() {
    if (state.opts.requireAccess && !state.opts.requireAccess()) return;
    syncPark();
    syncChips();   // the starter questions follow the day currently selected
    $id('ppc-panel').classList.add('ppc-open');
    if (!msgs.children.length) {
      for (const m of state.history) {
        if (m.role === 'action' && m.action) renderAction(m.action);
        else bubble(m.role === 'user' ? 'user' : 'bot', m.content);
      }
      if (!state.history.length) {
        const name = state.opts.getParkName() || 'the parks';
        // Inviting a question we will refuse to answer is the worst version of
        // a paywall: the visitor spends the effort and gets an error for it.
        // When the advisor is locked, say so before they type anything.
        if (state.locked) {
          lockedBubble(name);
        } else {
          let uname = ''; try { uname = localStorage.getItem('pp-name') || ''; } catch {}
          // Two things were wrong with the old fixed line. It promised "today's
          // waits" to someone planning next Thursday, and it named Lightning
          // Lane and Express Pass at every park -- including the ones whose
          // pass is called something else entirely (Quick Queue at SeaWorld).
          // It also never went through T(), so it stayed English everywhere.
          const hi = uname ? `${T()('Hi')} ${uname}! ` : `${T()('Hi')}, `;
          const when = planDateLabel();
          bubble('bot', when
            ? `${hi}${T()("I'm Mila, your park fairy! ✨ I'm looking ahead with you to")} ${name} · ${when} ${T()("— ask me whether a skip-the-line pass is worth it, what to ride first, or how to dodge the crowds, and let's make that day magical.")}`
            : `${hi}${T()("I'm Mila, your park fairy! ✨ I can see today's waits at")} ${name} ${T()("— ask me whether a skip-the-line pass is worth it, what to ride first, or how to dodge the crowds, and let's make today magical.")}`);
        }
      }
    }
    if (state.history.length || state.locked) $id('ppc-chips').style.display = 'none';
    if (state.locked) {
      $id('ppc-form').style.display = 'none';
      $id('ppc-panel').classList.add('ppc-locked');
    }
    scrollDown(true); // reopening always lands on the newest message
    $id('ppc-input').focus();
  }

  // Thumbs under a finished reply. A vote stores the reply text (as quality
  // context) server-side and the row collapses to a thank-you.
  function feedbackRow(replyText) {
    const row = document.createElement('div');
    row.className = 'ppc-fb';
    for (const vote of ['up', 'down']) {
      const b = document.createElement('button');
      b.textContent = vote === 'up' ? '👍' : '👎';
      b.setAttribute('aria-label', vote === 'up' ? 'Helpful' : 'Not helpful');
      b.addEventListener('click', () => {
        fetch('/api/advisor/feedback', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ vote, park: state.opts.getPark(), message: replyText.slice(0, 500) }),
        }).catch(() => {});
        row.innerHTML = '';
        const s = document.createElement('span');
        s.textContent = vote === 'up' ? T()('Thanks!') : T()("Thanks — I'll do better.");
        row.appendChild(s);
      });
      row.appendChild(b);
    }
    msgs.appendChild(row);
    scrollDown();
  }

  function renderAction(action) {
    if (action.type === 'memory') {
      bubble('bot', '📝 ' + T()("Noted — I'll remember that for next time."));
    } else if (action.type === 'alert' && state.opts.onAlert) {
      state.opts.onAlert(action);
      bubble('bot', `🔔 ${T()('Alert set:')} ${action.ride} ${T()('under')} ${action.threshold} ${T()('min')}.`);
    } else if (action.type === 'plan') {
      if (state.opts.onPlan) {
        const div = bubble('bot', `🧭 ${T()('Plan ready:')} ${action.rides.join(', ')} `);
        const btn = document.createElement('button');
        btn.textContent = T()('Apply to plan builder');
        btn.addEventListener('click', () => state.opts.onPlan(action));
        div.appendChild(btn);
      } else {
        const div = bubble('bot', `🧭 ${T()('Plan ready:')} ${action.rides.join(', ')} — `);
        const a = document.createElement('a');
        a.href = '/app';
        a.textContent = 'open the app to apply it';
        div.appendChild(a);
      }
      scrollDown();
    }
  }

  async function send(text) {
    if (state.busy || (!text.trim() && !pendingImage)) return;
    syncPark();   // ask() can reach here without the panel ever being opened
    state.busy = true;
    $id('ppc-chips').style.display = 'none';
    const shot = pendingImage;
    pendingImage = null;
    const thumbEl = $id('ppc-thumb'); if (thumbEl) thumbEl.hidden = true;
    if (shot && !text.trim()) text = T()('What do you see here?');
    const mine = bubble('user', text);
    if (shot) { const im = document.createElement('img'); im.className = 'ppc-shot'; im.src = shot.preview; im.alt = ''; mine.prepend(im); }
    // The history keeps the words and a mark that a photo went with them;
    // the picture itself is sent once, on this turn.
    state.history.push({ role: 'user', content: shot ? '📷 ' + text : text });
    const out = bubble('bot', T()('Thinking…'));
    out.classList.add('ppc-typing');
    let replyText = '';
    const appendDelta = (t) => {
      if (!replyText) { out.classList.remove('ppc-typing'); out.textContent = ''; }
      replyText += t;
      out.innerHTML = renderMd(replyText);
      scrollDown();
    };
    try {
      const context = await state.opts.getContext();
      const res = await fetch('/api/consultant', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ park: state.opts.getPark(), messages: withPhoto(historyWindow(), shot, text), lang: window.PP_USER_LANG_NAME || window.PP_LANG_NAME || 'English', ...context }),
      });
      if (!res.ok || !(res.headers.get('content-type') || '').includes('text/event-stream')) {
        const data = await res.json().catch(() => ({}));
        // 402 means two different things now. Out of budget is not a locked
        // feature: the visitor has a pass, they have simply used the day's
        // allowance, and telling them to go and buy the thing they already
        // own would be nonsense.
        if (res.status === 402 && data.milaRest) {
          const err = new Error(data.error || T()('Mila needs a rest.'));
          err.milaRest = data.milaRest;
          err.topUp = Boolean(data.topUp);
          throw err;
        }
        if (res.status === 402) throw new Error(T()('This is a Trip Pass feature — see /#pricing to unlock everything.'));
        throw new Error(data.error || 'error');
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '', streamError = null, stale = false;
      const actions = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = 'message', data = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          if (!data) continue;
          const payload = JSON.parse(data);
          if (event === 'delta' && payload.text) appendDelta(payload.text);
          else if (event === 'action') actions.push(payload);
          // Her read of this same plan, replayed because she could not be
          // reached. Unlabelled it would read as something she just wrote.
          else if (event === 'stale') stale = true;
          else if (event === 'error') streamError = payload.error;
        }
      }
      if (streamError && !replyText) throw new Error(streamError);
      if (!replyText) throw new Error('empty reply');
      if (streamError) {
        // Partial reply then a mid-stream failure: show it honestly and do
        // not save the dangling half-answer as conversation context.
        out.innerHTML = renderMd(replyText + '\n\n⚠️ ' + streamError);
        state.history.pop();
        saveHistory();
        actions.forEach(renderAction); // actions already happened server-side
        return;
      }
      if (stale) {
        out.innerHTML = renderMd(replyText + '\n\n_' + T()("Mila couldn't be reached just now — this is her read of this exact plan, from earlier. The live waits may have moved since.") + '_');
      }
      state.history.push({ role: 'assistant', content: replyText });
      for (const a of actions) if (a.type === 'plan') state.history.push({ role: 'action', action: a });
      saveHistory();
      actions.forEach(renderAction);
      feedbackRow(replyText);
      // Asked out loud, or the speaker is on: the answer is read back.
      if (state.voice || state.speakNext) speak(replyText);
      state.speakNext = false;
    } catch (e) {
      state.speakNext = false;
      out.classList.remove('ppc-typing');
      // The server writes these in English -- the spending cap, the dead key,
      // the empty balance -- and they used to land here verbatim, so a
      // Portuguese reader met "Mila has given you everything she has for
      // today." in the middle of their own language. T() returns its input
      // untouched when there is no entry, so a string already translated
      // passes straight through.
      out.textContent = (e.message && e.message.length < 130 && e.message !== 'empty reply')
        ? T()(e.message)
        : T()('Your magical fairy is having a moment — try again shortly.');
      // Out of her day's time, and more can be bought: offer it right here
      // rather than leaving a refusal on screen with nowhere to go.
      // Out of the day, or out of the pass: either way more can be bought,
      // and the pass-cap decline was left with nowhere to go.
      if ((e.milaRest === 'account' || e.milaRest === 'pass') && e.topUp) {
        const b = document.createElement('button');
        b.className = 'ppc-topup';
        b.type = 'button';
        b.textContent = T()('✨ Buy more time with Mila');
        b.addEventListener('click', async () => {
          b.disabled = true;
          try {
            const r = await fetch('/api/mila/topup', { method: 'POST', headers: authHeaders(), body: '{}' });
            const d = await r.json().catch(() => ({}));
            if (d.url) location.href = d.url;
            else { b.disabled = false; b.textContent = T()('Could not start that — try again.'); }
          } catch { b.disabled = false; }
        });
        out.appendChild(document.createElement('br'));
        out.appendChild(b);
      }
      state.history.pop();
      saveHistory();
    } finally {
      state.busy = false;
      scrollDown();
    }
  }

  async function init(opts = {}) {
    state.opts = {
      getPark: opts.getPark || (() => 'magic-kingdom'),
      getParkName: opts.getParkName || (() => null),
      getContext: opts.getContext || (async () => ({ favorites: [], planPicks: [], subscription: null })),
      // Optional: the park pages mount this widget with no planner behind it,
      // so no accessor means "today", which is the truth there.
      getPlanDate: opts.getPlanDate || (() => null),
      onPlan: opts.onPlan || null,
      onAlert: opts.onAlert || null,
      requireAccess: opts.requireAccess || null,
      offsetBottom: opts.offsetBottom || null,
    };
    if (!document.body) await new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
    // The dictionary arrives over the network on a first visit, and mount()
    // reads T() once to build the chrome -- so without this wait Mila greeted a
    // Portuguese reader in English until their second page load. Repeat visits
    // resolve instantly from the localStorage mirror.
    if (window.PP_READY) { try { await window.PP_READY; } catch {} }
    mount();
    // Deliberately NOT restoring the old transcript: each visit opens a clean
    // pane. Mila still remembers the person -- her durable notes (party, trip
    // dates, must-dos, saved via the remember tool) are injected server-side
    // into every consult -- but memory of you and a wall of last week's
    // messages are different things, and the user asked for the first without
    // the second. Same-tab continuity via sessionStorage stays.
    if (state.opts.offsetBottom) $id('ppc-fab').style.bottom = `calc(${state.opts.offsetBottom} + env(safe-area-inset-bottom))`;
    let enabled = opts.enabled;
    // Sent with credentials: /api/config reports access for the caller, and an
    // anonymous fetch would report a signed-in subscriber as locked out.
    try {
      const cfg = await (await fetch('/api/config', { headers: authHeaders() })).json();
      if (enabled === undefined) enabled = Boolean(cfg.consultant);
      state.locked = Boolean(cfg.consultant) && cfg.consultantAccess === false;
    } catch { if (enabled === undefined) enabled = false; }
    if (enabled) $id('ppc-fab').classList.add('ppc-show');
    return {
      setEnabled: (on) => $id('ppc-fab').classList.toggle('ppc-show', Boolean(on)),
      // Called when the app switches park: a transcript about Disneyland is
      // both confusing to read and wrong to send as context for a question
      // about Universal. Start clean at the new park.
      reset: () => {
        state.history = [];
        saveHistory();
        const box = $id('ppc-msgs');
        if (box) box.innerHTML = '';
        const chips = $id('ppc-chips');
        if (chips) chips.style.display = '';
        // Adopt the new park now, so syncPark() does not clear a second time.
        const now = state.opts && state.opts.getPark ? state.opts.getPark() : null;
        if (now) { state.park = now; try { sessionStorage.setItem('ppc-park', now); } catch {} }
      },
    };
  }

  // Open the panel and (optionally) send a question — lets the app deep-link
  // into a conversation, e.g. the skip-pass card's "worth it today?" button.
  function ask(text) {
    if (!root || !state.opts) return;
    openPanel();
    if (text && !state.busy && !state.locked) send(text);
  }

  window.ParkPulseChat = { init, ask };
  if (!window.PP_CHAT_MANUAL) {
    const park = (script && script.dataset && script.dataset.park) || 'magic-kingdom';
    const name = (script && script.dataset && script.dataset.parkName) || null;
    init({ getPark: () => park, getParkName: () => name });
  }
})();
