import test from 'node:test';
import assert from 'node:assert/strict';
import { resampleTo16k, measure } from '../js/resample.js';

function tone(freq, rate, seconds) {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

// How strongly a given pitch is present in a signal (0 = absent, 0.5 = our test tone).
function strengthAt(samples, freq, rate) {
  let re = 0;
  let im = 0;
  for (let i = 0; i < samples.length; i++) {
    re += samples[i] * Math.cos((2 * Math.PI * freq * i) / rate);
    im += samples[i] * Math.sin((2 * Math.PI * freq * i) / rate);
  }
  return (2 * Math.hypot(re, im)) / samples.length;
}

for (const rate of [48000, 44100, 24000, 96000]) {
  test(`a 1 kHz tone survives conversion from ${rate} to 16000`, () => {
    const out = resampleTo16k(tone(1000, rate, 1), rate);
    assert.ok(Math.abs(out.length - 16000) <= 1, `length ${out.length}`);
    assert.ok(Math.abs(strengthAt(out, 1000, 16000) - 0.5) < 0.01);
  });

  test(`a pitch too high for 16000 is removed, not folded into the speech range (${rate})`, () => {
    const out = resampleTo16k(tone(11000, rate, 1), rate);
    assert.ok(measure(out).rms < 0.01, `rms ${measure(out).rms}`);
  });
}

test('16000 input is passed through untouched', () => {
  const input = tone(440, 16000, 0.1);
  assert.equal(resampleTo16k(input, 16000), input);
});

test('empty input gives empty output', () => {
  assert.equal(resampleTo16k(new Float32Array(0), 48000).length, 0);
});

test('one minute of audio converts quickly', () => {
  const input = tone(300, 48000, 60);
  const t0 = performance.now();
  resampleTo16k(input, 48000);
  const ms = performance.now() - t0;
  assert.ok(ms < 2000, `took ${ms} ms`);
  console.log(`  60 s of audio resampled in ${ms.toFixed(0)} ms`);
});
