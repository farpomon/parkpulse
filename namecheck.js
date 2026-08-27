// First-name screening.
//
// Mila greets people by name, puts that name in her prompts, and prints it at
// the top of an emailed plan. So a name is not just stored -- it is spoken back,
// repeatedly, in a friendly voice. "Pica Dura" got through the first version of
// this and the app cheerfully addressed the user with it.
//
// Three rules keep the screen honest:
//
//  1. WHOLE TOKENS, never substrings, for anything in a Latin script. Substring
//     matching is how Scunthorpe, Penistone and half of Portugal get blocked.
//  2. PHRASES are matched as consecutive token runs, so "pica dura" is caught
//     without banning "Pica" or "Dura" on their own -- and "Ana Lisa" survives.
//  3. Scripts with no word spacing (Chinese, Japanese, Korean, Arabic, the
//     Indic scripts, Thai) are matched as substrings of the raw string, which
//     is safe there precisely because those words don't tokenize.
//
// The check runs on the raw input, before the sanitizer strips punctuation, so
// leetspeak ("P1c4") and padding ("f u c k") are seen as written.
//
// Everything here is deliberately conservative: a false block is a real person
// told their name is rude, which is worse than a rare miss. Ambiguous words
// that are also ordinary names or nouns -- concha, pinto, pau, rola, magi, lon,
// dung, cu -- are left OUT of the single-word list and caught in phrases only.

// --- Single words --------------------------------------------------------
// Unambiguous in the languages ParkPulse serves. One line per language so the
// list stays auditable; duplicates across languages are harmless (it's a Set).
const HARD_WORDS = [
  // English
  'fuck', 'fucker', 'fucking', 'fuk', 'fuck', 'motherfucker', 'shit', 'shite', 'bullshit',
  'bitch', 'cunt', 'asshole', 'arsehole', 'bastard', 'whore', 'slut', 'twat', 'wanker', 'wank',
  'prick', 'bollocks', 'dick', 'dickhead', 'jizz', 'cum', 'pussy', 'boner', 'penis', 'vagina',
  'anus', 'turd', 'dildo', 'blowjob', 'handjob', 'nutsack', 'titties', 'rapist',
  // Known tradeoff, inherited from the first version of this list: 'dick' is
  // also Richard's nickname, so a man actually named Dick gets the note and
  // has to enter Richard. Kept because the field is a first name a fairy says
  // out loud, and the fallback is a kind sentence, not a rejection.
  // Slurs. These never get a pass, in any field.
  'nigger', 'nigga', 'faggot', 'chink', 'spic', 'kike', 'wetback', 'coon', 'gook', 'tranny',
  'paki', 'raghead', 'towelhead', 'beaner', 'zipperhead',
  // Spanish
  'puta', 'puto', 'mierda', 'cono', 'cabron', 'pendejo', 'gilipollas', 'joder', 'polla', 'verga',
  'chingar', 'chingada', 'culero', 'mamon', 'pinche', 'maricon', 'pajero', 'cojones', 'follar',
  'panocha', 'zorra', 'pelotudo', 'boludo',
  // Portuguese
  'caralho', 'porra', 'buceta', 'foda', 'foder', 'merda', 'viado', 'veado', 'cuzao', 'piroca',
  'corno', 'arrombado', 'bosta', 'xoxota', 'punheta', 'boquete', 'vadia', 'pica', 'picas',
  // French
  'putain', 'salope', 'connard', 'connasse', 'encule', 'pute', 'bite', 'couilles', 'foutre',
  'salaud', 'batard', 'bordel', 'niquer', 'chatte', 'pede', 'tapette', 'enfoire',
  // German
  'scheisse', 'fotze', 'arschloch', 'hurensohn', 'wichser', 'schlampe', 'arsch', 'ficken',
  'schwanz', 'muschi', 'nutte', 'hure', 'kacke',
  // Italian
  'cazzo', 'stronzo', 'puttana', 'vaffanculo', 'troia', 'minchia', 'figa', 'fica', 'coglione',
  'coglioni', 'zoccola', 'stronza', 'culo',
  // Russian (transliterations; the Cyrillic forms are in SCRIPT_WORDS)
  'blyad', 'blyat', 'suka', 'mudak', 'pizda', 'ebat', 'pidor', 'pidoras', 'zalupa', 'gandon',
  // Turkish
  'orospu', 'siktir', 'sikerim', 'sikeyim', 'yarrak', 'amcik', 'kahpe', 'yarrag',
  // Indonesian
  'kontol', 'memek', 'ngentot', 'bangsat', 'jancok', 'pepek', 'kimak',
  // Hindi / Urdu / Marathi (transliterations)
  'chutiya', 'chutiye', 'madarchod', 'behenchod', 'bhenchod', 'bhosdi', 'bhosdike', 'randi',
  'lund', 'gaand', 'gandu', 'harami', 'chodu', 'lauda', 'lawda',
  // Bengali / Tamil / Telugu (transliterations)
  'khanki', 'chuda', 'pundai', 'thevidiya', 'lanja', 'dengu',
  // Arabic (transliterations)
  'sharmoota', 'sharmuta', 'kahba', 'gahba', 'khawal', 'manyak', 'zermal',
  // Korean / Japanese / Chinese (transliterations)
  'sibal', 'ssibal', 'byungshin', 'gaesaekki', 'shabi', 'jiba', 'biaozi', 'chinko', 'manko',
];

