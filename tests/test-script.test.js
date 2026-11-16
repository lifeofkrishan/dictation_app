import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SENTENCES, recommend } from '../js/test-script.js';
import { normalizeForWer } from '../js/wer.js';
import { cleanTranscript } from '../js/cleanup.js';

const result = (errors, speed, words = 250) => ({ status: 'done', speed, clean: { errors, words, rate: errors / words } });

test('there are 20 sentences and about 250 words', () => {
  assert.equal(DEFAULT_SENTENCES.length, 20);
  const words = DEFAULT_SENTENCES.reduce((sum, s) => sum + normalizeForWer(s).length, 0);
  assert.ok(words > 200 && words < 300, `words: ${words}`);
});

test('the clean-up rules leave every test sentence unchanged', () => {
  for (const sentence of DEFAULT_SENTENCES) assert.equal(cleanTranscript(sentence), sentence);
});

test('no result yet', () => {
  assert.equal(recommend(undefined, undefined).pick, null);
  assert.equal(recommend(undefined, result(5, 4)).pick, null);
});

test('small crashing or failing means base', () => {
  assert.equal(recommend(result(10, 8), { status: 'crashed', stage: 'loading the model' }).pick, 'base');
  assert.equal(recommend(result(10, 8), { status: 'failed', error: 'out of memory' }).pick, 'base');
});

test('a tiny accuracy difference is not a reason to use the bigger model', () => {
  assert.equal(recommend(result(10, 8), result(9, 4)).pick, 'base');
  assert.equal(recommend(result(10, 8), result(8, 4)).pick, 'base');
  assert.equal(recommend(result(10, 8), result(12, 4)).pick, 'base');
});

test('clearly more accurate and fast enough means small', () => {
  assert.equal(recommend(result(20, 8), result(10, 4)).pick, 'small');
});

test('more accurate but slow: small only if the gap is large', () => {
  assert.equal(recommend(result(14, 8), result(9, 1.5)).pick, 'base');
  assert.equal(recommend(result(30, 8), result(10, 1.5)).pick, 'small');
});
