// Tap the browser's output mixer. Batch 40 ms at 8 kHz for local review evidence.
class PlaybackTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.reset(null);
    this.port.onmessage = ({ data }) => {
      this.flush();
      if (this.id) this.port.postMessage({ ended: this.id });
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
    this.port.postMessage({ id: this.id, samples }, [samples.buffer]);
    this.samples.length = 0;
  }
  process(inputs, outputs) {
    const input = inputs[0]?.[0],
      output = outputs[0]?.[0];
    if (!input || !output || !this.id) return true;
    output.set(input);
    for (const sample of input) {
      this.phase += 8000;
      if (this.phase < sampleRate) continue;
      this.phase -= sampleRate;
      this.samples.push(Math.round(Math.max(-1, Math.min(1, sample)) * 32767));
      if (this.samples.length === 320) this.flush();
    }
    return true;
  }
}
registerProcessor('playback-tap', PlaybackTap);
