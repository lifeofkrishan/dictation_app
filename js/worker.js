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

// ---- where the engine files live (inside this project, not on a CDN) ----
function isSafariBelow26() {
  const ua = navigator.userAgent;
  const isSafari =
    (navigator.vendor || '').includes('Apple') && !/CriOS|FxiOS|EdgiOS|OPiOS|mercury|brave/i.test(ua) && !ua.includes('Chrome') && !ua.includes('Android');
  const match = ua.match(/Version\/(\d+)/);
  return isSafari && match ? parseInt(match[1], 10) < 26 : false;
}
// Older Safari without WebGPU needs the plain build (same rule the library uses).
const suffix = isSafariBelow26() && !('gpu' in navigator) ? '' : '.asyncify';
const ORT = new URL('../vendor/ort/', import.meta.url).href;
env.backends.onnx.wasm.wasmPaths = {
  mjs: `${ORT}ort-wasm-simd-threaded${suffix}.mjs`,
  wasm: `${ORT}ort-wasm-simd-threaded${suffix}.wasm`,
};
env.useWasmCache = false; // the service worker already keeps these files offline
env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true; // model files are stored on the device after the first download

let transcriber = null;
let loaded = null; // facts about what is loaded, for the diagnostics panel

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

async function load({ model, device: forced, encoder }) {
  const spec = MODELS[model];
  if (!spec) throw new Error(`Unknown model "${model}"`);
  if (transcriber) {
    await transcriber.dispose().catch(() => {});
    transcriber = null;
  }

  const gpu = forced === 'wasm' ? { ok: false, reason: 'switched off in settings' } : await probeWebGPU();
  const attempts = [];
  if (gpu.ok) {
    const variant = spec.webgpuNoF16 && !gpu.f16 ? spec.webgpuNoF16 : spec.webgpu;
    const dtype = { ...variant.dtype };
    if (encoder === 'fp32' || encoder === 'fp16') dtype.encoder_model = encoder;
    attempts.push({ device: 'webgpu', dtype, megabytes: variant.megabytes });
  }
  if (forced !== 'webgpu') attempts.push({ device: 'wasm', dtype: spec.wasm.dtype, megabytes: spec.wasm.megabytes });

  const notes = [];
  if (!gpu.ok) notes.push(`WebGPU not used: ${gpu.reason}`);

  for (const attempt of attempts) {
    try {
      const t0 = performance.now();
      post({ type: 'stage', stage: 'download', device: attempt.device, megabytes: attempt.megabytes });
      transcriber = await pipeline('automatic-speech-recognition', spec.id, {
        device: attempt.device,
        dtype: attempt.dtype,
        progress_callback: progressReporter(attempt.megabytes * 1e6),
      });
      const t1 = performance.now();
      // First use is slow (the graphics chip has to prepare). Do that now on
      // one second of silence so your first real dictation is fast.
      post({ type: 'stage', stage: 'warmup', device: attempt.device });
      await transcriber(new Float32Array(16000), { max_new_tokens: 4 });
      const t2 = performance.now();
      loaded = {
        model,
        modelId: spec.id,
        device: attempt.device,
        dtype: attempt.dtype,
        loadMs: Math.round(t1 - t0),
        warmupMs: Math.round(t2 - t1),
        gpu,
        notes,
      };
      post({ type: 'ready', ...loaded });
      return;
    } catch (error) {
      notes.push(`${attempt.device} failed: ${String(error?.message || error).slice(0, 300)}`);
      if (transcriber) await transcriber.dispose().catch(() => {});
      transcriber = null;
    }
  }
  throw new Error(notes.join(' | ') || 'No way to run the model in this browser.');
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
      post({ type: 'error', id: message.id ?? null, during: message.type, message: String(error?.message || error) });
    }
  });
};
