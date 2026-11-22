// Tap the browser's output mixer. Batch 40 ms at 8 kHz for local review evidence.
class PlaybackTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.reset(null);
    this.port.onmessage = ({ data }) => {
      this.flush();
      if (this.id) this.port.postMessage({ ended: this.id, atMs: currentTime * 1000 });
      this.reset(data.id);
    };
  }
  reset(id) {
    this.id = id;
    this.samples = [];
    this.phase = 0;
  }
  flush() {
    if (!this.id || !this.samples.length) return;
    const samples = Int16Array.from(this.samples);
    this.port.postMessage({ id: this.id, samples, atMs: this.chunkStartMs }, [samples.buffer]);
    this.samples.length = 0;
  }
  process(inputs, outputs) {
    const input = inputs[0]?.[0],
      output = outputs[0]?.[0];
    if (!input || !output || !this.id) return true;
    output.set(input);
    for (let i = 0; i < input.length; i++) {
      const sample = input[i];
      this.phase += 8000;
      if (this.phase < sampleRate) continue;
      this.phase -= sampleRate;
      if (!this.samples.length) this.chunkStartMs = (currentFrame + i) * 1000 / sampleRate;
      this.samples.push(Math.round(Math.max(-1, Math.min(1, sample)) * 32767));
      if (this.samples.length === 320) this.flush();
    }
    return true;
  }
}
registerProcessor('playback-tap', PlaybackTap);

// Two inputs share the render clock. The output stays silent so the microphone never loops back.
class ReviewRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Int16Array(2 * 16000);
    this.used = 0;
    this.offset = 0;
    this.phase = 0;
    this.port.onmessage = () => {
      this.stopped = true;
      this.flush(true);
    };
  }
  flush(final) {
    const samples = this.samples.slice(0, this.used);
    this.port.postMessage({ samples, offset: this.offset, originMs: this.originMs ?? currentTime * 1000, final }, [samples.buffer]);
    this.offset += this.used / 2;
    this.used = 0;
  }
  process(inputs, outputs) {
    if (this.stopped) return false;
    const mic = inputs[0][0], agent = inputs[1][0];
    for (let i = 0; i < outputs[0][0].length; i++) {
      this.phase += 8000;
      if (this.phase < sampleRate) continue;
      this.phase -= sampleRate;
      this.originMs ??= (currentFrame + i) * 1000 / sampleRate;
      this.samples[this.used++] = Math.round(Math.max(-1, Math.min(1, mic?.[i] ?? 0)) * 32767);
      this.samples[this.used++] = Math.round(Math.max(-1, Math.min(1, agent?.[i] ?? 0)) * 32767);
      if (this.used === this.samples.length) this.flush(false);
    }
    return true;
  }
}
registerProcessor('review-recorder', ReviewRecorder);
