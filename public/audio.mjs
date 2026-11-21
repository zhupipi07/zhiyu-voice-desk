export class Playback {
  async open() {
    this.context = new AudioContext();
    await this.context.resume();
    await this.context.audioWorklet.addModule('/capture.mjs');
    this.tap = new AudioWorkletNode(this.context, 'playback-tap', { outputChannelCount: [1] });
    this.tap.connect(this.context.destination);
    this.segments = new Map();
    this.tap.port.onmessage = ({ data }) => {
      const s = this.segments.get(data.ended || data.id);
      if (!s) return;
      if (data.ended) {
        s.resolve?.();
        return;
      }
      if (s.size < 8000 * 60) {
        s.chunks.push(data.samples);
        s.size += data.samples.length;
      } else s.truncated = true;
      if (data.samples.some((v) => Math.abs(v) > 300)) s.lastSound = performance.now();
    };
  }
  attach(track) {
    this.source?.disconnect();
    const stream = new MediaStream([track]);
    // Chromium requires an attached media element for remote WebRTC audio to flow.
    this.sink ||= document.createElement('audio');
    this.sink.muted = true;
    this.sink.srcObject = stream;
    this.sink.play().catch(() => {});
    this.source = this.context.createMediaStreamSource(stream);
    this.source.connect(this.tap);
  }
  start(id) {
    this.active = id;
    this.segments.set(id, { chunks: [], size: 0, lastSound: 0, truncated: false });
    this.tap.port.postMessage({ id });
  }
  async drain(id) {
    const started = performance.now();
    while (id === this.active && performance.now() - started < 15000) {
      const s = this.segments.get(id);
      if (this.context.state !== 'running') return false;
      if (s?.lastSound && performance.now() - Math.max(s.lastSound, started) >= 750) return true;
      if (!s?.lastSound && performance.now() - started > 3000) return false;
      await new Promise((r) => setTimeout(r, 60));
    }
    return false;
  }
  async cut(id) {
    const s = this.segments.get(id);
    if (!s) return { pcm: '', truncated: true };
    const flushed = new Promise((resolve) => {
      s.resolve = resolve;
    });
    if (this.active === id) {
      this.active = null;
      this.tap.port.postMessage({ id: null });
    }
    let timer;
    await Promise.race([
      flushed,
      new Promise((resolve) => {
        timer = setTimeout(resolve, 180);
      }),
    ]);
    clearTimeout(timer);
    this.segments.delete(id);
    let encoded = '';
    for (const chunk of s.chunks) encoded += String.fromCharCode(...new Uint8Array(chunk.buffer));
    return { pcm: btoa(encoded), truncated: s.truncated };
  }
  async close() {
    this.source?.disconnect();
    this.tap?.disconnect();
    if (this.sink) {
      this.sink.pause();
      this.sink.srcObject = null;
    }
    if (this.context && this.context.state !== 'closed') await this.context.close();
  }
}
