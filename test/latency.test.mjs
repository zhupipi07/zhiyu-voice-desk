import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateLatency } from '../scripts/evaluate-latency.mjs';

test('latency uses same-recording annotations and reports unpaired and overlapping turns separately', () => {
  const row = (turn, end, first, tools = []) => ({ turn, tools, replies: [{ firstSoundMs: 200 }],
    confirmedSpeechEndMs: end, firstIntelligibleMs: first });
  const report = { call: 'call', connections: [
    { connection: 'first', recording: { originMs: 1000, samples: 32000 }, opening: [{}], turns: [
      row('a', 1100.123, 1400.123), row('b', 2000, 3300, [{}]), row('c', 4000, 3950),
      { ...row('d', 4200, null), replies: [], micEndCandidateMs: 4200 },
    ] },
    { connection: 'reconnect', recording: { originMs: 50, samples: 1600 }, opening: [], turns: [
      row('a', 60, 60), row('b', null, null),
    ] },
  ] };
  const result = evaluateLatency([report]);
  assert.deepEqual(result.overall, { turns: 6, measured: 3, overlap: 1, unpaired: 2,
    withoutTimedReply: 1, p50Ms: 300, p95Ms: 1300 });
  assert.equal(result.openingReplies, 1);
  assert.equal(result.withTool.p50Ms, 1300);
  assert.equal(result.withoutTool.p50Ms, 0);
  report.connections[0].turns[0].firstContentWordMs=1650.123;
  assert.equal(evaluateLatency([report]).content.p50Ms,550);
  assert.equal(evaluateLatency([report]).overall.p50Ms,300);
  assert.equal(evaluateLatency([]).overall.p50Ms, null);
  assert.throws(() => evaluateLatency([report, report]), /重复/);
  report.connections[1].turns[0].firstIntelligibleMs = 1400;
  assert.throws(() => evaluateLatency([report]), /录音范围/);
});
