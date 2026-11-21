import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const MODEL = 'qwen-audio-3.1-realtime-flash';
const caseId = 'POP-DEMO-018',
  revision = 1;
const materials = [
  {
    id: 'chain',
    title: '授权链路',
    script: '第一项，请补交品牌方到经销商的授权书，补齐中间的授权关系。',
    terms: ['品牌方', '经销商', '授权书'],
  },
  {
    id: 'seal',
    title: '盖章页',
    script:
      '第二项，请补交授权书的盖章页。请确认这页能看清双方公司名称、印章和授权有效期，再上传完整页面。',
    terms: ['盖章页', '公司名称', '印章', '有效期', '上传'],
  },
];
const notes = {
  page: '要补的是授权书的盖章页，请找有双方印章的那一页。按内容认页，没有指定页码。',
  channel: '在本次模拟中，从京麦该申请的补充材料入口上传，然后重新提交审核。',
  result: '补齐后会重新审核，无法提前保证通过。',
};
const instructions = [
  '你是京东开放平台资审电话的模拟 AI 专员，使用简短的普通话。来电仅供测试，所有材料均为合成案例。',
  '主动开场说明 AI 身份，请对方主动报出测试商家名称。不得猜测、提示正确名称或索要真实个人信息。',
  '对方报出名称后立即调用 verify_merchant，必须等后端核身成功才解释案情。错号、否认身份就结束告知。',
  '按工具结果中的 say 说话。如有 point，请完整照读该句，一次只讲一项；系统会安排下一项。不自行编造后续材料。',
  '被打断后先回答最新追问。问原因、材料、页码、上传路径或能否通过，必须调用 lookup_review_guidance。问还有哪项、要求继续时调用 get_call_progress，再按结果回答。',
  '工具返回无依据就说明需要核实。不能承诺审核通过，不宣称已实际向京麦提交。',
].join('\n');
const fn = (name, description, properties = {}) => ({
  type: 'function',
  function: {
    name,
    description,
    parameters: { type: 'object', properties, required: Object.keys(properties) },
  },
});
export function sessionConfig() {
  return {
    modalities: ['audio', 'text'],
    voice: 'longanqian_v3.1',
    instructions,
    input_audio_transcription: { language: 'zh' },
    turn_detection: { type: 'smart_turn_v2' },
    tools: [
      fn('verify_merchant', '根据本轮商家发言核验身份。'),
      fn('get_call_progress', '查询已讲和待补讲事项，按 say 继续。'),
      fn('lookup_review_guidance', '查询当前申请的合成材料依据。', {
        topic: { type: 'string', enum: ['page', 'chain', 'channel', 'result', 'unknown'] },
      }),
    ],
  };
}
export const fail = (status, message) => Object.assign(new Error(message), { status });
const digest = (value) => createHash('sha256').update(value).digest('hex');
const normalize = (text) => text.normalize('NFKC').replace(/[\s\p{P}]/gu, '');
const denied = (text) => /打错|找错|不是本人|不是.{0,6}青禾|不属于青禾|并非|不是我们公司/.test(text);
const matches = (text) =>
  /^(?:您好|你好|对|是的|没错|好的|嗯)*(?:我们是|我是|这里是|这边是|是|我代表|我们公司叫|公司名称是|公司叫)?青禾商贸(?:有限公司|有限责任公司)?(?:的|的负责人|没错|对|是我)?$/.test(
    text
  );

