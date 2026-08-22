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

  let lang = 'en';
  try {
    lang = localStorage.getItem('pp-lang') || (navigator.language || 'en').slice(0, 2).toLowerCase();
  } catch {}
  if (!LANGS[lang]) lang = 'en';

  let dict = {};
  let ready = Promise.resolve();
  if (lang !== 'en') {
    const cacheKey = 'pp-dict-' + lang;
    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached) dict = JSON.parse(cached) || {};
    } catch {}
    const fetched = fetch('/i18n/' + lang + '.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && typeof d === 'object') {
          dict = d;
          try { localStorage.setItem(cacheKey, JSON.stringify(d)); } catch {}
        }
      })
      .catch(() => {});
    // A cached copy is good enough to render immediately; otherwise wait for it.
    ready = Object.keys(dict).length ? Promise.resolve() : fetched;
  }

  // Right-to-left scripts need the whole document flipped, not just the words.
  try {
    const el = document.documentElement;
    el.lang = lang;
    if (LANGS[lang].rtl) el.dir = 'rtl';
  } catch {}

  window.PP_LANG = lang;
  window.PP_LANG_NAME = LANGS[lang].name;
  window.PP_LANGS = Object.fromEntries(
    [...TOP.filter((c) => LANGS[c]), ...Object.keys(LANGS).filter((c) => !TOP.includes(c))]
      .map((c) => [c, LANGS[c].native]),
  );
  window.PP_READY = ready;
  window.PP_T = (key) => dict[key] || key;
  window.PP_SET_LANG = (l) => { try { localStorage.setItem('pp-lang', l); } catch {} location.reload(); };
})();
