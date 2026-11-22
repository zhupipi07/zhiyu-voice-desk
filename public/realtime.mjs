import { Playback } from './audio.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const systemMessage = (text) => ({
  type: 'conversation.item.create',
  item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] },
});

// One instance owns one peer connection. All durable writes go through the call's event queue.
export class VoiceCall {
  constructor({ config, restored, event, exchange, status, failure, current, recordEvidence }) {
    Object.assign(this, { config, restored, event, exchange, status, failure, current, recordEvidence });
    this.playback = new Playback();
    this.epoch = 0;
    this.responses = new Map();
    this.turns = new Map();
    this.seen = new Set();
    this.channels = new Set();
    this.saves = new Set();
    this.abort = new AbortController();
  }
  async start() {
    this.timer = setTimeout(
      () => this.problem(new Error('等待 Flash 就绪超时，请检查网络或重连。')),
      45000
    );
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error('请在本机 localhost 或 127.0.0.1 打开并允许使用麦克风。');
    await this.playback.open();
    if (this.closed) {
      await this.playback.close();
      return;
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: false,
    });
    if (this.closed) {
      this.stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const pc = (this.peer = new RTCPeerConnection());
    const media = pc.addTransceiver('audio', { direction: 'sendrecv' });
    this.sender = media.sender;
    pc.ontrack = ({ track }) => {
      if (track.kind === 'audio' && !this.closed) this.playback.attach(track);
    };
    pc.ondatachannel = ({ channel }) => this.bind(channel);
    pc.onconnectionstatechange = () => {
      if (this.closed) return;
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        this.problem(new Error('语音连接中断，已保存进度。可重新连接。'));
        return;
      }
      this.initialize();
    };
    this.bind(pc.createDataChannel('oai-events'));
    await pc.setLocalDescription(await pc.createOffer());
    const start = performance.now();
    while (!this.closed && pc.iceGatheringState !== 'complete' && performance.now() - start < 10000)
      await sleep(50);
    if (this.closed) return;
    if (pc.iceGatheringState !== 'complete') throw new Error('本机网络未能完成 WebRTC 连接协商。');
    this.status('正在连接百炼');
    const sdp = await this.exchange(pc.localDescription.sdp, this.abort.signal);
    if (!this.closed)
      await pc.setRemoteDescription({ type: 'answer', sdp: sdp.trim().replace(/\r?\n/g, '\r\n') + '\r\n' });
  }
  bind(channel) {
    this.channels.add(channel);
    channel.onopen = () => this.initialize();
    channel.onclose = () => {
      if (this.channel === channel && !this.closed) this.problem(new Error('模型事件通道已关闭。'));
    };
    channel.onmessage = ({ data }) => {
      if (this.closed) return;
      try {
        this.handle(JSON.parse(data), channel).catch((err) => this.problem(err));
      } catch (err) {
        this.problem(err);
      }
    };
  }
  send(message) {
    if (this.closed) return;
    if (this.channel?.readyState !== 'open') throw new Error('模型事件通道尚未就绪。');
    this.channel.send(JSON.stringify({ event_id: 'ev_' + crypto.randomUUID(), ...message }));
  }
  initialize() {
    if (
      this.closed ||
      this.configSent ||
      this.channel?.readyState !== 'open' ||
      this.peer?.connectionState !== 'connected'
    )
      return;
    this.configSent = true;
    this.send({ type: 'session.update', session: this.config });
  }
  request(say, plan = {}) {
    this.nextPlan = plan;
    if (say) this.send(systemMessage(say));
    this.send({ type: 'response.create' });
  }
  problem(err) {
    if (!this.closed && !this.failing) {
      this.failing = true;
      this.failure(err);
    }
  }
  beginTurn(id) {
    if (!id || this.turns.has(id)) return;
    this.epoch++;
    this.turn = id;
    this.nextPlan = null;
    this.turns.set(id, { written: false });
    // Cut the local audio gate immediately, before waiting for network or storage.
    if (this.active) {
      this.active.interruptedByTurn = id;
      void this.finish(this.active, true, false).catch((err) => this.problem(err));
    }
    void this.event({ type: 'turn', id: 'turn-' + id, turn: id }).catch((err) => this.problem(err));
  }
  async handle(e, channel) {
    if (e.event_id && this.seen.has(e.event_id)) return;
    if (e.event_id) this.seen.add(e.event_id);
    switch (e.type) {
      case 'session.created':
        this.channel = channel;
        this.initialize();
        return;
      case 'session.updated':
        if (this.ready || !this.configSent) return;
        this.ready = true;
        await this.sender.replaceTrack(this.stream.getAudioTracks()[0]);
        if (this.closed) return;
        if (this.recordEvidence) this.playback.record(this.stream, this.event, (err) => this.problem(err));
        clearTimeout(this.timer);
        this.status('通话中');
        if (this.current().identity === 'verified' && this.current().pendingQuestion) {
          this.resumeNeeded = true;
          this.request(
            '同一通模拟电话已重连，上一条追问还没有确认答完。请先请商家重述问题，查询后再继续剩余材料。'
          );
        } else if (this.restored?.point) {
          this.request(
            '同一通模拟电话已重连。请说明继续上次待办，再讲这一项：' + this.restored.say,
            this.restored
          );
        } else {
          this.request(
            this.current().identity === 'verified'
              ? '已恢复原通话。' + this.restored.say
              : '现在接通。请表明模拟 AI 资审专员身份，并请对方报出测试商家名称。只作开场核身。'
          );
        }
        return;
      case 'input_audio_buffer.speech_started':
        this.beginTurn(e.item_id);
        this.status('商家正在说话');
        break;
      case 'input_audio_buffer.speech_stopped':
        break;
      case 'input_audio_buffer.committed':
        this.beginTurn(e.item_id);
        break;
      case 'conversation.item.input_audio_transcription.completed': {
        this.beginTurn(e.item_id);
        if (!e.transcript?.trim()) return;
        const data = await this.event({
          type: 'transcript',
          id: 'asr-' + e.item_id,
          turn: e.item_id,
          text: e.transcript,
        });
        this.turns.get(e.item_id).written = true;
        if (data.snapshot.status === 'wrong_number') this.problem(new Error('已记录错号，停止告知。'));
        return;
      }
      case 'response.created': {
        const id = e.response.id;
        if (this.responses.has(id)) return;
        if (this.active) void this.finish(this.active, true, false).catch((err) => this.problem(err));
        const r = {
          id,
          epoch: this.epoch,
          turn: this.turn,
          plan: this.nextPlan || {},
          text: '',
          tools: new Map(),
        };
        this.nextPlan = null;
        this.responses.set(id, r);
        this.active = r;
        this.playback.start(id);
        this.status('坐席响应中');
        return;
      }
      case 'response.audio_transcript.delta':
      case 'response.audio_transcript.done': {
        const r = this.responses.get(e.response_id);
        if (r && !r.finished) r.text = e.transcript ?? r.text + (e.delta || '');
        return;
      }
      case 'response.function_call_arguments.done': {
        const r = this.responses.get(e.response_id);
        if (r) r.tools.set(e.call_id, e);
        return;
      }
      case 'response.done': {
        const r = this.responses.get(e.response.id);
        if (!r || r.done || r.finished) return;
        r.done = true;
        for (const item of e.response.output || []) {
          if (item.type === 'function_call') r.tools.set(item.call_id, item);
          if (!r.text && item.type === 'message')
            r.text = (item.content || []).map((c) => c.transcript || c.text || '').join('');
        }
        if (e.response.status === 'failed') throw new Error('Flash 生成回复失败，请重连并检查模型权限。');
        if (e.response.status !== 'completed') {
          await this.finish(r, true, false);
          return;
        }
        if (r.tools.size) {
          // Function-only turns do not play audio. Mixed turns drain their spoken part first.
          const drained = r.text ? await this.playback.drain(r.id) : false;
          await this.finish(r, false, drained);
          await this.runTools(r);
        } else {
          const drained = await this.playback.drain(r.id);
          await this.finish(r, false, drained);
        }
        return;
      }
      case 'error':
        throw new Error('Flash 返回错误：' + (e.error?.code || e.error?.message || '未知错误'));
      default:
        return;
    }
    if (e.item_id) await this.event({ type: 'marker', id: e.type + '-' + e.item_id,
      turn: e.item_id, name: e.type.split('.').pop(), atMs: this.playback.context.currentTime * 1000 });
  }
  async runTools(r) {
    const live = () => !this.closed && r.epoch === this.epoch;
    // ASR final and response.done may arrive in either order.
    for (let n = 0; n < 45 && live() && !this.turns.get(r.turn)?.written; n++) await sleep(60);
    if (!live()) return;
    let plan = {};
    for (const t of r.tools.values()) {
      let out;
      if (r.turn && this.turns.get(r.turn)?.written) {
        let args = {};
        try {
          args = JSON.parse(t.arguments || '{}');
        } catch {
          /* ask again on incomplete arguments */
        }
        if (['verify_merchant', 'lookup_review_guidance', 'get_call_progress'].includes(t.name)) {
          const data = await this.event({
            type: 'tool',
            id: 'fn-' + t.call_id,
            turn: r.turn,
            name: t.name,
            topic: args?.topic ?? null,
            atMs: this.playback.context.currentTime * 1000,
          });
          out = data.result;
        }
      }
      out ||= { ok: false, say: '请再说一遍，刚才没有获得完整的核验或查询信息。' };
      if (!live()) return;
      this.send({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: t.call_id, output: JSON.stringify(out) },
      });
      plan = out;
    }
    if (live()) this.request(null, plan);
  }
  finish(r, interrupted, drained) {
    if (r.finished) return r.saving || Promise.resolve();
    r.finished = true;
    r.saving = this.savePlayback(r, interrupted, drained);
    this.saves.add(r.saving);
    r.saving.then(
      () => this.saves.delete(r.saving),
      () => this.saves.delete(r.saving)
    );
    return r.saving;
  }
  async savePlayback(r, interrupted, drained) {
    if (this.active === r) this.active = null;
    if (interrupted && r.plan.point) this.resumeNeeded = true;
    const clip = await this.playback.cut(r.id);
    if (!r.text && !r.plan.point && !r.plan.questionTurn && !clip.pcm) return;
    const data = await this.event({
      type: 'playback',
      id: 'play-' + r.id,
      turn: r.turn ?? null,
      interruptedByTurn: r.interruptedByTurn ?? null,
      startMs: clip.startMs,
      cutAtMs: clip.cutAtMs,
      text: r.text,
      point: r.plan.point || r.plan.relatedPoint || null,
      questionTurn: r.plan.questionTurn || null,
      interrupted,
      drained: drained && !clip.truncated,
      pcm: clip.pcm,
    });
    if (this.closed || interrupted || !drained || r.tools.size || r.epoch !== this.epoch || this.active)
      return;
    this.status('通话中');
    const completed = data.snapshot.points.some((p) => p.id === r.plan.point && p.status === 'complete');
    const resume = !r.plan.point && this.resumeNeeded && !data.snapshot.pendingQuestion;
    if ((completed || resume) && data.result.next?.point) {
      this.resumeNeeded = false;
      this.request('接着向商家说明下一项，请完整照读：' + data.result.next.say, data.result.next);
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.abort.abort();
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.active) this.finish(this.active, true, false);
    for (const channel of this.channels) channel.close();
    this.peer?.close();
    try {
      await Promise.all(this.saves);
    } finally {
      await this.playback.close();
    }
  }
}
