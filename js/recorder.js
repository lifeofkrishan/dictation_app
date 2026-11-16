// Microphone handling.
//
// There are two ways to capture audio, because Safari's audio stack is not
// fully dependable and we want a fallback rather than a dead app:
//
//   1. "pcm"      – read the raw samples straight from the microphone
//                   (best quality, includes a short pre-roll so the first
//                   word is not clipped). Needs a running AudioContext.
//   2. "recorder" – let the browser record a compressed clip (MediaRecorder)
//                   and decode it afterwards. Used when (1) is not available.
//
// Either way the result is the same: mono audio at 16,000 samples per second,
// held only in this page's memory.

import { resampleTo16k, measure, TARGET_RATE } from './resample.js';

const PRE_ROLL_SECONDS = 0.3;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Mic {
  /**
   * @param {{onChange?: (state: string) => void, onLevel?: (peak: number) => void}} callbacks
   */
  constructor({ onChange, onLevel } = {}) {
    this.onChange = onChange || (() => {});
    this.onLevel = onLevel || (() => {});
    this.options = { rawAudio: true, method: 'auto' }; // method: auto | pcm | recorder
    this.state = 'off'; // off | starting | ready | recording
    this.info = { armCount: 0 }; // facts for the diagnostics panel
    this.stream = null;
    this.ctx = null;
    this.node = null;
    this._arming = null;
  }

  _set(state) {
    if (this.state === state) return;
    this.state = state;
    this.onChange(state);
  }

  /** Turn the microphone on (asks for permission the first time). */
  arm() {
    if (this.stream) return Promise.resolve();
    if (!this._arming) {
      this._arming = this._arm().finally(() => {
        this._arming = null;
      });
    }
    return this._arming;
  }

  async _arm() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser does not let web pages use the microphone (the page must be opened over https).');
    }
    this._set('starting');
    const t0 = performance.now();
    const processing = !this.options.rawAudio;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: { ideal: 1 },
          echoCancellation: processing,
          noiseSuppression: processing,
          autoGainControl: processing,
        },
        video: false,
      });
    } catch (error) {
      this._set('off');
      throw error;
    }
    this.stream = stream;
    const track = stream.getAudioTracks()[0];
    track.addEventListener('ended', () => {
      this.info.lastTrackEvent = 'ended';
      if (this.stream === stream) this.disarm();
    });
    track.addEventListener('mute', () => (this.info.lastTrackEvent = 'mute'));
    track.addEventListener('unmute', () => (this.info.lastTrackEvent = 'unmute'));

    this.info.armCount += 1;
    this.info.trackLabel = track.label;
    try {
      this.info.trackSettings = track.getSettings();
    } catch {
      this.info.trackSettings = null;
    }
    this.info.pcmError = null;

    if (this.options.method !== 'recorder') {
      try {
        await this._buildGraph(stream);
      } catch (error) {
        this.info.pcmError = String(error?.message || error);
        this._closeGraph();
      }
    }
    this.info.armMs = Math.round(performance.now() - t0);
    this.info.contextState = this.ctx?.state ?? 'none';
    this.info.contextRate = this.ctx?.sampleRate ?? null;
    this._set('ready');
  }

  async _buildGraph(stream) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass || !window.AudioWorkletNode) throw new Error('AudioWorklet is not supported');
    const ctx = new AudioContextClass({ latencyHint: 'interactive' });
    this.ctx = ctx;
    await ctx.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url));
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'pcm-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { preRollSeconds: PRE_ROLL_SECONDS },
    });
    node.port.onmessage = (event) => this._onWorklet(event.data);
    // The audio must flow somewhere for the browser to keep processing it, so
    // it is sent to the speaker at zero volume (nothing is ever played back).
    const silent = ctx.createGain();
    silent.gain.value = 0;
    source.connect(node);
    node.connect(silent);
    silent.connect(ctx.destination);
    this.node = node;
    this.source = source;
    // Browsers only start an AudioContext after the user has touched the
    // page. Try now, but do not wait forever if it refuses.
    await Promise.race([ctx.resume().catch(() => {}), sleep(300)]);
  }

  /** Call this from any tap/click: it un-pauses audio if the browser paused it. */
  resumeAudio() {
    if (this.ctx && this.ctx.state !== 'running' && this.ctx.state !== 'closed') {
      this.ctx.resume().catch(() => {});
    }
  }

  _onWorklet(data) {
    if (data.samples) {
      if (this.state === 'recording' || this._stopping) {
        this.chunks.push(data.samples);
        this.capturedSamples += data.samples.length;
        this.onLevel(measure(data.samples).peak);
      }
    } else if (data.end && this._onEnd) {
      this._onEnd();
    }
  }

  _closeGraph() {
    try {
      this.source?.disconnect();
      this.node?.disconnect();
      if (this.node) this.node.port.onmessage = null;
      if (this.ctx && this.ctx.state !== 'closed') this.ctx.close().catch(() => {});
    } catch {
      /* nothing useful to do */
    }
    this.ctx = null;
    this.node = null;
    this.source = null;
  }

  /** Turn the microphone off completely (the orange dot goes away). */
  disarm() {
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
    }
    this.stream = null;
    this._closeGraph();
    this._set('off');
  }

  /** Begin capturing. Resolves once audio is actually being collected. */
  async start() {
    if (this.state === 'recording') return;
    await this.arm();
    if (!this.stream) throw new Error('The microphone was turned off before recording could start.');
    this.chunks = [];
    this.capturedSamples = 0;
    const wantPcm = this.options.method !== 'recorder';
    if (wantPcm && this.node && this.ctx.state !== 'running') {
      // The browser may have paused audio; a tap is allowed to un-pause it.
      // Give that a moment to take effect before settling for the fallback.
      await Promise.race([this.ctx.resume().catch(() => {}), sleep(150)]);
    }
    const pcmReady = !!this.node && this.ctx?.state === 'running';
    if (wantPcm && pcmReady) {
      this.mode = 'pcm';
      this.node.port.postMessage('start');
    } else if (this.options.method === 'pcm') {
      throw new Error(`Direct capture is not available (${this.info.pcmError || 'audio is paused: ' + (this.ctx?.state ?? 'no context')}).`);
    } else if (window.MediaRecorder) {
      this.mode = 'recorder';
      this.blobs = [];
      this.rec = new MediaRecorder(this.stream);
      this.rec.ondataavailable = (event) => {
        if (event.data && event.data.size) this.blobs.push(event.data);
      };
      this.rec.start();
    } else {
      throw new Error('This browser offers no way to record audio.');
    }
    this.startedAt = performance.now();
    this._set('recording');
  }

  /**
   * Finish capturing.
   * @returns {Promise<null | {samples: Float32Array, seconds: number, method: string,
   *   inputRate: number, wallSeconds: number, capturedSeconds: number, peak: number, rms: number}>}
   */
  async stop() {
    if (this.state !== 'recording') return null;
    const wallSeconds = (performance.now() - this.startedAt) / 1000;
    let raw;
    let inputRate;
    const method = this.mode;

    if (method === 'pcm') {
      this._stopping = true;
      inputRate = this.ctx.sampleRate;
      await new Promise((resolve) => {
        this._onEnd = resolve;
        this.node.port.postMessage('stop');
        setTimeout(resolve, 600); // do not hang if the audio thread is stuck
      });
      this._onEnd = null;
      this._stopping = false;
      raw = new Float32Array(this.capturedSamples);
      let offset = 0;
      for (const chunk of this.chunks) {
        raw.set(chunk, offset);
        offset += chunk.length;
      }
      this.chunks = [];
      this._set('ready');
    } else {
      const rec = this.rec;
      const blob = await new Promise((resolve) => {
        rec.onstop = () => resolve(new Blob(this.blobs, { type: rec.mimeType || this.blobs[0]?.type || '' }));
        rec.stop();
      });
      this.blobs = [];
      this.rec = null;
      this._set('ready');
      const decoded = await decodeBlob(blob);
      raw = decoded.samples;
      inputRate = decoded.sampleRate;
      this.info.recorderMime = blob.type;
    }

    const samples = resampleTo16k(raw, inputRate);
    const { peak, rms } = measure(samples);
    const result = {
      samples,
      seconds: samples.length / TARGET_RATE,
      method,
      inputRate,
      wallSeconds,
      capturedSeconds: raw.length / inputRate,
      peak,
      rms,
    };
    this.info.contextState = this.ctx?.state ?? 'none';
    this.info.last = {
      method,
      inputRate,
      heldSeconds: +wallSeconds.toFixed(2),
      capturedSeconds: +result.capturedSeconds.toFixed(2),
      peak: +peak.toFixed(4),
      rms: +rms.toFixed(4),
    };
    return result;
  }
}

/** Turn a compressed recording (from MediaRecorder) back into raw mono samples. */
async function decodeBlob(blob) {
  const bytes = await blob.arrayBuffer();
  const OfflineContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new OfflineContext(1, 1, 44100);
  const audio = await new Promise((resolve, reject) => {
    const maybePromise = ctx.decodeAudioData(bytes, resolve, reject);
    if (maybePromise && maybePromise.catch) maybePromise.catch(reject);
  });
  const samples = new Float32Array(audio.length);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const data = audio.getChannelData(c);
    for (let i = 0; i < data.length; i++) samples[i] += data[i] / audio.numberOfChannels;
  }
  return { samples, sampleRate: audio.sampleRate };
}
