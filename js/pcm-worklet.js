// This small piece runs on the browser's audio thread. Its only job is to
// collect raw microphone samples and hand them to the page.
//
// While you are NOT recording it keeps just the last fraction of a second in a
// loop (the "pre-roll") and throws everything older away. When you press the
// button that fraction is included, so the first word is not cut off.

const BATCH = 2048;

class PcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const seconds = options?.processorOptions?.preRollSeconds ?? 0.3;
    this.ring = new Float32Array(Math.max(128, Math.round(sampleRate * seconds)));
    this.ringPos = 0;
    this.ringFilled = 0;
    this.recording = false;
    this.batch = new Float32Array(BATCH);
    this.batchPos = 0;

    this.port.onmessage = (event) => {
      if (event.data === 'start') {
        this.sendPreRoll();
        this.recording = true;
      } else if (event.data === 'stop') {
        this.recording = false;
        this.flush();
        this.ringFilled = 0;
        this.ringPos = 0;
        this.port.postMessage({ end: true });
      }
    };
  }

  sendPreRoll() {
    const n = this.ringFilled;
    if (!n) return;
    const out = new Float32Array(n);
    const startAt = (this.ringPos - n + this.ring.length) % this.ring.length;
    for (let i = 0; i < n; i++) out[i] = this.ring[(startAt + i) % this.ring.length];
    this.port.postMessage({ samples: out }, [out.buffer]);
  }

  flush() {
    if (!this.batchPos) return;
    const out = this.batch.slice(0, this.batchPos);
    this.batchPos = 0;
    this.port.postMessage({ samples: out }, [out.buffer]);
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    if (this.recording) {
      for (let i = 0; i < channel.length; i++) {
        this.batch[this.batchPos++] = channel[i];
        if (this.batchPos === BATCH) this.flush();
      }
    } else {
      for (let i = 0; i < channel.length; i++) {
        this.ring[this.ringPos] = channel[i];
        this.ringPos = (this.ringPos + 1) % this.ring.length;
      }
      this.ringFilled = Math.min(this.ring.length, this.ringFilled + channel.length);
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
