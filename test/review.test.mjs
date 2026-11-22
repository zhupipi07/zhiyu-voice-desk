import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStore, MODEL } from '../src/review.mjs';
import { createApp } from '../server.mjs';

const sound = Buffer.alloc(48000);
for (let i = 0; i < sound.length; i += 2) sound.writeInt16LE(i % 4 ? 4000 : -4000, i);
function setup(t, file = ':memory:') {
  const store = openStore(file);
  t.after(() => store.close());
  const call = store.create();
  let connection;
  const send = (type, fields = {}) =>
    store.event(call.id, call.token, { type, id: randomUUID(), connection, ...fields });
  const connect = () => {
    connection = send('connect').snapshot.connection;
  };
  connect();
  const say = (text) => {
    const turn = randomUUID();
    send('turn', { turn });
    send('transcript', { turn, text });
    return turn;
  };
  const tool = (turn, name, topic) => send('tool', { turn, name, topic }).result;
  return { store, call, send, say, tool, connect };
}
test('only the current verified merchant can retrieve the synthetic review materials', (t) => {
  const { store, call, send, say, tool } = setup(t);
  assert.throws(() => store.read(call.id, 'wrong'), /找不到/);
  const before = say('我来查材料');
  assert.equal(tool(before, 'lookup_review_guidance', 'page').ok, false);
  assert.equal(JSON.stringify(store.read(call.id, call.token)).includes('盖章页'), false);
  const incorrect = say('我是其他商贸');
  assert.equal(tool(incorrect, 'verify_merchant').ok, false);
  const identity = say('我是青禾商贸。');
  assert.equal(tool(incorrect, 'verify_merchant').ok, false);
  assert.equal(tool(identity, 'verify_merchant').point, 'chain');
  const q = say('具体补哪一页？');
  assert.match(tool(q, 'lookup_review_guidance', 'page').say, /盖章页/);
  assert.equal(tool(q, 'lookup_review_guidance', 'unknown').ok, false);
  say('我不是青禾商贸，你打错了。');
  assert.equal(store.read(call.id, call.token).identity, 'denied');
  assert.equal(store.read(call.id, call.token).receipt, null);
  assert.deepEqual(store.read(call.id, call.token).points, []);
  assert.throws(() => send('tool', { turn: q, name: 'get_call_progress' }), /已结束/);
});
test('hangup preserves partial notice and issues one simulated opinion per case revision', (t) => {
  const { call, store, say, send, tool } = setup(t);
  const first = tool(say('我是青禾商贸'), 'verify_merchant');
  const clip = { pcm: sound.toString('base64'), drained: true, interrupted: false };
  const second = send('playback', { ...clip, point: first.point, text: first.say }).result.next;
  send('playback', { ...clip, point: second.point, text: '第二项', interrupted: true, drained: false });
  const closed = send('end').snapshot;
  assert.deepEqual(closed.points.map(({ id, status }) => [id, status]), [['chain', 'complete'], ['seal', 'partial']]);
  assert.match(closed.receipt.opinion, /品牌方到经销商/);
  assert.match(closed.receipt.opinion, /盖章页/);
  assert.ok(Number.isFinite(Date.parse(closed.receipt.issuedAt)));
  assert.deepEqual(store.read(call.id, call.token).receipt, closed.receipt);
  assert.deepEqual(send('end').snapshot.receipt, closed.receipt);
  assert.deepEqual(send('playback', { ...clip, point: second.point, text: second.say }).snapshot.points, closed.points);

  const another = store.create();
  const connection = store.event(another.id, another.token, { type: 'connect', id: 'c' }).snapshot.connection;
  const write = (e) => store.event(another.id, another.token, { ...e, id: randomUUID(), connection });
  write({ type: 'turn', turn: 't' });
  write({ type: 'transcript', turn: 't', text: '我是青禾商贸' });
  write({ type: 'tool', turn: 't', name: 'verify_merchant' });
  const repeated = write({ type: 'end' }).snapshot;
  assert.deepEqual(repeated.receipt, closed.receipt);
  assert.ok(repeated.points.every((p) => p.status === 'pending'));
});
test('material disputes, unresolved questions and callback requests survive subsequent answers', (t) => {
  const { store, call, say, send, tool, connect } = setup(t);
  tool(say('我是青禾商贸'), 'verify_merchant');
  say('并非所有材料都要盖章吧？');
  say('是不是你打错了一个字？');
  const first = say('公证费要多少？');
  const absent = tool(first, 'lookup_review_guidance', 'unknown');
  const played = { pcm: sound.toString('base64'), drained: true, interrupted: false };
  send('playback', { ...played, questionTurn: first, text: absent.say });
  const second = say('要补哪一页？');
  const page = tool(second, 'lookup_review_guidance', 'page');
  send('playback', { ...played, questionTurn: second, text: page.say });
  connect();
  assert.equal(store.read(call.id, call.token).pendingQuestion, '公证费要多少？');
  say('处理好以后电话通知我。');
  assert.equal(store.read(call.id, call.token).callback.action, 'callback');
  say('不用回电了。');
  assert.equal(store.read(call.id, call.token).callback, null);
  say('不确定，晚点再说。');
  const saved = send('end').snapshot;
  assert.equal(saved.identity, 'verified');
  assert.equal(saved.callback.action, 'clarify');
  assert.deepEqual(saved.questions.map((q) => q.text), ['公证费要多少？']);
});

