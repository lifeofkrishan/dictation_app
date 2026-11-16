// Turns Whisper's raw transcript into the text you actually want.
//
// Everything here is a fixed rule: no AI, no network, same input always gives
// the same output. The steps, in order:
//
//   1. remove non-speech tags such as [BLANK_AUDIO] or (music)
//   2. remove filler sounds:            "um", "uh", "er", "ah", "hmm"
//   3. collapse stuttered short words:  "the the" -> "the", "I, I" -> "I"
//   4. spoken commands:                 "new line", "new paragraph",
//                                       "bullet point", "scratch that"
//   5. tidy spacing, punctuation and capital letters
//   6. your personal dictionary (last, so your spelling always wins)

const MARK = ''; // invisible placeholder left where something was removed
const BULLET = '• ';

const LETTER = String.raw`[\p{L}\p{N}]`;
const NOT_IN_WORD_BEFORE = String.raw`(?<![\p{L}\p{N}'’-])`;
const NOT_IN_WORD_AFTER = String.raw`(?![\p{L}\p{N}'’-])`;

// ---------------------------------------------------------------- step 1
const SOUND_WORDS = 'music|laugh|applause|silence|inaudible|blank|sigh|cough|noise|static|breath|clears throat|beep|bell|sound|clapping|cheering';
const TAGS = new RegExp(String.raw`\[[^\]\n]{0,40}\]|\((?:[^)\n]{0,30}\b(?:${SOUND_WORDS})[^)\n]{0,30})\)|\*[^*\n]{1,30}\*`, 'gi');

// ---------------------------------------------------------------- step 2
// Lower-case or Capitalised only, so "ER" (emergency room) or "UM" are left alone.
const FILLERS = new RegExp(
  NOT_IN_WORD_BEFORE + String.raw`(?:[Uu]m+|[Uu]h+m*|[Ee]r+m*|[Aa]h+|[Hh]m+|[Mm]hm+)` + NOT_IN_WORD_AFTER + String.raw`(?:[ \t]*,)?`,
  'gu',
);

// ---------------------------------------------------------------- step 3
// Short words that people do say twice on purpose ("I know that that is true").
const DOUBLES_ON_PURPOSE = new Set([
  'that', 'had', 'very', 'much', 'many', 'long', 'far', 'way', 'no', 'bye', 'ha', 'ho', 'la', 'now', 'well', 'blah', 'yada', 'tut', 'da', 'na',
]);
const REPEATS = new RegExp(
  NOT_IN_WORD_BEFORE + String.raw`([\p{L}'’]{1,4})((?:[ \t${MARK}]*,?[ \t${MARK}]+\1` + NOT_IN_WORD_AFTER + String.raw`)+)`,
  'giu',
);

// ---------------------------------------------------------------- step 4
// "a new line of products" is ordinary speech, not a command. If one of these
// words comes directly before the phrase, it is left as text.
const ORDINARY_SPEECH_BEFORE = /\b(?:a|an|the|another|each|every|per|one|first|second|third|last|next|same|single|my|your|our|their|his|her|its)[ \t]+$/i;
const LINE_COMMANDS = /([,;:\-–—]?[ \t]*)\b(new[ \t-]*paragraph|new[ \t-]*line|bullet[ \t-]*point)\b(?!-)([ \t]*[,;:.!?…]*)[ \t]*/gi;
// "scratch that" only counts when it ends a phrase ("...at five. Scratch that.").
// "scratch that itch" is left alone.
const SCRATCH = /[ \t]*[,;:\-–—]?[ \t]*\bscratch[ \t-]+that\b(?=[ \t]*(?:[,;:.!?…\n]|$))[ \t]*[,;:.!?…]*[ \t]*/gi;
const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'inc', 'ltd', 'co', 'no', 'approx', 'e.g', 'i.e', 'eg', 'ie']);

function applyLineCommands(text) {
  return text.replace(LINE_COMMANDS, (match, lead, phrase, trail, offset, whole) => {
    const before = whole.slice(0, offset + lead.length);
    const after = whole.slice(offset + match.length);
    const onlySpacesBefore = !/[^ \t]/.test(lead);
    if (onlySpacesBefore && ORDINARY_SPEECH_BEFORE.test(before)) return match;
    if (!trail.trim() && /^of\b/i.test(after)) return match;
    const key = phrase.toLowerCase().replace(/[ \t-]+/g, '');
    if (key === 'newparagraph') return '\n\n';
    if (key === 'bulletpoint') return '\n' + BULLET;
    return '\n';
  });
}

function endsAnAbbreviation(text) {
  const word = /([\p{L}.]+)$/u.exec(text)?.[1] ?? '';
  return /^\p{Lu}$/u.test(word) || ABBREVIATIONS.has(word.toLowerCase());
}

