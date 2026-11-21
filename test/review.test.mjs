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
  assert.throws(() => send('tool', { turn: q, name: 'get_call_progress' }), /已结束/);
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
