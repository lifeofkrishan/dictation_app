// Word error rate (WER): the standard score for speech recognition.
//
//   WER = (wrong words + missing words + extra words) / words in the script
//
// 0% is perfect. 10% means roughly one word in ten was wrong.
// Before comparing, both texts are simplified so that only real word mistakes
// count: capitals and punctuation are ignored, "double-check" equals
// "double check", and simple spelled-out numbers equal digits ("five" = "5").

const NUMBER_WORDS = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19',
  twenty: '20', thirty: '30', forty: '40', fifty: '50', sixty: '60', seventy: '70', eighty: '80', ninety: '90',
};
// "$20" and "twenty dollars" put the currency in a different place, so the
// currency itself is left out of the comparison.
const SAME_WORD = { ok: 'okay', 'e-mail': 'email', alright: 'all right', percent: '%', dollars: '', dollar: '' };

/** @returns {string[]} the words of `text` in simplified form */
export function normalizeForWer(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/(\d),(?=\d{3}\b)/g, '$1') // 4,200 -> 4200
    .replace(/%/g, ' % ')
    .replace(/[^\p{L}\p{N}'%\s-]/gu, ' ') // drop punctuation
    .split(/[\s-]+/)
    .map((word) => word.replace(/^'+|'+$/g, ''))
    .filter(Boolean)
    .flatMap((word) => (SAME_WORD[word] ?? NUMBER_WORDS[word] ?? word).split(' '))
    .filter(Boolean);
}

/**
 * Compare what was recognised with what was actually said.
 * @returns {{errors: number, words: number, rate: number,
 *            substitutions: number, deletions: number, insertions: number}}
 */
export function wordErrors(reference, hypothesis) {
  const ref = normalizeForWer(reference);
  const hyp = normalizeForWer(hypothesis);
  const rows = ref.length + 1;
  const cols = hyp.length + 1;
  // cost[i][j] = fewest edits to turn the first i script words into the first j recognised words
  const cost = Array.from({ length: rows }, () => new Uint32Array(cols));
  for (let i = 0; i < rows; i++) cost[i][0] = i;
  for (let j = 0; j < cols; j++) cost[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const same = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      cost[i][j] = Math.min(cost[i - 1][j - 1] + same, cost[i - 1][j] + 1, cost[i][j - 1] + 1);
    }
  }
  // Walk back to count each kind of mistake.
  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;
  for (let i = ref.length, j = hyp.length; i > 0 || j > 0; ) {
    if (i > 0 && j > 0 && cost[i][j] === cost[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) {
      if (ref[i - 1] !== hyp[j - 1]) substitutions++;
      i--;
      j--;
    } else if (i > 0 && cost[i][j] === cost[i - 1][j] + 1) {
      deletions++;
      i--;
    } else {
      insertions++;
      j--;
    }
  }
  const errors = substitutions + deletions + insertions;
  return { errors, words: ref.length, rate: ref.length ? errors / ref.length : hyp.length ? 1 : 0, substitutions, deletions, insertions };
}

/** Add up the scores of several sentences into one overall score. */
export function totalWordErrors(scores) {
  const total = { errors: 0, words: 0, substitutions: 0, deletions: 0, insertions: 0 };
  for (const s of scores) for (const key of Object.keys(total)) total[key] += s[key];
  return { ...total, rate: total.words ? total.errors / total.words : 0 };
}
