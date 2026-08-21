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
  const state = { history: [], busy: false, opts: null };
  try { state.history = JSON.parse(sessionStorage.getItem('ppc-history') || '[]'); } catch {}
  const saveHistory = () => { try { sessionStorage.setItem('ppc-history', JSON.stringify(state.history.slice(-24))); } catch {} };

  const CSS = `
    #ppc-fab { position: fixed; right: 1rem; bottom: calc(1rem + env(safe-area-inset-bottom)); z-index: 90;
      width: 3.4rem; height: 3.4rem; border-radius: 50%; border: none; cursor: pointer; font-size: 1.5rem;
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
    #ppc-head { display: flex; justify-content: space-between; align-items: center; padding: .8rem 1rem;
      background: linear-gradient(135deg, #2c2154, #4f3ac9); color: #fff; flex-shrink: 0; }
    #ppc-head b { font-size: .98rem; }
    #ppc-head span { display: block; font-size: .74rem; opacity: .8; font-weight: 400; }
    #ppc-close { border: none; background: none; color: #fff; font-size: 1.15rem; cursor: pointer; padding: .25rem .4rem; }
    #ppc-msgs { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: .55rem; padding: .85rem; }
    .ppc-bubble { max-width: 86%; border-radius: 13px; padding: .55rem .85rem; white-space: pre-wrap; word-wrap: break-word; }
    .ppc-bubble.ppc-user { align-self: flex-end; background: #4f3ac9; color: #fff; border-bottom-right-radius: 4px; }
    .ppc-bubble.ppc-bot { align-self: flex-start; background: var(--ppc-bg); border: 1px solid var(--ppc-border); border-bottom-left-radius: 4px; }
    .ppc-bubble.ppc-typing { color: var(--ppc-muted); font-style: italic; }
    .ppc-bubble a { color: #7b5fe0; font-weight: 700; }
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

  function mount() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    root = document.createElement('div');
    root.id = 'ppc-root';
    root.innerHTML = `
      <button id="ppc-fab" title="Ask the park consultant" aria-label="Ask the park consultant">💬</button>
      <div id="ppc-panel" role="dialog" aria-label="Park consultant chat">
        <div id="ppc-head"><div><b>Park Consultant</b><span id="ppc-sub"></span></div>
          <button id="ppc-close" aria-label="Close chat">✕</button></div>
        <div id="ppc-msgs"></div>
        <div id="ppc-chips">
          <button data-q="Is it worth buying line-skipping passes here today?">Worth buying today?</button>
          <button data-q="What's the smartest plan for the rest of my day here?">Plan my day</button>
          <button data-q="How do I do this park well without paying for any passes?">Do it free</button>
        </div>
        <form id="ppc-form"><input id="ppc-input" placeholder="Ask about passes, plans, strategy…" autocomplete="off" maxlength="500">
          <button id="ppc-send" type="submit">Send</button></form>
      </div>`;
    document.body.appendChild(root);
    msgs = $id('ppc-msgs');

    $id('ppc-fab').addEventListener('click', openPanel);
    $id('ppc-close').addEventListener('click', () => $id('ppc-panel').classList.remove('ppc-open'));
    $id('ppc-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const text = $id('ppc-input').value;
      $id('ppc-input').value = '';
      send(text);
    });
    root.querySelectorAll('#ppc-chips button').forEach((b) => b.addEventListener('click', () => send(b.dataset.q)));
  }

  function bubble(role, text) {
    const div = document.createElement('div');
    div.className = 'ppc-bubble ppc-' + role;
    div.textContent = text;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
    return div;
  }

  function openPanel() {
    if (state.opts.requireAccess && !state.opts.requireAccess()) return;
    $id('ppc-panel').classList.add('ppc-open');
    if (!msgs.children.length) {
      for (const m of state.history) {
        if (m.role === 'action' && m.action) renderAction(m.action);
        else bubble(m.role === 'user' ? 'user' : 'bot', m.content);
      }
      if (!state.history.length) {
        const name = state.opts.getParkName() || 'the parks';
        bubble('bot', `Hi! I'm your park consultant — I can see today's waits at ${name}. Ask me whether Lightning Lane or Express Pass is worth it, or how to plan your day.`);
      }
    }
    if (state.history.length) $id('ppc-chips').style.display = 'none';
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
        s.textContent = vote === 'up' ? 'Thanks!' : "Thanks — I'll do better.";
        row.appendChild(s);
      });
      row.appendChild(b);
    }
    msgs.appendChild(row);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function renderAction(action) {
    if (action.type === 'memory') {
      bubble('bot', "📝 Noted — I'll remember that for next time.");
    } else if (action.type === 'alert' && state.opts.onAlert) {
      state.opts.onAlert(action);
      bubble('bot', `🔔 Alert set: ${action.ride} under ${action.threshold} min.`);
    } else if (action.type === 'plan') {
      if (state.opts.onPlan) {
        const div = bubble('bot', `🧭 Plan ready: ${action.rides.join(', ')} `);
        const btn = document.createElement('button');
        btn.textContent = 'Apply to plan builder';
        btn.addEventListener('click', () => state.opts.onPlan(action));
        div.appendChild(btn);
      } else {
        const div = bubble('bot', `🧭 Plan ready: ${action.rides.join(', ')} — `);
        const a = document.createElement('a');
        a.href = '/app';
        a.textContent = 'open the app to apply it';
        div.appendChild(a);
      }
      msgs.scrollTop = msgs.scrollHeight;
    }
  }

  async function send(text) {
    if (state.busy || !text.trim()) return;
    state.busy = true;
    $id('ppc-chips').style.display = 'none';
    bubble('user', text);
    state.history.push({ role: 'user', content: text });
    const out = bubble('bot', 'Thinking…');
    out.classList.add('ppc-typing');
    let replyText = '';
    const appendDelta = (t) => {
      if (!replyText) { out.classList.remove('ppc-typing'); out.textContent = ''; }
      replyText += t;
      out.textContent = replyText;
      msgs.scrollTop = msgs.scrollHeight;
    };
    try {
      const context = await state.opts.getContext();
      const res = await fetch('/api/consultant', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ park: state.opts.getPark(), messages: historyWindow(), ...context }),
      });
      if (!res.ok || !(res.headers.get('content-type') || '').includes('text/event-stream')) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 402) throw new Error('This is a Trip Pass feature — see /#pricing to unlock everything.');
        throw new Error(data.error || 'error');
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '', streamError = null;
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
          else if (event === 'error') streamError = payload.error;
        }
      }
      if (streamError && !replyText) throw new Error(streamError);
      if (!replyText) throw new Error('empty reply');
      if (streamError) {
        // Partial reply then a mid-stream failure: show it honestly and do
        // not save the dangling half-answer as conversation context.
        out.textContent = replyText + '\n\n⚠️ ' + streamError;
        state.history.pop();
        saveHistory();
        actions.forEach(renderAction); // actions already happened server-side
        return;
      }
      state.history.push({ role: 'assistant', content: replyText });
      for (const a of actions) if (a.type === 'plan') state.history.push({ role: 'action', action: a });
      saveHistory();
      actions.forEach(renderAction);
      feedbackRow(replyText);
    } catch (e) {
      out.classList.remove('ppc-typing');
      out.textContent = (e.message && e.message.length < 130 && e.message !== 'empty reply')
        ? e.message
        : 'The consultant is having a moment — try again shortly.';
      state.history.pop();
      saveHistory();
    } finally {
      state.busy = false;
      msgs.scrollTop = msgs.scrollHeight;
    }
  }

  async function init(opts = {}) {
    state.opts = {
      getPark: opts.getPark || (() => 'magic-kingdom'),
      getParkName: opts.getParkName || (() => null),
      getContext: opts.getContext || (async () => ({ favorites: [], planPicks: [], subscription: null })),
      onPlan: opts.onPlan || null,
      onAlert: opts.onAlert || null,
      requireAccess: opts.requireAccess || null,
      offsetBottom: opts.offsetBottom || null,
    };
    if (!document.body) await new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
    mount();
    // Logged-in users get their saved conversation back on any device; the
    // tab's own sessionStorage history (if any) is fresher, so it wins.
    if (!state.history.length && localStorage.getItem('pp-session')) {
      try {
        const r = await fetch('/api/advisor/history', { headers: authHeaders() });
        if (r.ok) {
          const d = await r.json();
          if (Array.isArray(d.messages) && d.messages.length) { state.history = d.messages.slice(-24); saveHistory(); }
        }
      } catch {}
    }
    if (state.opts.offsetBottom) $id('ppc-fab').style.bottom = `calc(${state.opts.offsetBottom} + env(safe-area-inset-bottom))`;
    let enabled = opts.enabled;
    if (enabled === undefined) {
      try { enabled = Boolean((await (await fetch('/api/config')).json()).consultant); } catch { enabled = false; }
    }
    if (enabled) $id('ppc-fab').classList.add('ppc-show');
    return { setEnabled: (on) => $id('ppc-fab').classList.toggle('ppc-show', Boolean(on)) };
  }

  // Open the panel and (optionally) send a question — lets the app deep-link
  // into a conversation, e.g. the skip-pass card's "worth it today?" button.
  function ask(text) {
    if (!root || !state.opts) return;
    openPanel();
    if (text && !state.busy) send(text);
  }

  window.ParkPulseChat = { init, ask };
  if (!window.PP_CHAT_MANUAL) {
    const park = (script && script.dataset && script.dataset.park) || 'magic-kingdom';
    const name = (script && script.dataset && script.dataset.parkName) || null;
    init({ getPark: () => park, getParkName: () => name });
  }
})();
