// Whisper needs audio at 16,000 samples per second. Phone microphones usually
// deliver 48,000 (sometimes 44,100). This file converts between the two.
//
// It is done in plain JavaScript on purpose: Safari's built-in audio
// resampling has a history of quirks, and doing it here means the result is
// identical in every browser and can be checked by an automated test.

export const TARGET_RATE = 16000;

const PHASES = 32; // how finely we handle "in-between" sample positions

/**
 * @param {Float32Array} input  mono audio samples
 * @param {number} inputRate    samples per second of `input`
 * @returns {Float32Array}      the same audio at 16,000 samples per second
 */
export function resampleTo16k(input, inputRate) {
  if (!input.length || inputRate === TARGET_RATE) return input;

  const ratio = inputRate / TARGET_RATE;
  const outLength = Math.floor(input.length / ratio);
  const out = new Float32Array(outLength);

  // Before dropping samples we must remove pitches too high for the new rate
  // to represent (otherwise they fold back as noise). `cutoff` does that.
  const cutoff = Math.min(1, 1 / ratio) * 0.95;
  const half = Math.ceil(10 * Math.max(1, ratio));
  const taps = 2 * half + 1;

  // Pre-compute the filter once for each in-between position.
  const kernels = new Float32Array(PHASES * taps);
  for (let p = 0; p < PHASES; p++) {
    let sum = 0;
    for (let t = 0; t < taps; t++) {
      const x = t - half - p / PHASES;
      const a = x * cutoff;
      const sinc = a === 0 ? 1 : Math.sin(Math.PI * a) / (Math.PI * a);
      const window = Math.abs(x) >= half ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * x) / half);
      const k = sinc * window;
      kernels[p * taps + t] = k;
      sum += k;
    }
    for (let t = 0; t < taps; t++) kernels[p * taps + t] /= sum;
  }

  const last = input.length - 1;
  for (let i = 0; i < outLength; i++) {
    const center = i * ratio;
    let base = Math.floor(center);
    let phase = Math.round((center - base) * PHASES);
    if (phase === PHASES) {
      phase = 0;
      base += 1;
    }
    const k0 = phase * taps;
    const start = base - half;
    let acc = 0;
    if (start >= 0 && start + taps - 1 <= last) {
      for (let t = 0; t < taps; t++) acc += input[start + t] * kernels[k0 + t];
    } else {
      // Near the very start/end: reuse the edge sample instead of reading
      // outside the recording.
      for (let t = 0; t < taps; t++) {
        const j = start + t;
        acc += input[j < 0 ? 0 : j > last ? last : j] * kernels[k0 + t];
      }
    }
    out[i] = acc;
  }
  return out;
}

/** Loudness facts about a recording, used to detect silence and report problems. */
export function measure(samples) {
  let peak = 0;
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
    sumSquares += v * v;
  }
  return { peak, rms: samples.length ? Math.sqrt(sumSquares / samples.length) : 0 };
}
