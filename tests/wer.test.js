import test from 'node:test';
import assert from 'node:assert/strict';
import { wordErrors, totalWordErrors, normalizeForWer } from '../js/wer.js';

test('identical text scores zero, ignoring capitals and punctuation', () => {
  const s = wordErrors('Hello there, how are you?', 'hello there how are you');
  assert.equal(s.errors, 0);
  assert.equal(s.words, 5);
});

test('one wrong word, one missing word, one extra word', () => {
  assert.deepEqual(pick(wordErrors('the cat sat on the mat', 'the cat sat on a mat')), { substitutions: 1, deletions: 0, insertions: 0 });
  assert.deepEqual(pick(wordErrors('the cat sat on the mat', 'the cat sat the mat')), { substitutions: 0, deletions: 1, insertions: 0 });
  assert.deepEqual(pick(wordErrors('the cat sat on the mat', 'the big cat sat on the mat')), { substitutions: 0, deletions: 0, insertions: 1 });
  assert.equal(wordErrors('the cat sat on the mat', 'the cat sat on a mat').rate, 1 / 6);
});

test('formatting differences are not counted as mistakes', () => {
  assert.equal(wordErrors("Let's double-check at five.", 'Lets double check at 5').errors, 1); // only "let's" vs "lets"
  assert.equal(wordErrors('It costs twenty dollars, okay?', 'It costs $20, OK?').errors, 0);
  assert.equal(wordErrors('about 4,200 people', 'about 4200 people').errors, 0);
  assert.equal(wordErrors("we’ll go", "we'll go").errors, 0);
});

test('empty cases', () => {
  assert.equal(wordErrors('hello world', '').rate, 1);
  assert.equal(wordErrors('', '').rate, 0);
  assert.equal(wordErrors('', 'extra').rate, 1);
});

test('overall score is total errors over total words, not an average of percentages', () => {
  const total = totalWordErrors([wordErrors('a b c d e f g h', 'a b c d e f g h'), wordErrors('x y', 'x z')]);
  assert.equal(total.errors, 1);
  assert.equal(total.words, 10);
  assert.equal(total.rate, 0.1);
});

test('normalising splits and simplifies words', () => {
  assert.deepEqual(normalizeForWer("It's 5% — really!"), ["it's", '5', '%', 'really']);
});

function pick({ substitutions, deletions, insertions }) {
  return { substitutions, deletions, insertions };
}
