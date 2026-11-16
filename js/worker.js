// The transcription engine. It runs in a "worker" (a background thread) so the
// page stays responsive while Whisper is thinking.
//
// Privacy note: this file receives your audio as numbers in memory, runs the
// model on it, and sends text back to the page. It contains no code that
// uploads anything. Its only network use is downloading the model files from
// huggingface.co the first time (after that they come from the browser cache).

import { pipeline, env } from '../vendor/transformers/transformers.min.js';
import { MODELS } from './models.js';

const post = (message) => self.postMessage(message);

env.useWasmCache = false; // the service worker already keeps the engine files offline
env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true; // model files are stored on the device after the first download

// There are two builds of the engine, and one worker only ever uses one:
//
//   cpu    -> the plain build. Smaller, and the one that is stable in Safari.
//   webgpu -> the "asyncify" build, required to talk to the graphics chip.
//             Safari on iOS 26 can run out of memory compiling this build
//             and kill the page, which is why it is never used for "cpu".
const BUILDS = {
  cpu: { dir: '../vendor/ort/', suffix: '' },
  webgpu: { dir: '../vendor/ort-webgpu/', suffix: '.asyncify' },
};
function useBuild(engine) {
  const build = BUILDS[engine];
  const base = new URL(build.dir, import.meta.url).href;
  env.backends.onnx.wasm.wasmPaths = {
    mjs: `${base}ort-wasm-simd-threaded${build.suffix}.mjs`,
    wasm: `${base}ort-wasm-simd-threaded${build.suffix}.wasm`,
  };
  return `ort-wasm-simd-threaded${build.suffix}.wasm`;
}

let transcriber = null;

async function probeWebGPU() {
  if (!('gpu' in navigator)) return { ok: false, reason: 'this browser has no WebGPU' };
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return { ok: false, reason: 'WebGPU is present but no graphics adapter was offered' };
    return {
      ok: true,
      f16: adapter.features.has('shader-f16'),
      adapter: [adapter.info?.vendor, adapter.info?.architecture, adapter.info?.description].filter(Boolean).join(' ') || 'unknown',
    };
  } catch (error) {
    return { ok: false, reason: String(error?.message || error) };
  }
}

function progressReporter(expectedBytes) {
  const files = new Map();
  let lastSent = 0;
  return (event) => {
    if (event.status !== 'progress' && event.status !== 'done') return;
    if (event.status === 'progress' && event.total) files.set(event.file, { loaded: event.loaded, total: event.total });
    if (event.status === 'done' && files.has(event.file)) files.get(event.file).loaded = files.get(event.file).total;
    const now = performance.now();
    if (now - lastSent < 100 && event.status !== 'done') return;
    lastSent = now;
    let loadedBytes = 0;
    let totalBytes = 0;
    for (const f of files.values()) {
      loadedBytes += f.loaded;
      totalBytes += f.total;
    }
    post({ type: 'progress', loaded: loadedBytes, total: Math.max(totalBytes, expectedBytes) });
  };
}

async function load({ model, engine, encoder }) {
  const spec = MODELS[model];
  if (!spec) throw new Error(`Unknown model "${model}"`);
  if (transcriber) throw new Error('This worker already has a model; start a new worker instead.');

  let variant = spec.cpu;
  let gpu = null;
  if (engine === 'webgpu') {
    gpu = await probeWebGPU();
    if (!gpu.ok) throw new Error(`WebGPU cannot be used: ${gpu.reason}`);
    variant = spec.webgpuNoF16 && !gpu.f16 ? spec.webgpuNoF16 : spec.webgpu;
  }
  const dtype = { ...variant.dtype };
  if (engine === 'webgpu' && (encoder === 'fp32' || encoder === 'fp16')) dtype.encoder_model = encoder;
  const build = useBuild(engine === 'webgpu' ? 'webgpu' : 'cpu');
  const device = engine === 'webgpu' ? 'webgpu' : 'wasm';

  const t0 = performance.now();
  post({ type: 'stage', stage: 'download', megabytes: variant.megabytes });
  transcriber = await pipeline('automatic-speech-recognition', spec.id, {
    device,
    dtype,
    progress_callback: progressReporter(variant.megabytes * 1e6),
  });
  const t1 = performance.now();
  if (device === 'webgpu') {
    // First use of the graphics chip is slow (it has to prepare). Do that now
    // on one second of silence so your first real dictation is fast.
    post({ type: 'stage', stage: 'warmup' });
    await transcriber(new Float32Array(16000), { max_new_tokens: 4 });
  }
  const t2 = performance.now();
  post({ type: 'ready', model, modelId: spec.id, engine, device, dtype, build, loadMs: Math.round(t1 - t0), warmupMs: Math.round(t2 - t1), gpu });
}

async function transcribe({ id, audio }) {
  if (!transcriber) throw new Error('The model is not loaded.');
  const t0 = performance.now();
  // Whisper listens in 30-second windows. Longer recordings are cut into
  // overlapping windows and stitched back together.
  const long = audio.length > 30 * 16000;
  const output = await transcriber(audio, long ? { chunk_length_s: 30, stride_length_s: 5 } : {});
  const text = (Array.isArray(output) ? output[0]?.text : output?.text) ?? '';
  post({ type: 'result', id, text, ms: Math.round(performance.now() - t0) });
}

// Handle one request at a time, in order.
let queue = Promise.resolve();
self.onmessage = (event) => {
  const message = event.data;
  queue = queue.then(async () => {
    try {
      if (message.type === 'load') await load(message);
      else if (message.type === 'transcribe') await transcribe(message);
    } catch (error) {
      post({ type: 'error', id: message.id ?? null, during: message.type, message: String(error?.message || error).slice(0, 500) });
    }
  });
};