// --- Phrases -------------------------------------------------------------
// Matched as consecutive tokens, so each word stays usable on its own.
const HARD_PHRASES = [
  'pica dura', 'pica mole', 'hijo de puta', 'hija de puta', 'hijo de perra', 'chupa me',
  'filho da puta', 'filha da puta', 'vai tomar no cu', 'vai se foder', 'toma no cu',
  'son of a bitch', 'mother fucker', 'go fuck yourself', 'suck my',
  'fils de pute', 'nique ta mere', 'va te faire', 'ta gueule',
  'figlio di puttana', 'porca puttana', 'porca troia',
  'cao ni ma', 'ni ma bi', 'wo cao',
  // The classic prank names. This family is exactly what a name field attracts,
  // and each is harmless word by word -- phrases are the only way to catch them.
  'ben dover', 'mike hunt', 'hugh jass', 'hugh janus', 'seymour butts', 'jack mehoff',
  'mike rotch', 'eileen dover', 'connie lingus', 'anita bath', 'wayne kerr', 'pat mycrotch',
  'moe lester', 'ivana tinkle', 'oliver clothesoff', 'dixie normous', 'phil mccracken',
  'harry balls', 'al coholic', 'bea otch', 'ollie tabooger',
];

// --- Non-spacing scripts -------------------------------------------------
// Substring-matched against the raw lowercased input. Safe here because these
// languages don't put spaces between words, so there are no token boundaries
// to respect and no innocent word that merely contains one of these.
const SCRIPT_WORDS = [
  // Chinese
  '操你妈', '肏', '傻逼', '傻屄', '屌', '屄', '妈的', '鸡巴', '婊子', '贱人', '干你娘', '死全家',
  // Japanese
  'ちんこ', 'ちんぽ', 'まんこ', 'おまんこ', 'きちがい', 'くたばれ',
  // Korean
  '씨발', '시발', '씹', '좆', '병신', '개새끼', '지랄', '보지',
  // Russian
  'хуй', 'хуё', 'пизд', 'ебат', 'ебал', 'блядь', 'блять', 'сука', 'мудак', 'пидор', 'залуп',
  // Arabic / Urdu
  'كس', 'طيز', 'شرموط', 'قحبة', 'منيوك', 'خول', 'زبي', 'لوطي',
  // Devanagari (Hindi, Marathi)
  'चूतिया', 'भोसड़', 'मादरचोद', 'बहनचोद', 'रंडी', 'लंड', 'गांड',
  // Bengali
  'বাল', 'খানকি', 'চুদ',
  // Tamil / Telugu
  'புண்டை', 'ஓத்தா', 'దెంగ', 'పూకు',
  // Vietnamese — kept in fully accented form on purpose. Stripped of tone marks
  // these collide with ordinary Vietnamese names (Lộc, Dũng, Cầu), so they are
  // matched only exactly as written.
  'lồn', 'cặc', 'địt', 'buồi',
];

const WORD_SET = new Set(HARD_WORDS);
const PHRASE_LIST = HARD_PHRASES.map((p) => p.split(' '));

