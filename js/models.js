// The speech models this app can use, and the two "engines" that can run them.
// All are English-only versions of OpenAI's Whisper, converted for browsers.
//
// Engines:
//   "cpu"    = runs on the phone's main processor (WebAssembly). Slower, but
//              the one that is stable in Safari on iPhone today.
//   "webgpu" = runs on the graphics chip. Much faster where it works, but the
//              engine build it needs crashes Safari on iOS 26 (a known Safari
//              bug), so on Apple devices it is opt-in and marked experimental.
//
// The letters describe how the numbers inside the model are stored:
//   fp32 = full precision, fp16 = half precision (half the size),
//   q4 / q8 = compressed to 4 or 8 bits (much smaller, slightly less exact).

export const MODELS = {
  tiny: {
    id: 'onnx-community/whisper-tiny.en',
    label: 'Whisper tiny',
    blurb: 'Fastest, least accurate.',
    cpu: { dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' }, megabytes: 41 },
    webgpu: { dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, megabytes: 120 },
  },
  base: {
    id: 'onnx-community/whisper-base.en',
    label: 'Whisper base',
    blurb: 'A good balance of speed and accuracy.',
    cpu: { dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' }, megabytes: 77 },
    webgpu: { dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, megabytes: 206 },
  },
  small: {
    id: 'onnx-community/whisper-small.en',
    label: 'Whisper small',
    blurb: 'More accurate, about three times slower.',
    cpu: { dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' }, megabytes: 249 },
    // The full-precision encoder alone is 353 MB, the part most likely to
    // exhaust an iPhone's memory. Half precision is used when supported.
    webgpu: { dtype: { encoder_model: 'fp16', decoder_model_merged: 'q4' }, megabytes: 410 },
    webgpuNoF16: { dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, megabytes: 586 },
  },
};

export const DEFAULT_MODEL = 'base';

/** True in Safari and in every browser on iPhone/iPad (they all use Safari's engine). */
export function isAppleWebKit(nav = navigator) {
  const ua = nav.userAgent || '';
  return (nav.vendor || '').includes('Apple') && !/Chrome\/|Chromium\/|Android/.test(ua);
}

/**
 * Decide which engine to use.
 * @param {'auto'|'cpu'|'webgpu'} setting  what the user chose in Settings
 * @returns {'cpu'|'webgpu'}
 */
export function pickEngine(setting, nav = navigator) {
  if (setting === 'cpu') return 'cpu';
  if (!('gpu' in nav)) return 'cpu';
  if (setting === 'webgpu') return 'webgpu';
  return isAppleWebKit(nav) ? 'cpu' : 'webgpu';
}

/** If something crashes the page, this is the next, safer thing to try (null = nothing left). */
export function saferChoice(model, engine) {
  if (engine === 'webgpu') return { model, engine: 'cpu' };
  if (model === 'small') return { model: 'base', engine: 'cpu' };
  if (model === 'base') return { model: 'tiny', engine: 'cpu' };
  return null;
}
