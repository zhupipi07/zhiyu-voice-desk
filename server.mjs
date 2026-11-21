import http from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { openStore, MODEL, fail } from './src/review.mjs';

const files = new Map(
  ['index.html', 'app.mjs', 'realtime.mjs', 'audio.mjs', 'capture.mjs', 'style.css'].map((name) => [
    '/' + name,
    new URL('./public/' + name, import.meta.url),
  ])
);
const types = {
  html: 'text/html; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
};
const tools = new Set(['verify_merchant', 'get_call_progress', 'lookup_review_guidance']);
function string(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}
function validate(e) {
  if (
    !e ||
    !string(e.id, 220) ||
    !['connect', 'turn', 'transcript', 'tool', 'playback', 'end'].includes(e.type)
  )
    throw fail(400, '无效事件。');
  if (e.type !== 'connect' && !string(e.connection, 80)) throw fail(400, '缺少连接编号。');
  if (['turn', 'transcript', 'tool'].includes(e.type) && !string(e.turn, 180))
    throw fail(400, '缺少语音轮次。');
  if (e.type === 'transcript' && !string(e.text, 6000)) throw fail(400, '转写为空或过长。');
  if (e.type === 'tool' && (!tools.has(e.name) || (e.topic != null && !string(e.topic, 50))))
    throw fail(400, '工具参数无效。');
  if (
    e.type === 'playback' &&
    (typeof e.text !== 'string' ||
      e.text.length > 10000 ||
      typeof e.pcm !== 'string' ||
      e.pcm.length > 1400000 ||
      typeof e.drained !== 'boolean' ||
      typeof e.interrupted !== 'boolean' ||
      (e.point != null && !['chain', 'seal'].includes(e.point)))
  )
    throw fail(400, '播放记录无效。');
}
async function body(req, limit) {
  const parts = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > limit) throw fail(413, '请求过大。');
    parts.push(part);
  }
  return Buffer.concat(parts).toString('utf8');
}
function wav(pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF');
  h.writeUInt32LE(pcm.length + 36, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(8000, 24);
  h.writeUInt32LE(16000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
export function createApp({ store, key, workspace, upstream = fetch }) {
  const ready = Boolean(key && workspace && /^[a-z0-9][a-z0-9-]*$/i.test(workspace));
  return http.createServer(async (req, res) => {
    const reply = (status, value, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Permissions-Policy': 'microphone=(self), camera=()',
      });
      res.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
    };
    try {
      const host = req.headers.host || '';
      if (!/^(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(host)) throw fail(403, '请在本机打开测试台。');
      if (req.headers.origin && req.headers.origin !== 'http://' + host)
        throw fail(403, '请从同源测试台操作。');
      const path = new URL(req.url, 'http://localhost').pathname;
      const method = req.method;
      if (method === 'GET' && (path === '/' || files.has(path))) {
        const file = files.get(path === '/' ? '/index.html' : path);
        return reply(200, readFileSync(file), types[file.pathname.split('.').at(-1)]);
      }
      if (path === '/api/status' && method === 'GET') return reply(200, { model: MODEL, ready });
      if (path === '/api/calls' && method === 'POST') return reply(201, store.create());
      const match = path.match(/^\/api\/calls\/([a-f0-9-]{36})(?:\/(events|sdp|clips)(?:\/([\w.-]+))?)?$/);
      if (!match) throw fail(404, '找不到该地址。');
      const [, id, route, clipId] = match;
      const token = (req.headers.authorization || '').replace(/^Bearer /, '');
      const s = store.read(id, token);
      if (method === 'GET' && !route) return reply(200, s);
      if (method === 'GET' && route === 'clips' && clipId)
        return reply(200, wav(store.clip(id, token, clipId)), 'audio/wav');
      if (method === 'POST' && route === 'events') {
        const raw = await body(req, 1500000);
        let e;
        try {
          e = JSON.parse(raw);
        } catch {
          throw fail(400, 'JSON 格式不正确。');
        }
        validate(e);
        return reply(200, store.event(id, token, e));
      }
      if (method === 'POST' && route === 'sdp') {
        if (!ready) throw fail(503, '请在服务端 .env 填写北京地域的 API Key 和 Workspace ID，并重新启动。');
        if (s.status !== 'open' || !s.connection || req.headers['x-connection'] !== s.connection)
          throw fail(409, '当前连接已失效。');
        const offer = await body(req, 100000);
        if (!offer.startsWith('v=0') || !offer.includes('m=audio')) throw fail(400, '缺少音频连接描述。');
        const url =
          'https://' + workspace + '.cn-beijing.maas.aliyuncs.com/api/v1/webrtc/realtime?model=' + MODEL;
        const answer = await upstream(url, {
          method: 'POST',
          body: offer,
          redirect: 'error',
          signal: AbortSignal.timeout(20000),
          headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/sdp' },
        });
        if (!answer.ok)
          throw fail(
            502,
            `百炼建连失败（HTTP ${answer.status}）。请检查北京业务空间、模型权限、额度和密钥。`
          );
        const text = await answer.text();
        if (!text.trimStart().startsWith('v=0')) throw fail(502, '百炼未返回有效的 Answer SDP。');
        return reply(200, text, 'application/sdp');
      }
      throw fail(404, '找不到该操作。');
    } catch (err) {
      reply(err.status || 500, {
        error: err.status ? err.message : '服务请求失败，请检查网络和本地服务。',
      });
    }
  });
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const dir = fileURLToPath(new URL('./data/', import.meta.url));
  mkdirSync(dir, { recursive: true });
  const store = openStore(resolve(dir, 'review.sqlite'));
  const app = createApp({
    store,
    key: process.env.DASHSCOPE_API_KEY?.trim(),
    workspace: process.env.DASHSCOPE_WORKSPACE_ID?.trim(),
  });
  const port = Number(process.env.PORT || 8765);
  app.listen(port, '127.0.0.1', () =>
    console.log(`资审通话测试台  http://127.0.0.1:${app.address().port}`)
  );
  app.on('error', (err) => {
    console.error('启动失败：' + err.message);
    store.close();
    process.exitCode = 1;
  });
}
