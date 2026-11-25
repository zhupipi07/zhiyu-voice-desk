import { qualityReport } from './quality.mjs';

// Find audible 20 ms windows on one PCM16 channel. Offsets refer to the connection's AudioContext.
export function voiceFrames(pcm, channels, channel, originMs) {
  const frames = [];
  const stride = 2 * channels;
  for (let start = 0; start + 160 * stride <= pcm.length; start += 160 * stride) {
    let energy = 0;
    for (let j = start + 2 * channel; j < start + 160 * stride; j += stride)
      energy += pcm.readInt16LE(j) ** 2;
    if (energy / 160 > 100 ** 2) frames.push(originMs + start / stride / 8);
  }
  return frames;
}

export function evidenceReport(call, s, events, readAudio) {
  const connections = new Map();
  const recordings = s.recordings ?? {};
  function entry(id) {
    if (!connections.has(id)) connections.set(id, { connection: id, recording: recordings[id] ?? null,
      turns: [], opening: [], setup: [] });
    return connections.get(id);
  }
  function turn(conn, id) {
    let row = conn.turns.find((t) => t.turn === id);
    if (!row) {
      row = { turn: id, markersMs: {}, tools: [], replies: [], interruptedReplies: [],
        micStartCandidateMs: null, micEndCandidateMs: null, confirmedSpeechEndMs: null,
        firstIntelligibleMs: null, firstWordLatencyMs: null };
      conn.turns.push(row);
    }
    return row;
  }
  for (const e of events) {
    if (e.type === 'connect' && e.result?.connection) {
      entry(e.result.connection).turnDetection = e.result.session.turn_detection;
      entry(e.result.connection).transport = e.transport ?? null;
    }
    if (!e.connection) continue;
    const conn = entry(e.connection);
    if (e.type === 'usage') {
      conn.usage ??= [];
      conn.usage.push({ response: e.response, inputTokens: e.inputTokens, outputTokens: e.outputTokens });
    }
    if (e.type === 'setup') conn.setup.push({ name: e.name, atMs: e.atMs, attempt: e.attempt });
    if (e.type === 'turn') turn(conn, e.turn);
    if (e.type === 'marker') turn(conn, e.turn).markersMs[e.name] = e.atMs;
    if (e.type === 'transcript') turn(conn, e.turn).transcript = e.text;
    if (e.type === 'tool') turn(conn, e.turn).tools.push({
      id: e.id, name: e.name, atMs: e.atMs ?? null, result: e.result,
      ...(e.name === 'lookup_review_guidance' && { requestedTopic: e.topic ?? null }),
    });
    if (e.type === 'playback') {
      const reply = { id: e.id, clip: e.clip, text: e.text, firstSoundMs: e.firstSoundMs ?? null,
        lastSoundMs: e.lastSoundMs ?? null, gateClosedMs: e.cutAtMs ?? null, interrupted: e.interrupted,
        drained: e.drained, audibleMs: e.audibleMs };
      (e.turn ? turn(conn, e.turn).replies : conn.opening).push(reply);
      if (e.interruptedByTurn) turn(conn, e.interruptedByTurn).interruptedReplies.push({
        reply: e.id, gateClosedMs: reply.gateClosedMs,
      });
    }
  }
  for (const conn of connections.values()) {
    const rec = conn.recording;
    if (!rec?.samples) continue;
    const mic = voiceFrames(readAudio(conn.connection), 2, 0, rec.originMs);
    let previousEnd = rec.originMs;
    for (const t of conn.turns) {
      const start = t.markersMs.speech_started;
      const end = t.markersMs.speech_stopped ?? t.markersMs.committed;
      if (start == null || end == null || end < start) continue;
      const lo = Math.max(previousEnd, start - 400);
      const first = mic.findIndex((at) => at >= lo);
      if (first >= 0 && mic[first] <= end) {
        let last = first;
        while (last + 1 < mic.length && mic[last + 1] <= end) last++;
        t.micStartCandidateMs = mic[first];
        t.micEndCandidateMs = mic[last] + 20;
      }
      previousEnd = end;
    }
  }
  return { call, caseId: s.caseId, revision: s.revision, receipt: s.receipt ?? null,
    clock: '毫秒。每次连接独立计时，WAV 文件位置 = (时间点 − recording.originMs) / 1000 秒。',
    annotation: '左右声道分别为商家、坐席。音量候选点与断句事件供定位。回听标注首个可辨认字后，计算它与商家停语的时间差。',
    quality: qualityReport(s, events, [...connections.values()]), connections: [...connections.values()] };
}
