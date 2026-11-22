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
        s.cutAtMs = data.atMs;
        s.resolve?.();
        return;
      }
      s.startMs ??= data.atMs;
      if (s.size < 8000 * 60) {
        s.chunks.push(data.samples);
        s.size += data.samples.length;
      } else s.truncated = true;
      if (data.samples.some((v) => Math.abs(v) > 300)) s.lastSound = performance.now();
    };
  }
  record(stream, save, onError) {
    this.recorder = new AudioWorkletNode(this.context, 'review-recorder', { numberOfInputs: 2, outputChannelCount: [1] });
    this.mic = this.context.createMediaStreamSource(stream);
    this.mic.connect(this.recorder, 0, 0);
    this.tap.connect(this.recorder, 0, 1);
    this.recorder.connect(this.context.destination);
    this.recordingDone = new Promise((resolve) => {
      this.recorder.port.onmessage = ({ data }) => {
        const bytes = new Uint8Array(data.samples.buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i += 8192)
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        save({ type: 'recording', id: 'stereo-' + data.offset, offset: data.offset,
          originMs: data.originMs, final: data.final, pcm: btoa(binary) })
          .catch(onError).finally(() => { if (data.final) resolve(); });
      };
    });
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
    return { pcm: btoa(encoded), truncated: s.truncated || s.cutAtMs == null, startMs: s.startMs, cutAtMs: s.cutAtMs };
  }
  async close() {
    if (this.recorder) {
      this.recorder.port.postMessage('finish');
      try {
        // A suspended audio context may never acknowledge the last worklet message.
        await Promise.race([this.recordingDone, new Promise((resolve) => { this.recordTimeout = setTimeout(resolve, 3000); })]);
      } finally {
        clearTimeout(this.recordTimeout);
        this.recorder.port.onmessage = null;
        this.mic.disconnect();
        this.recorder.disconnect();
      }
    }
    this.source?.disconnect();
    this.tap?.disconnect();
    if (this.sink) {
      this.sink.pause();
      this.sink.srcObject = null;
    }
    if (this.context && this.context.state !== 'closed') await this.context.close();
  }
}
