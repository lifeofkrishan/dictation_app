// The page's handle on the transcription engine (js/worker.js).
// It starts the background worker, reports loading progress, and turns
// "transcribe this audio" into a simple promise.

export class Engine {
  /** @param {(status: object) => void} onStatus called whenever loading progress or state changes */
  constructor(onStatus) {
    this.onStatus = onStatus || (() => {});
    this.status = { state: 'idle' }; // idle | loading | ready | error
    this.worker = null;
    this.pending = new Map();
    this.seq = 0;
    this.ready = Promise.reject(new Error('No model loaded yet.'));
    this.ready.catch(() => {});
  }

  _setStatus(patch) {
    this.status = { ...this.status, ...patch };
    this.onStatus(this.status);
  }

  /**
   * Load a model. Always starts a fresh worker, which is the only reliable
   * way to give back all the memory the previous model was using.
   * @param {string} model  'tiny', 'base' or 'small'
   * @param {{engine?: 'cpu'|'webgpu', encoder?: 'fp32'|'fp16'}} options
   */
  load(model, options = {}) {
    this.dispose();
    this.ready = new Promise((resolve, reject) => {
      this._resolveReady = resolve;
      this._rejectReady = reject;
    });
    this.ready.catch(() => {});
    this._start(model, options.engine === 'webgpu' ? 'webgpu' : 'cpu', options, []);
    return this.ready;
  }

  _start(model, engine, options, notes) {
    const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.worker = worker;
    this.attempt = { model, engine, options, notes };
    this.status = { state: 'loading', model, engine, progress: 0, stage: 'start', notes };
    this.onStatus(this.status);
    worker.onmessage = (event) => {
      if (this.worker === worker) this._onMessage(event.data);
    };
    worker.onerror = (event) => {
      if (this.worker === worker) this._loadFailed(event.message || 'The transcription engine stopped unexpectedly.');
    };
    worker.postMessage({ type: 'load', model, engine, encoder: options.encoder });
  }

  _onMessage(message) {
    if (message.type === 'stage') {
      this._setStatus({ stage: message.stage, megabytes: message.megabytes ?? this.status.megabytes });
    } else if (message.type === 'progress') {
      this._setStatus({ progress: message.total ? Math.min(1, message.loaded / message.total) : 0, loadedBytes: message.loaded, totalBytes: message.total });
    } else if (message.type === 'ready') {
      const { type, ...facts } = message;
      facts.notes = this.attempt.notes;
      this._setStatus({ state: 'ready', progress: 1, stage: 'ready', ...facts });
      this._resolveReady(facts);
    } else if (message.type === 'result') {
      const waiting = this.pending.get(message.id);
      this.pending.delete(message.id);
      waiting?.resolve({ text: message.text, ms: message.ms });
    } else if (message.type === 'error') {
      if (message.during === 'load') {
        this._loadFailed(message.message);
      } else {
        const waiting = this.pending.get(message.id);
        this.pending.delete(message.id);
        waiting?.reject(new Error(message.message));
      }
    }
  }

  _loadFailed(text) {
    const { model, engine, options, notes } = this.attempt;
    if (this.status.state === 'loading' && engine === 'webgpu' && !options.noFallback) {
      // The graphics engine said no (politely, without crashing). Use the
      // processor engine instead, in a brand-new worker.
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.terminate();
      this._start(model, 'cpu', options, [...notes, `WebGPU failed, using the processor instead: ${text}`]);
      return;
    }
    const error = new Error(text);
    this._setStatus({ state: 'error', error: text });
    this._rejectReady?.(error);
    for (const waiting of this.pending.values()) waiting.reject(error);
    this.pending.clear();
  }

  /**
   * @param {Float32Array} samples mono audio at 16,000 samples per second
   * @returns {Promise<{text: string, ms: number}>}
   */
  async transcribe(samples) {
    await this.ready;
    const worker = this.worker;
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ type: 'transcribe', id, audio: samples });
    });
  }

  dispose() {
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.terminate();
      this.worker = null;
    }
    const error = new Error('The model was unloaded.');
    this._rejectReady?.(error);
    this._rejectReady = null;
    for (const waiting of this.pending.values()) waiting.reject(error);
    this.pending.clear();
    this.status = { state: 'idle' };
  }
}