test('timing export shares the recording clock and keeps unverified latencies empty', (t) => {
  const { store, call, say, send } = setup(t);
  const turn = say('你好');
  const pcm = Buffer.alloc(160 * 4 * 4);
  for (let i = 160; i < 480; i++) pcm.writeInt16LE(4000, i * 4);
  const chunk = { id: 'stereo-0', originMs: 1000, offset: 0, final: true, pcm: pcm.toString('base64') };
  send('recording', chunk);
  send('recording', chunk);
  assert.throws(() => send('recording', { ...chunk, id: 'out-of-order', offset: 42 }), /不连续/);
  send('marker', { turn, name: 'speech_started', atMs: 1040 });
  send('marker', { turn, name: 'speech_stopped', atMs: 1070 });
  send('playback', { turn, interruptedByTurn: turn, text: '您好', interrupted: true, drained: false,
    startMs: 1100, cutAtMs: 4100, pcm: sound.toString('base64') });
  const report = store.report(call.id, call.token);
  const connection = report.connections[0];
  assert.deepEqual(store.recording(call.id, call.token, connection.connection), pcm);
  assert.throws(() => store.report(call.id, 'other'), /找不到/);
  const row = connection.turns[0];
  assert.deepEqual([row.micStartCandidateMs, row.micEndCandidateMs], [1020, 1060]);
  assert.deepEqual([row.replies[0].firstSoundMs, row.replies[0].lastSoundMs], [1100, 4100]);
  assert.equal(row.interruptedReplies[0].gateClosedMs, 4100);
  assert.equal(row.firstWordLatencyMs, null);
});
test('interrupted playback is partial, stale retries and reconnect cannot advance the wrong item', (t) => {
  const { store, call, send, say, tool, connect } = setup(t);
  const turn = say('青禾商贸');
  const first = tool(turn, 'verify_merchant');
  const played = {
    point: first.point,
    text: first.say,
    pcm: sound.toString('base64'),
    drained: true,
    interrupted: false,
  };
  const noAudio = send('playback', { ...played, pcm: '' });
  assert.equal(noAudio.snapshot.points[0].status, 'pending');
  const blip = send('playback', { ...played, pcm: sound.subarray(0, 4000).toString('base64') });
  assert.equal(blip.snapshot.points[0].status, 'partial');
  const out = send('playback', played);
  assert.equal(out.result.next.point, 'seal');
  assert.equal(out.snapshot.points[0].status, 'complete');
  const partial = {
    id: 'cut',
    point: 'seal',
    text: out.result.next.say,
    interrupted: true,
    drained: false,
    pcm: played.pcm,
  };
  const result = send('playback', partial);
  const oldConnection = result.snapshot.connection;
  assert.equal(result.snapshot.points[1].status, 'partial');
  assert.deepEqual(send('playback', partial), result);
  assert.throws(() => send('playback', { ...partial, interrupted: false }), /已用于/);
  connect();
  assert.throws(() => send('playback', { ...partial, id: 'late', connection: oldConnection }), /已更换/);
  const next = tool(say('还有哪项？'), 'get_call_progress');
  assert.equal(next.point, 'seal');
  assert.equal(
    send('playback', { ...played, text: next.say, point: next.point }).snapshot.points[1].status,
    'complete'
  );
  assert.equal(send('end').snapshot.status, 'ended');
  assert.equal(store.create().snapshot.identity, 'pending');
  assert.deepEqual(store.clip(call.id, call.token, result.snapshot.turns.at(-1).item), sound);
});
test('SQLite retains review progress and output evidence across process restarts', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'review-test-'));
  const file = join(dir, 'state.sqlite'),
    initial = openStore(file);
  t.after(() => {
    for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true });
    rmdirSync(dir);
  });
  const { id, token } = initial.create();
  const { snapshot } = initial.event(id, token, { type: 'connect', id: 'first' });
  const send = (e) => initial.event(id, token, { ...e, connection: snapshot.connection });
  send({ type: 'turn', id: 't', turn: 'a' });
  send({ type: 'transcript', id: 'asr', turn: 'a', text: '我是青禾商贸' });
  const { result } = send({ type: 'tool', name: 'verify_merchant', turn: 'a', id: 'verify' });
  const saved = send({
    type: 'playback',
    id: 'p',
    point: 'chain',
    text: result.say,
    interrupted: true,
    drained: false,
    pcm: sound.toString('base64'),
  });
  initial.close();
  const restored = openStore(file);
  try {
    assert.equal(restored.read(id, token).points[0].status, 'partial');
    assert.deepEqual(restored.clip(id, token, saved.snapshot.turns.at(-1).item), sound);
  } finally {
    restored.close();
  }
});
test('SDP forwarding uses the configured Flash model and never returns the server credential', async (t) => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const seen = [];
  const server = createApp({
    store,
    key: 'test-secret',
    workspace: 'ws-test',
    upstream: async (url, options) => {
      seen.push({ url, options });
      return new Response('v=0\r\ns=fixture\r\n');
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((r) => server.close(r)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const req = async (path, options) => fetch(base + path, options);
  const c = await (await req('/api/calls', { method: 'POST' })).json();
  const path = '/api/calls/' + c.id;
  const headers = { Authorization: 'Bearer ' + c.token };
  const conn = await (
    await req(path + '/events', {
      method: 'POST',
      headers,
      body: JSON.stringify({ type: 'connect', id: 'c' }),
    })
  ).json();
  const sdp = await req(path + '/sdp', {
    method: 'POST',
    headers: { ...headers, 'X-Connection': conn.snapshot.connection },
    body: 'v=0\r\nm=audio 9\r\n',
  });
  assert.equal(sdp.status, 200);
  assert.match(await sdp.text(), /^v=0/);
  assert.equal(new URL(seen[0].url).searchParams.get('model'), MODEL);
  assert.equal(seen[0].options.headers.Authorization, 'Bearer test-secret');
  assert.equal(JSON.stringify(conn).includes('test-secret'), false);
  assert.equal((await req('/.env')).status, 404);
  assert.equal((await req(path)).status, 404);
  assert.equal(
    (await req('/api/calls', { method: 'POST', headers: { Origin: 'https://example.org' } })).status,
    403
  );
});