/** Remove the last sentence (or, if nothing was said since, the last line break). */
function dropLastSentence(text) {
  const t = text.replace(/[ \t]+$/, '');
  if (!t) return '';
  const lineBreak = t.match(/\n+(?:• ?)?$|^• ?$/);
  if (lineBreak) return t.slice(0, t.length - lineBreak[0].length);

  const body = t.replace(/[.!?…"'’”)\]]+$/, ''); // ignore this sentence's own full stop
  const boundary = /[.!?…]+["'’”)\]]*[ \t]+|\n(?:• )?/g;
  let cut = 0;
  for (let m; (m = boundary.exec(body)); ) {
    if (m[0][0] === '.' && endsAnAbbreviation(body.slice(0, m.index))) continue;
    cut = m.index + m[0].length;
  }
  return t.slice(0, cut).replace(/[ \t]+$/, '');
}

function applyScratchThat(text) {
  const pieces = text.split(SCRATCH);
  let result = pieces[0];
  for (let i = 1; i < pieces.length; i++) {
    result = dropLastSentence(result);
    const next = pieces[i];
    const needsSpace = result && next && !/\n(?:• )?$/.test(result) && !/^\n/.test(next);
    result += (needsSpace ? ' ' : '') + MARK + next;
  }
  return result;
}

// ---------------------------------------------------------------- step 5
const upper = (ch) => ch.toLocaleUpperCase();

function tidy(text) {
  let t = text;
  const sentenceStart = String.raw`(^|[.!?…]["'’”)\]]*[ \t]+|\n[ \t]*(?:• )?)((?:[ \t]*${MARK}[ \t]*)+)`;
  // "Okay. Um. So" -> the filler was a whole sentence, so its full stop goes too.
  t = t.replace(new RegExp(sentenceStart + String.raw`[.!?…,;:]+[ \t]*`, 'g'), (m, lead) => lead + MARK);
  // A removal at the start of a sentence means the next word now starts it.
  t = t.replace(
    new RegExp(String.raw`(^|[.!?…]["'’”)\]]*[ \t]+|\n[ \t]*(?:• )?)((?:[ \t]*${MARK}[ \t]*)+)(\p{Ll})`, 'gu'),
    (m, lead, marks, ch) => lead + upper(ch),
  );
  t = t.replaceAll(MARK, '');

  t = t.replace(/[ \t]+/g, ' ');
  t = t.replace(/ +([,.;:!?…])/g, '$1');
  for (let previous = null; previous !== t; ) {
    previous = t;
    t = t.replace(/,[ ]*([,.;:!?…])/g, '$1'); // ", ." -> "."   ", ," -> ","
    t = t.replace(/([.!?…;:])[ ]*,/g, '$1'); // ". ," -> "."
    t = t.replace(/([.!?…]) +[.!?…](?= |\n|$)/g, '$1'); // "Okay. . So" -> "Okay. So"
  }
  t = t.replace(/(^|\n) *(?:[,;:]+|\.(?!\.)) */g, '$1'); // a line cannot start with , ; : .
  t = t.replace(/ *\n */g, '\n');
  t = t.replace(/\n• ?(?=\n|$)/g, ''); // empty bullets
  t = t.replace(/^• ?(?=\n|$)/, '');
  t = t.replace(/\n{3,}/g, '\n\n');
  t = t.trim();
  // Every line (and every bullet) starts with a capital letter.
  t = t.replace(/(^|\n)((?:• )?)(\p{Ll})/gu, (m, lead, bullet, ch) => lead + bullet + upper(ch));
  return t;
}

// ---------------------------------------------------------------- step 6
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Read the personal dictionary the user typed, one entry per line:
 *
 *   Siobhan                     <- "always spell it like this" (fixes capitals / spacing)
 *   cube control = kubectl      <- "when you hear the left side, write the right side"
 *
 * Lines starting with # are notes and are ignored.
 * @returns {{pattern: RegExp, to: string, from: string}[]}
 */
export function parseDictionary(source) {
  const entries = [];
  for (const rawLine of String(source || '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const arrow = line.match(/^(.*?)\s*(?:=>|->|=)\s*(.*)$/);
    let from;
    let to;
    let body;
    if (arrow && arrow[1].trim() && arrow[2].trim()) {
      from = arrow[1].trim();
      to = arrow[2].trim();
      body = from.split(/[\s-]+/).map(escapeRegExp).join(String.raw`[ \t-]+`);
    } else if (!arrow) {
      from = to = line;
      // "GitHub" should also catch "git hub", "Git-Hub" and "github".
      const parts = line.split(/[\s-]+/).flatMap((word) => word.split(/(?<=\p{Ll})(?=\p{Lu})/u));
      body = parts.map(escapeRegExp).join(String.raw`[ \t-]*`);
    } else {
      continue; // "something =" with one side missing
    }
    try {
      entries.push({ from, to, pattern: new RegExp(`(?<!${LETTER})${body}(?!${LETTER})`, 'giu') });
    } catch {
      /* an entry the browser cannot turn into a pattern is skipped */
    }
  }
  // Longer phrases first, so "New York Times" wins over "New York".
  entries.sort((a, b) => b.from.length - a.from.length);
  return entries;
}

function applyDictionary(text, entries) {
  let t = text;
  for (const entry of entries) t = t.replace(entry.pattern, () => entry.to);
  return t;
}

// ---------------------------------------------------------------- everything together
export const DEFAULT_CLEANUP = { commands: true, fillers: true, repeats: true };

/**
 * @param {string} raw  what Whisper produced
 * @param {{commands?: boolean, fillers?: boolean, repeats?: boolean,
 *          dictionary?: ReturnType<typeof parseDictionary>}} options
 */
export function cleanTranscript(raw, options = {}) {
  const { commands, fillers, repeats } = { ...DEFAULT_CLEANUP, ...options };
  let t = String(raw || '').replaceAll(MARK, '').replace(/\s+/g, ' ').trim();

  t = t.replace(TAGS, MARK);
  if (fillers) t = t.replace(FILLERS, MARK);
  if (repeats) {
    t = t.replace(REPEATS, (match, word) => (DOUBLES_ON_PURPOSE.has(word.toLowerCase()) ? match : word));
  }
  if (commands) {
    t = applyLineCommands(t);
    t = applyScratchThat(t);
  }
  t = tidy(t);
  if (options.dictionary?.length) t = applyDictionary(t, options.dictionary);
  return t;
}