export function openStore(file) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=4000;
    CREATE TABLE IF NOT EXISTS review_calls (id TEXT PRIMARY KEY, token TEXT NOT NULL, state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS review_events (call TEXT, connection TEXT, event TEXT, body TEXT NOT NULL, result TEXT,
      created TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(call, connection, event));
    CREATE TABLE IF NOT EXISTS review_audio (call TEXT, event TEXT, pcm BLOB NOT NULL, PRIMARY KEY(call,event));`);
  function load(id, token) {
    const row = db.prepare('SELECT state FROM review_calls WHERE id=? AND token=?').get(id, digest(token));
    if (!row) throw fail(404, '找不到该测试通话。');
    return JSON.parse(row.state);
  }
  function snapshot(s) {
    return {
      caseId: s.caseId ?? caseId,
      revision: s.revision ?? revision,
      status: s.status,
      identity: s.identity,
      points:
        s.identity === 'verified'
          ? materials.map((p) => ({ id: p.id, title: p.title, status: s.points[p.id] }))
          : [],
      turns: s.turns,
      tools: s.tools,
      pendingQuestion: s.pendingQuestion,
      connection: s.connection,
    };
  }
  function create() {
    const id = randomUUID(),
      token = randomBytes(32).toString('base64url');
    const state = {
      caseId,
      revision,
      status: 'open',
      identity: 'pending',
      connection: null,
      turn: null,
      points: { chain: 'pending', seal: 'pending' },
      turns: [],
      tools: [],
      pendingQuestion: null,
    };
    db.prepare('INSERT INTO review_calls VALUES(?,?,?)').run(id, digest(token), JSON.stringify(state));
    return { id, token, snapshot: snapshot(state) };
  }
  function progress(s) {
    if (s.identity !== 'verified') return { ok: false, say: '请先报出本次测试商家名称，以便核实身份。' };
    const next = materials.find((p) => s.points[p.id] !== 'complete');
    return next
      ? { ok: true, point: next.id, say: next.script, source: '合成资审单 POP-DEMO-018 / v1' }
      : { ok: true, say: '两项整改要求已说明。请问还有什么需要核实的吗？' };
  }
  function apply(s, e, audibleMs) {
    const currentSpeech = () =>
      s.turns.find((t) => t.connection === s.connection && t.item === e.turn && t.speaker === '商家');
    if (s.status !== 'open' && e.type !== 'playback') throw fail(409, '此通电话已结束，请发起新通话。');
    if (e.type === 'connect') {
      s.connection = randomUUID();
      s.turn = null;
      return { session: sessionConfig(), next: progress(s) };
    }
    if (s.connection !== e.connection || !s.connection) throw fail(409, '通话连接已更换。');
    if (e.type === 'turn') {
      s.turn = e.turn;
      if (!currentSpeech())
        s.turns.push({ connection: s.connection, item: e.turn, speaker: '商家', text: '' });
    } else if (e.type === 'transcript') {
      const turn = currentSpeech();
      if (!turn) throw fail(409, '缺少对应的语音轮次。');
      turn.text = e.text;
      if (s.turn === e.turn && denied(normalize(e.text))) {
        s.identity = 'denied';
        s.status = 'wrong_number';
        s.pendingQuestion = null;
      }
    } else if (e.type === 'tool') {
      let result;
      if (e.turn !== s.turn || !s.turn) result = { ok: false, say: '请听取商家最新的回答。' };
      else if (e.name === 'verify_merchant') {
        const words = normalize(currentSpeech()?.text || '');
        if (s.identity === 'verified' || matches(words)) {
          s.identity = 'verified';
          result = progress(s);
        } else result = { ok: false, say: '暂时无法核实，请只说出完整测试商家名称。' };
      } else if (s.identity !== 'verified' || e.name === 'get_call_progress') result = progress(s);
      else if (e.name === 'lookup_review_guidance') {
        s.pendingQuestion = currentSpeech()?.text || '查询材料';
        const answer =
          e.topic === 'chain' ? materials[0].script : Object.hasOwn(notes, e.topic) ? notes[e.topic] : null;
        result = {
          ok: Boolean(answer),
          say: answer || '这张模拟单没有对应依据，需要进一步核实。',
          relatedPoint: e.topic === 'page' ? 'seal' : e.topic === 'chain' ? 'chain' : null,
          source: answer ? '合成资审单 POP-DEMO-018 / v1' : null,
          questionTurn: e.turn,
        };
        s.questionTurn = e.turn;
        s.questionConnection = s.connection;
      } else throw fail(400, '未知业务工具。');
      s.tools.push({ name: e.name, ok: result.ok, turn: e.turn });
      return result;
    } else if (e.type === 'playback') {
      s.turns.push({
        connection: s.connection,
        item: clipKey(e),
        speaker: 'AI',
        text: e.text,
        interrupted: e.interrupted,
        audibleMs,
      });
      const point = materials.find((p) => p.id === e.point);
      if (
        s.status === 'open' &&
        s.identity === 'verified' &&
        point &&
        s.points[point.id] !== 'complete' &&
        audibleMs > 0
      ) {
        const words = normalize(e.text);
        const covered = point.terms.every((term) => words.includes(term));
        // A short blip plus an entire generated transcript cannot demonstrate full playback.
        const minSpeechMs = Math.max(500, normalize(point.script).length * 40);
        s.points[point.id] =
          !e.interrupted && e.drained && audibleMs >= minSpeechMs && covered ? 'complete' : 'partial';
      }
      if (
        e.questionTurn &&
        e.questionTurn === s.questionTurn &&
        s.connection === s.questionConnection &&
        e.drained &&
        !e.interrupted &&
        audibleMs >= 300 &&
        e.text
      )
        s.pendingQuestion = null;
      return { next: progress(s) };
    } else if (e.type === 'end') {
      s.status = 'ended';
    } else throw fail(400, '未知通话事件。');
    return {};
  }
  function event(id, token, e) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const s = load(id, token);
      const connection = e.connection || '';
      const old = db
        .prepare('SELECT body,result FROM review_events WHERE call=? AND connection=? AND event=?')
        .get(id, connection, e.id);
      const pcm = e.type === 'playback' ? Buffer.from(e.pcm || '', 'base64') : null;
      if (pcm && pcm.length % 2) throw fail(400, '无效的音频记录。');
      const body = JSON.stringify(pcm ? { ...e, pcm: digest(pcm) } : e);
      let result;
      if (old) {
        if (body !== old.body) throw fail(409, '事件编号已用于其他内容。');
        if (s.connection !== connection && e.type !== 'connect') throw fail(409, '通话连接已更换。');
        result = JSON.parse(old.result);
      } else {
        let audibleMs = 0;
        if (pcm) {
          // 本地播放回录为单声道 8 kHz PCM16，以 20 毫秒为窗口检查有效音量。
          for (let i = 0; i + 320 <= pcm.length; i += 320) {
            let energy = 0;
            for (let j = i; j < i + 320; j += 2) energy += pcm.readInt16LE(j) ** 2;
            if (energy / 160 > 100 ** 2) audibleMs += 20;
          }
          db.prepare('INSERT INTO review_audio VALUES(?,?,?)').run(id, clipKey(e), pcm);
        }
        result = apply(s, e, audibleMs);
        db.prepare('UPDATE review_calls SET state=? WHERE id=?').run(JSON.stringify(s), id);
        db.prepare('INSERT INTO review_events(call,connection,event,body,result) VALUES(?,?,?,?,?)').run(
          id,
          connection,
          e.id,
          body,
          JSON.stringify(result)
        );
      }
      db.exec('COMMIT');
      return { result, snapshot: snapshot(s) };
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return {
    create,
    event,
    read: (id, token) => snapshot(load(id, token)),
    clip(id, token, eventId) {
      load(id, token);
      const row = db.prepare('SELECT pcm FROM review_audio WHERE call=? AND event=?').get(id, eventId);
      if (!row?.pcm.length) throw fail(404, '此回复没有播放回录。');
      return Buffer.from(row.pcm);
    },
    close: () => db.close(),
  };
}
function clipKey(e) {
  return digest(e.connection + '\n' + e.id);
}