// 4→a, 1→i and friends. Applied to a copy used only for matching, never to the
// name we store — "Zoë" must come back out as "Zoë", not "Zoe".
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i', '|': 'i', '+': 't' };

// Strip diacritics, fold leetspeak, and collapse runs ("fuuuck" -> "fuck", but
// "Aaron" keeps its pair — only runs of three or more collapse).
function foldLatin(s) {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[014357 8@$!|+]/g, (c) => (c === ' ' ? ' ' : LEET[c] ?? c))
    .replace(/(.)\1{2,}/g, '$1');
}

// Letters only, everything else becomes a separator. Punctuation between
// letters is a separator too, so "f.u.c.k" and "p-u-t-a" both land as tokens —
// then the single-letter run is rejoined below.
function tokensOf(folded) {
  return folded.split(/[^a-z]+/).filter(Boolean);
}

// Cyrillic and Greek letters that are drawn like Latin ones. Swapping one in
// ("рuta", with a Cyrillic er) is the oldest way past a word list, and the
// result is indistinguishable on screen. Folded for MATCHING only -- a real
// Cyrillic or Greek name is stored exactly as typed.
const HOMOGLYPH = {
  а: 'a', в: 'b', с: 'c', е: 'e', н: 'h', к: 'k', м: 'm', о: 'o', р: 'p', ѕ: 's',
  т: 't', и: 'u', х: 'x', у: 'y', ј: 'j', і: 'i', ԁ: 'd', ɡ: 'g',
  α: 'a', β: 'b', ε: 'e', ι: 'i', κ: 'k', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ν: 'v',
};
const foldHomoglyph = (s) => s.replace(/[\u0370-\u04FF\u1D00-\u1D7F]/g, (c) => HOMOGLYPH[c] ?? c);

// Token and phrase matching over one folded form of the input.
function latinHit(folded) {
  const tokens = tokensOf(folded);
  if (tokens.some((t) => WORD_SET.has(t))) return true;
  // "f u c k" and "p.u.t.a": if every token is a single letter, the name is
  // not a name — glue them and check the word that was being spelled out.
  if (tokens.length > 2 && tokens.every((t) => t.length === 1) && WORD_SET.has(tokens.join(''))) return true;
  for (const phrase of PHRASE_LIST) {
    if (phrase.length > tokens.length) continue;
    for (let i = 0; i + phrase.length <= tokens.length; i++) {
      if (phrase.every((w, j) => tokens[i + j] === w)) return true;
    }
  }
  return false;
}

function isProfane(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return false;
  const lower = raw.toLowerCase();
  // Non-spacing scripts: plain substring, on the untouched string.
  if (SCRIPT_WORDS.some((w) => lower.includes(w))) return true;

  // Two passes: the name as written, and the name with look-alike letters
  // folded to Latin. The second only ever adds matches.
  if (latinHit(foldLatin(raw))) return true;
  const deglyphed = foldHomoglyph(raw.toLowerCase());
  if (deglyphed !== raw.toLowerCase() && latinHit(foldLatin(deglyphed))) return true;
  return false;
}

// The only export the app calls. Returns the name to store (null when there is
// nothing usable) plus whether we refused it, so callers can say so kindly.
function cleanFirstName(raw) {
  if (typeof raw !== 'string') return { name: null, profane: false };
  if (isProfane(raw)) return { name: null, profane: true };
  const name = raw.replace(/[\u{10000}-\u{10FFFF}]/gu, '').replace(/[^\p{L}\p{M}' \-]/gu, '')
    .replace(/\s+/g, ' ').trim().slice(0, 30);
  if (!name) return { name: null, profane: false };
  // Title-case for display so "luis" greets as "Luis".
  return { name: name.replace(/\p{L}[\p{L}\p{M}']*/gu, (w) => w[0].toUpperCase() + w.slice(1)), profane: false };
}

// What we say instead of the word: kind, in character, and it names the
// stand-in so the app's later greetings make sense.
const NAME_NOTE = "That one made Mila hide behind her wings! We'll go with 'Dear Friend' for now — you can tell us your real name any time in your account.";

module.exports = { cleanFirstName, isProfane, NAME_NOTE };
