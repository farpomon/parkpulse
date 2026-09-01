// ParkPulse i18n. English strings are the keys; a missing key falls back to
// English, so a partial dictionary degrades gracefully instead of breaking.
//
// Dictionaries live one-per-language in /i18n/<code>.json and only the active
// language is fetched, so adding languages costs returning visitors nothing.
// The last-used dictionary is mirrored into localStorage, which makes repeat
// loads instant and keeps the UI translated even offline.
(function () {
  // The twenty most-spoken languages worldwide. Two entries from the raw
  // speaker rankings are impractical for a UI picker — Nigerian Pidgin has no
  // settled written standard, and Yue speakers read the same written Chinese
  // as Mandarin — so Korean and Italian take those slots.
  const LANGS = {
    en: { native: 'English', name: 'English' },
    zh: { native: '中文', name: 'Chinese' },
    hi: { native: 'हिन्दी', name: 'Hindi' },
    es: { native: 'Español', name: 'Spanish' },
    fr: { native: 'Français', name: 'French' },
    ar: { native: 'العربية', name: 'Arabic', rtl: true },
    bn: { native: 'বাংলা', name: 'Bengali' },
    de: { native: 'Deutsch', name: 'German' },
    id: { native: 'Bahasa Indonesia', name: 'Indonesian' },
    it: { native: 'Italiano', name: 'Italian' },
    ja: { native: '日本語', name: 'Japanese' },
    ko: { native: '한국어', name: 'Korean' },
    mr: { native: 'मराठी', name: 'Marathi' },
    pt: { native: 'Português', name: 'Portuguese' },
    ru: { native: 'Русский', name: 'Russian' },
    ta: { native: 'தமிழ்', name: 'Tamil' },
    te: { native: 'తెలుగు', name: 'Telugu' },
    tr: { native: 'Türkçe', name: 'Turkish' },
    ur: { native: 'اردو', name: 'Urdu', rtl: true },
    vi: { native: 'Tiếng Việt', name: 'Vietnamese' },
  };
  // Pinned to the top of the picker; everything else follows alphabetically.
  const TOP = ['en', 'zh', 'hi', 'es', 'fr'];

  // What the visitor themselves reads in: their saved choice, else the browser.
  let own = 'en';
  try {
    own = localStorage.getItem('pp-lang') || (navigator.language || 'en').slice(0, 2).toLowerCase();
  } catch {}
  if (!LANGS[own]) own = 'en';

  // A server-rendered page declares the language it was written in, and that
  // wins for everything drawn on it. "/" is the English landing page even on a
  // Portuguese phone, and /pt stays Portuguese for an English one; each has its
  // own URL so nobody has to watch half a page change language under them.
  // Only where no page declares one -- the app -- does the visitor's choice decide.
  const pinned = typeof window.PP_PAGE_LANG === 'string' ? window.PP_PAGE_LANG.slice(0, 2).toLowerCase() : '';
  const lang = LANGS[pinned] ? pinned : own;

  let dict = {};
  let ready = Promise.resolve();
  if (lang !== 'en') {
    const cacheKey = 'pp-dict-' + lang;
    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached) dict = JSON.parse(cached) || {};
    } catch {}
    // Whether the first paint will be drawn from the mirror rather than from
    // the network -- which is the case that needs telling about below.
    const fromCache = Object.keys(dict).length > 0;
    const before = fromCache ? JSON.stringify(dict) : null;
    const fetched = fetch('/i18n/' + lang + '.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d || typeof d !== 'object') return;
        dict = d;
        try { localStorage.setItem(cacheKey, JSON.stringify(d)); } catch {}
        // The mirror is always one release behind: it is written by the
        // PREVIOUS visit, so every string added since renders in English
        // while the copy that has it is still in flight. The page has already
        // painted by now, so tell it to retext rather than leaving a returning
        // visitor to find the new features in a language they did not choose.
        if (fromCache && JSON.stringify(d) !== before) {
          window.PP_DICT_REFRESHED = true;
          try { document.dispatchEvent(new CustomEvent('pp-dict')); } catch {}
        }
      })
      .catch(() => {});
    // A cached copy is good enough to render immediately; otherwise wait for it.
    ready = fromCache ? Promise.resolve() : fetched;
  }

  // Right-to-left scripts need the whole document flipped, not just the words.
  try {
    const el = document.documentElement;
    el.lang = lang;
    if (LANGS[lang].rtl) el.dir = 'rtl';
  } catch {}

  window.PP_LANG = lang;
  window.PP_LANG_NAME = LANGS[lang].name;
  // The page's language and the reader's are not always the same one. Chrome
  // follows the page; a conversation follows the person, so somebody who opens
  // the English landing page and writes to Mila in Portuguese is answered in it.
  window.PP_USER_LANG = own;
  window.PP_USER_LANG_NAME = LANGS[own].name;
  window.PP_LANGS = Object.fromEntries(
    [...TOP.filter((c) => LANGS[c]), ...Object.keys(LANGS).filter((c) => !TOP.includes(c))]
      .map((c) => [c, LANGS[c].native]),
  );
  window.PP_READY = ready;
  window.PP_T = (key) => dict[key] || key;
  window.PP_SET_LANG = (l) => { try { localStorage.setItem('pp-lang', l); } catch {} location.reload(); };
})();
