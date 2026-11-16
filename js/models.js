// The speech models this app can use. Both are English-only versions of
// OpenAI's Whisper, converted to run in a browser.
//
// "webgpu" = the fast path (runs on the phone's graphics chip).
// "wasm"   = the slower fallback (runs on the main processor).
//
// The letters describe how the numbers inside the model are stored:
//   fp32 = full precision, fp16 = half precision (half the size),
//   q4 / q8 = compressed to 4 or 8 bits (much smaller, slightly less exact).

export const MODELS = {
  base: {
    id: 'onnx-community/whisper-base.en',
    label: 'Whisper base',
    blurb: 'Faster and lighter.',
    webgpu: { dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, megabytes: 206 },
    wasm: { dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' }, megabytes: 77 },
  },
  small: {
    id: 'onnx-community/whisper-small.en',
    label: 'Whisper small',
    blurb: 'More accurate, about three times the work.',
    // The full-precision encoder alone is 353 MB, which is the part most
    // likely to exhaust an iPhone's memory. Half precision is used when the
    // graphics chip supports it.
    webgpu: { dtype: { encoder_model: 'fp16', decoder_model_merged: 'q4' }, megabytes: 410 },
    webgpuNoF16: { dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, megabytes: 586 },
    wasm: { dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' }, megabytes: 249 },
  },
};

export const DEFAULT_MODEL = 'base';
