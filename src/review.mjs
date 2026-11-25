import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { callbackIntent, callbackPolicies, callbackVersion, deniesIdentity } from './contact.mjs';
import { guidanceTopic } from './guidance.mjs';
import { evidenceReport, voiceFrames } from './evidence.mjs';
import { disposition, lookupFaq } from './knowledge.mjs';

export const MODEL = 'qwen-audio-3.1-realtime-flash';
const caseId = 'POP-DEMO-018',
  revision = 1;
const materials = [
  {
    id: 'chain',
    title: '授权链路',
    prefix: '第一项，',
    requirement: '请补交品牌方到经销商的授权书，补齐中间的授权关系。',
    terms: ['品牌方', '经销商', '授权书'],
  },
  {
    id: 'seal',
    title: '盖章页',
    prefix: '第二项，',
    requirement: '请补交授权书的盖章页。请确认这页能看清双方公司名称、印章和授权有效期，再上传完整页面。',
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
  '对方报出名称或解释名称中汉字的写法时，都调用 verify_merchant。按工具要求澄清，不替商家举例或补字。必须等后端核身成功才解释案情。错号、否认身份就结束告知。',
  '按工具结果中的 say 说话。如有 point 或 questionTurn，请完整照读该答复，一次只讲一项。系统会安排下一项。不自行编造后续材料。',
  '被打断后先回答最新追问。问原因、材料、页码、上传路径或能否通过，必须调用 lookup_review_guidance。问还有哪项、要求继续时调用 get_call_progress，再按结果回答。',
  '工具返回无依据就说明需要核实。不能承诺审核通过，不宣称已实际向京麦提交。',
  '商家追问店铺操作、品牌资质或一般业务问题也要查询 lookup_review_guidance，无法归类时传 unknown。商家确认两项要求都已清楚后调用 get_call_progress，按结果礼貌结束。',
].join('\n');
const fn = (name, description, properties = {}) => ({
  type: 'function',
  function: {
    name,
    description,
    parameters: { type: 'object', properties, required: Object.keys(properties) },
  },
});
export function sessionConfig(turnMode = 'smart_turn_v2') {
  if (!['smart_turn_v2', 'server_vad'].includes(turnMode)) throw new Error('未知的轮次检测模式');
  return {
    modalities: ['audio', 'text'],
    voice: 'longanqian_v3.1',
    instructions,
    input_audio_transcription: { language: 'zh' },
    turn_detection: turnMode === 'server_vad' ? { type: turnMode, silence_duration_ms: 450 } : { type: turnMode },
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
const matches = (text) =>
  /^(?:您好|你好|对|是的|没错|好的|嗯)*(?:我们是|我是|这里是|这边是|是|我代表|我们公司叫|公司名称是|公司叫)?青禾商贸(?:有限公司|有限责任公司)?(?:的|的负责人|没错|对|是我)?$/.test(
    text
  );
// A homophone can prompt a spelling question but cannot establish identity by itself.
const soundsLikeMerchant = (words) => matches(words.replace(/[青清][禾河]商贸/u, '青禾商贸'));
function confirmsSpelling(words, previousMerchant) {
  const spelling = /^(.*?)(?:(?:第一个字|青|清)是|是)?(?:青草|青色|青春|青山|青菜)的[青清](?:(?:第二个字|禾|河)是|是)?(?:禾苗|禾本科|禾田)的[禾河](?:商贸)?$/u.exec(words);
  return spelling && soundsLikeMerchant(spelling[1] || normalize(previousMerchant?.text || ''));
}

const pointScript = (point) => point.prefix + point.requirement;
const writtenOpinion = materials.map((point) => point.requirement).join('\n');
const guidanceAnswers = { ...notes, chain: pointScript(materials[0]) };
const minSpeechMs = (text) => Math.max(500, normalize(text).length * 40);

function questions(s) {
  return s.questions ?? (s.pendingQuestion ? [{
    text: s.pendingQuestion, turn: s.questionTurn, connection: s.questionConnection,
    hasAnswer: s.questionHasAnswer === true,
  }] : []);
}

function snapshot(s) {
  return {
    caseId: s.caseId ?? caseId,
    revision: s.revision ?? revision,
    status: s.status,
    identity: s.identity,
    points: s.identity === 'verified'
      ? materials.map(({ id, title, requirement }) => ({ id, title, requirement, status: s.points[id] }))
      : [],
    turns: s.turns,
    tools: s.tools,
    pendingQuestion: questions(s).at(-1)?.text ?? null,
    questions: questions(s),
    callback: s.callback ?? null,
    callbackPolicy: s.callbackPolicy ?? 'callback-v1',
    confirmation: s.confirmation ?? null,
    routing: s.identity === 'verified' ? s.routing ?? null : null,
    recordings: s.recordings ?? {},
    connection: s.connection,
    receipt: s.receipt ?? null,
  };
}

export function partialResultExample() {
  return snapshot({
    status: 'ended', identity: 'verified', points: { chain: 'complete', seal: 'partial' },
    turns: [], tools: [], pendingQuestion: null, connection: null,
    receipt: { number: 'JM-EXAMPLE-018', issuedAt: null, opinion: writtenOpinion },
  });
}

export function openStore(file, { catalog = null, readOnly = false, turnMode = 'smart_turn_v2',
  policy = callbackVersion } = {}) {
  if (!Object.hasOwn(callbackPolicies, policy)) throw new Error('未知回电策略版本');
  sessionConfig(turnMode);
  const db = new DatabaseSync(file, { readOnly });
  if (!readOnly) db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=4000;
    CREATE TABLE IF NOT EXISTS review_calls (id TEXT PRIMARY KEY, token TEXT NOT NULL, state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS review_events (call TEXT, connection TEXT, event TEXT, body TEXT NOT NULL, result TEXT,
      created TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(call, connection, event));
    CREATE TABLE IF NOT EXISTS review_audio (call TEXT, event TEXT, pcm BLOB NOT NULL, PRIMARY KEY(call,event));
    CREATE TABLE IF NOT EXISTS review_recording_chunks (
      call TEXT NOT NULL, connection TEXT NOT NULL, offset INTEGER NOT NULL, pcm BLOB NOT NULL,
      PRIMARY KEY(call, connection, offset));
    CREATE TABLE IF NOT EXISTS review_receipts (
      case_id TEXT NOT NULL, revision INTEGER NOT NULL, number TEXT NOT NULL UNIQUE,
      issued_at TEXT NOT NULL, opinion TEXT NOT NULL, PRIMARY KEY(case_id, revision));`);
  function load(id, token) {
    const row = db.prepare('SELECT state FROM review_calls WHERE id=? AND token=?').get(id, digest(token));
    if (!row) throw fail(404, '找不到该测试通话。');
    return JSON.parse(row.state);
  }
  function writeReceipt(s) {
    const application = s.caseId ?? caseId, version = s.revision ?? revision;
    db.prepare(`INSERT INTO review_receipts (case_id, revision, number, issued_at, opinion)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(case_id, revision) DO NOTHING`)
      .run(application, version, 'JM-SIM-' + application + '-R' + version, new Date().toISOString(), writtenOpinion);
    const receipt = db.prepare(`SELECT number, issued_at AS issuedAt, opinion FROM review_receipts
      WHERE case_id=? AND revision=?`).get(application, version);
    return { ...receipt };
  }
  function create() {
    const id = randomUUID(),
      token = randomBytes(32).toString('base64url');
    const state = {
      caseId,
      revision,
      status: 'open',
      identity: 'pending',
      callbackPolicy: policy,
      turnMode,
      connection: null,
      turn: null,
      points: { chain: 'pending', seal: 'pending' },
      turns: [],
      tools: [],
      pendingQuestion: null,
    };
    if (catalog) {
      const scenario = catalog.scenarios.find(({ categories: [menu, family, reason] }) =>
        menu === '入驻' && family === '授权书-文审' && reason === '授权链路不完整');
      state.routing = disposition(scenario);
      if (state.routing.action !== 'call') throw fail(409, '该申请缺少允许外呼的业务依据，请复核资料版本。');
    }
    db.prepare('INSERT INTO review_calls VALUES(?,?,?)').run(id, digest(token), JSON.stringify(state));
    return { id, token, snapshot: snapshot(state) };
  }
  function progress(s) {
    if (s.identity !== 'verified') return { ok: false, say: '请先报出本次测试商家名称，以便核实身份。' };
    if (s.confirmation) return { ok: true, say: '感谢您的确认和接听，祝您生活愉快，再见。' };
    const next = materials.find((p) => s.points[p.id] !== 'complete');
    return next
      ? { ok: true, point: next.id, say: pointScript(next), source: '合成资审单 POP-DEMO-018 / v1' }
      : { ok: true, askConfirmation: true, say: '两项整改要求已说明。请问您都清楚了吗，还有哪项需要再说明？' };
  }
  function apply(s, e, audibleMs) {
    const currentSpeech = () =>
      s.turns.find((t) => t.connection === s.connection && t.item === e.turn && t.speaker === '商家');
    if (e.type === 'end' && s.status === 'ended' && s.connection === e.connection) return {};
    if (s.status !== 'open' && !['playback', 'recording', 'marker'].includes(e.type)) throw fail(409, '此通电话已结束，请发起新通话。');
    if (e.type === 'connect') {
      s.connection = randomUUID();
      s.turn = null;
      s.confirmationPrompt = null;
      return { connection: s.connection, session: sessionConfig(s.turnMode), next: progress(s) };
    }
    if (s.connection !== e.connection || !s.connection) throw fail(409, '通话连接已更换。');
    if (['marker', 'recording', 'setup', 'usage'].includes(e.type)) return {};
    if (e.type === 'turn') {
      s.turn = e.turn;
      if (!currentSpeech())
        s.turns.push({ connection: s.connection, item: e.turn, speaker: '商家', text: '' });
    } else if (e.type === 'transcript') {
      const turn = currentSpeech();
      if (!turn) throw fail(409, '缺少对应的语音轮次。');
      turn.text = e.text;
      if (s.turn === e.turn && deniesIdentity(e.text)) {
        s.identity = 'denied';
        s.status = 'wrong_number';
        s.questions = [];
        s.callback = null;
        s.confirmation = null;
      } else if (s.turn === e.turn) {
        const prompt = s.confirmationPrompt;
        if (s.identity === 'verified' && prompt?.connection === e.connection && prompt.turn !== e.turn && !questions(s).length &&
            materials.every((m) => s.points[m.id] === 'complete') &&
            /^(?:好的?|是的|嗯)?(?:这?两项)?(?:我)?(?:都)?(?:清楚了|明白了|了解了|听明白了)(?:没有(?:其他)?问题了?)?(?:谢谢)?$/.test(normalize(e.text))) {
          s.confirmation = { turn: e.turn, connection: e.connection, text: e.text, prompt: prompt.id };
        }
        s.confirmationPrompt = null;
        const action = callbackIntent(e.text, s.identity === 'verified', s.callbackPolicy ?? 'callback-v1');
        if (action === 'declined') s.callback = null;
        if (action === 'callback' || action === 'clarify')
          s.callback = { action, text: e.text, turn: e.turn, connection: s.connection };
      }
    } else if (e.type === 'tool') {
      let result;
      if (e.turn !== s.turn || !s.turn) result = { ok: false, say: '请听取商家最新的回答。' };
      else if (e.name === 'verify_merchant') {
        const words = normalize(currentSpeech()?.text || '');
        const previousMerchant = s.turns.findLast((t) =>
          t.connection === s.connection && t.speaker === '商家' && t.item !== e.turn);
        if (s.identity === 'verified' || matches(words) || confirmsSpelling(words, previousMerchant)) {
          s.identity = 'verified';
          result = progress(s);
        } else if (soundsLikeMerchant(words)) {
          result = { ok: false, say: '这个名称有同音的写法。请分别用一个词说明商家名称的前两个字怎么写。' };
        } else result = { ok: false, say: '暂时无法核实，请只说出完整测试商家名称。' };
      } else if (s.identity !== 'verified' || e.name === 'get_call_progress') result = progress(s);
      else if (e.name === 'lookup_review_guidance') {
        const question = currentSpeech()?.text || '';
        const topic = guidanceTopic(question, e.topic);
        const faq = topic ? null : lookupFaq(catalog, question);
        const answer = guidanceAnswers[topic] ?? faq?.answer;
        result = {
          ok: Boolean(answer),
          topic: faq ? 'faq' : topic,
          say: answer || '现有资料还不能确定这个问题的答复，我先记为待核实。您可以再具体说一下吗？',
          relatedPoint: topic === 'page' ? 'seal' : topic === 'chain' ? 'chain' : null,
          source: faq?.answer ? '赛方业务包 / ' + faq.citation.sheet + ' / 行 ' + faq.citation.row
            : answer ? '合成资审单 POP-DEMO-018 / v1' : null,
          ...(faq && { citation: faq.citation }),
          questionTurn: e.turn,
        };
        s.questions = questions(s).filter((q) => q.turn !== e.turn || q.connection !== s.connection);
        s.questions.push({ turn: e.turn, connection: s.connection, text: question, hasAnswer: result.ok,
          expectedAnswer: answer ?? null });
        s.confirmation = null;
        s.confirmationPrompt = null;
      } else throw fail(400, '未知业务工具。');
      s.tools.push({ name: e.name, ok: result.ok, turn: e.turn });
      return result;
    } else if (e.type === 'playback') {
      const expected = progress(s);
      if (e.askConfirmation && expected.askConfirmation && (e.turn ?? null) === s.turn && !e.interrupted && e.drained &&
          normalize(e.text) === normalize(expected.say) && audibleMs >= minSpeechMs(expected.say)) {
        s.confirmationPrompt = { connection: e.connection, turn: e.turn, id: e.id };
      }
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
        // A reply to a question is only loosely related to a material. Its filler alone cannot advance that material.
        if (!e.questionTurn || words.includes(normalize(point.prefix)) || point.terms.some((term) => words.includes(term))) {
          s.points[point.id] =
            !e.interrupted && e.drained && audibleMs >= minSpeechMs(pointScript(point)) && covered ? 'complete' : 'partial';
        }
      }
      if (
        s.status === 'open' &&
        e.questionTurn &&
        e.drained &&
        !e.interrupted &&
        e.text
      ) {
        const pending = questions(s);
        const index = pending.findIndex((q) => q.turn === e.questionTurn && q.connection === s.connection);
        const q = pending[index];
        if (q?.hasAnswer && q.expectedAnswer &&
            normalize(e.text) === normalize(q.expectedAnswer) && audibleMs >= minSpeechMs(q.expectedAnswer)) {
          // Repeating the same question after a reconnect can settle the original follow-up too.
          s.questions = pending.filter((other, i) => i > index || normalize(other.text) !== normalize(q.text));
        }
      }
      return { next: progress(s) };
    } else if (e.type === 'end') {
      if (s.identity === 'verified') s.receipt = writeReceipt(s);
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
      const pcm = ['playback', 'recording'].includes(e.type) ? Buffer.from(e.pcm || '', 'base64') : null;
      if (pcm && pcm.length % 2) throw fail(400, '无效的音频记录。');
      const body = JSON.stringify(pcm ? { ...e, pcm: digest(pcm) } : e);
      let result;
      if (old) {
        if (body !== old.body) throw fail(409, '事件编号已用于其他内容。');
        if (s.connection !== connection && e.type !== 'connect') throw fail(409, '通话连接已更换。');
        result = JSON.parse(old.result);
      } else {
        let audibleMs = 0;
        let firstSoundMs = null, lastSoundMs = null;
        if (e.type === 'recording') {
          s.recordings ??= {};
          const rec = s.recordings[connection] ?? { originMs: e.originMs, samples: 0, finished: false };
          if (rec.finished || rec.samples !== e.offset || rec.originMs !== e.originMs || pcm.length % 4 ||
              (!pcm.length && !e.final)) throw fail(409, '录音片段不连续。');
          db.prepare('INSERT INTO review_recording_chunks VALUES(?,?,?,?)').run(id, connection, e.offset, pcm);
          rec.samples += pcm.length / 4;
          rec.finished = e.final;
          s.recordings[connection] = rec;
        } else if (pcm) {
          const frames = voiceFrames(pcm, 1, 0, e.startMs ?? 0);
          audibleMs = frames.length * 20;
          if (frames.length && e.startMs != null) {
            firstSoundMs = frames[0];
            lastSoundMs = frames.at(-1) + 20;
          }
          db.prepare('INSERT INTO review_audio VALUES(?,?,?)').run(id, clipKey(e), pcm);
        }
        result = apply(s, e, audibleMs);
        if (e.type === 'playback') Object.assign(result, { firstSoundMs, lastSoundMs });
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
  function stereo(id, connection) {
    const rows = db.prepare('SELECT pcm FROM review_recording_chunks WHERE call=? AND connection=? ORDER BY offset').all(id, connection);
    if (!rows.length) throw fail(404, '本次连接没有质检录音。');
    return Buffer.concat(rows.map((row) => row.pcm));
  }
  function buildReport(id, state) {
    const s = snapshot(state);
    const playback = new Map(s.turns.filter((t) => t.speaker === 'AI').map((t) => [t.item, t.audibleMs]));
    const events = db.prepare('SELECT body,result FROM review_events WHERE call=? ORDER BY rowid').all(id).map((row) => {
      const e = JSON.parse(row.body), result = JSON.parse(row.result);
      if (e.type === 'playback') return { ...e, clip: clipKey(e), audibleMs: playback.get(clipKey(e)) ?? 0,
        firstSoundMs: result.firstSoundMs, lastSoundMs: result.lastSoundMs };
      return { ...e, result };
    });
    return evidenceReport(id, s, events, (conn) => stereo(id, conn));
  }
  // The offline reader has no HTTP routes and opens the database read-only.
  if (readOnly) return {
    *reports() {
      db.exec('BEGIN');
      try {
        for (const row of db.prepare('SELECT id,state FROM review_calls ORDER BY rowid').iterate())
          yield buildReport(row.id, JSON.parse(row.state));
      } finally { db.exec('ROLLBACK'); }
    },
    stereo, close: () => db.close(),
  };
  return {
    create, event,
    read: (id, token) => snapshot(load(id, token)),
    recording(id, token, connection) {
      load(id, token);
      return stereo(id, connection);
    },
    report: (id, token) => buildReport(id, load(id, token)),
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
