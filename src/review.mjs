import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { callbackIntent, callbackPolicies, callbackVersion, deniesIdentity } from './contact.mjs';
import { guidanceTopic, guidanceVersions } from './guidance.mjs';
import { evidenceReport, voiceFrames } from './evidence.mjs';
import { disposition, lookupFaq } from './knowledge.mjs';

import { fixedSpeech, audioKey, promptAudio } from './prompt-audio.mjs';
import { speechRisks } from './quality.mjs';
import { demoApplications, legacyApplication, applicationOf, routeApplication, identify, opinion, pointScript,
  commonAnswers, sourceLabel } from './applications.mjs';

export const MODEL = 'qwen-audio-3.1-realtime-flash';
const caseId = legacyApplication.caseId, revision = legacyApplication.revision;
const instructions = [
  '你是京东开放平台资审电话的模拟 AI 专员，使用简短的普通话。来电仅供测试，所有材料均为合成案例。',
  '主动开场说明 AI 身份，请对方主动报出测试商家名称。不得猜测、提示正确名称或索要真实个人信息。',
  '对方报出名称或解释名称中汉字的写法时，都调用 verify_merchant。按工具要求澄清，不替商家举例或补字。必须等后端核身成功才解释案情。错号、否认身份就结束告知。',
  '按工具结果中的 say 说话。如有 point 或 questionTurn，请完整照读该答复，一次只讲一项。系统会安排下一项。不自行编造后续材料。',
  '被打断后先回答最新追问。问原因、材料、页码、上传路径或能否通过，必须调用 lookup_review_guidance。问还有哪项、要求继续时调用 get_call_progress，再按结果回答。',
  '工具返回无依据就说明需要核实。不能承诺审核通过，不宣称已实际向京麦提交。',
  '商家追问店铺操作、品牌资质或一般业务问题也要查询 lookup_review_guidance，无法归类时传 unknown。商家确认本单要求都已清楚后调用 get_call_progress，按结果礼貌结束。',
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
  if (!['smart_turn_v2', 'server_vad','server_vad_750','local_vad'].includes(turnMode)) throw new Error('未知的轮次检测模式');
  return {
    modalities: ['audio', 'text'],
    voice: 'longanqian_v3.1',
    instructions,
    input_audio_transcription: { language: 'zh' },
    turn_detection: turnMode === 'local_vad' ? null : turnMode === 'smart_turn_v2' ? {type:turnMode} : {type:'server_vad',silence_duration_ms:turnMode === 'server_vad_750' ? 750 : 450},
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
      ? applicationOf(s).materials.map(({ id, title, requirement }) => ({ id, title, requirement, status: s.points[id] }))
      : [],
    turns: s.turns,
    tools: s.tools,
    pendingQuestion: questions(s).at(-1)?.text ?? null,
    questions: questions(s),
    callback: s.callback ?? null,
    callbackPolicy: s.callbackPolicy ?? 'callback-v1',
    guidancePolicy:s.guidancePolicy ?? 'grounded-v1',
    confirmation: s.confirmation ?? null,
    routing: s.identity === 'verified' || s.handling ? s.routing ?? null : null,
    handling: s.handling ?? null,
    handoff: s.handoff ?? null,
    recordings: s.recordings ?? {},
    connection: s.connection,
    receipt: s.receipt ?? null,
  };
}

export function partialResultExample() {
  return snapshot({
    status: 'ended', identity: 'verified', points: { chain: 'complete', seal: 'partial' },
    turns: [], tools: [], pendingQuestion: null, connection: null,
    receipt: { number: 'JM-EXAMPLE-018', issuedAt: null, opinion: opinion(legacyApplication) },
  });
}

export function openStore(file, { catalog = null, readOnly = false, turnMode = 'smart_turn_v2',
  policy = callbackVersion, applications = demoApplications, guidancePolicy = 'grounded-v2', promptDir = null } = {}) {
  if (!Object.hasOwn(callbackPolicies, policy)) throw new Error('未知回电策略版本');
  sessionConfig(turnMode);
  if (!guidanceVersions.includes(guidancePolicy)) throw new Error('未知材料问答版本');
  const db = new DatabaseSync(file, { readOnly });
  if (!readOnly) db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=4000;
    CREATE TABLE IF NOT EXISTS review_calls (id TEXT PRIMARY KEY, token TEXT NOT NULL, state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS review_events (call TEXT, connection TEXT, event TEXT, body TEXT NOT NULL, result TEXT,
      created TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(call, connection, event));
    CREATE TABLE IF NOT EXISTS review_audio (call TEXT, event TEXT, pcm BLOB NOT NULL, PRIMARY KEY(call,event));
    CREATE TABLE IF NOT EXISTS review_recording_chunks (
      call TEXT NOT NULL, connection TEXT NOT NULL, offset INTEGER NOT NULL, pcm BLOB NOT NULL,
      PRIMARY KEY(call, connection, offset));
    CREATE TABLE IF NOT EXISTS review_jobs (
      case_id TEXT NOT NULL, revision INTEGER NOT NULL, kind TEXT NOT NULL, owner TEXT,
      status TEXT NOT NULL, PRIMARY KEY(case_id,revision,kind));
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
      .run(application, version, 'JM-SIM-' + application + '-R' + version, new Date().toISOString(), opinion(applicationOf(s)));
    const receipt = db.prepare(`SELECT number, issued_at AS issuedAt, opinion FROM review_receipts
      WHERE case_id=? AND revision=?`).get(application, version);
    return { ...receipt };
  }
  function cards() {
    return applications.map(a => {
      const routing = routeApplication(a, catalog);
      return {caseId:a.caseId, revision:a.revision, merchant:a.merchant, categories:a.categories, facts:a.facts,
        spelling:a.spelling?.map(p => p.words[0] + '的' + p.forms[0]).join('，') ?? null, routing};
    });
  }
  function job(s, kind) {
    db.prepare("INSERT OR IGNORE INTO review_jobs(case_id, revision, kind, status) VALUES(?,?,?,'pending')")
      .run(s.caseId ?? caseId,s.revision ?? revision,kind);
    return kind + '-' + (s.caseId ?? caseId) + '-R' + (s.revision ?? revision);
  }
  function create(selected = applications[0].caseId) {
    const application = applications.find(a => a.caseId === selected);
    if (!application) throw fail(404,'找不到指定案卷。');
    const {caseId, revision} = application;
    const id = randomUUID(),
      token = randomBytes(32).toString('base64url');
    const state = {
      caseId,
      revision,
      status: 'open',
      identity: 'pending',
      callbackPolicy: policy, guidancePolicy,
      turnMode,
      connection: null,
      turn: null,
      application,
      points: Object.fromEntries(application.materials.map(m => [m.id,'pending'])),
      turns: [],
      tools: [],
      pendingQuestion: null,
    };
    state.routing = routeApplication(application,catalog);
    const {action} = state.routing;
    if (action === 'review') throw fail(409,'该申请缺少分流依据，请核对业务资料。');
    db.exec('BEGIN IMMEDIATE');
    try {
      if (action === 'written') {
        state.handling = {action};
        state.receipt = writeReceipt(state);
        state.status = 'ended';
      } else if (action === 'retry' || action === 'callback') {
        state.handling = {action, job:job(state,action)};
        state.status = 'scheduled';
        const prior = db.prepare('SELECT status FROM review_jobs WHERE case_id=? AND revision=? AND kind=?')
          .get(caseId,revision,action);
        if (prior.status === 'written') {
          state.status = 'ended';
          state.receipt = writeReceipt(state);
          state.handling.outcome = 'missed';
        } else if (prior.status !== 'pending') state.handling.outcome = prior.status;
      }
      db.prepare('INSERT INTO review_calls VALUES(?,?,?)').run(id, digest(token), JSON.stringify(state));
      db.exec('COMMIT');
    } catch (err) { db.exec('ROLLBACK'); throw err; }
    return { id, token, snapshot: snapshot(state) };
  }
  function dispatch(id,token,decision) {
    if (!['dial','missed'].includes(decision)) throw fail(400,'未知跟进动作。');
    db.exec('BEGIN IMMEDIATE');
    try {
      const s = load(id,token), h = s.handling;
      if (!['retry','callback'].includes(h?.action)) throw fail(409,'该案卷没有待处理的外呼任务。');
      const row = db.prepare('SELECT * FROM review_jobs WHERE case_id=? AND revision=? AND kind=?')
        .get(s.caseId,s.revision,h.action);
      if (row.status === 'pending') {
        if (decision === 'missed' && h.action === 'callback') throw fail(409,'强制回电任务须保留人工跟进。');
        const status = decision === 'dial' ? 'in_progress' : 'written';
        db.prepare('UPDATE review_jobs SET status=?,owner=? WHERE case_id=? AND revision=? AND kind=?')
          .run(status,id,s.caseId,s.revision,h.action);
        h.outcome = decision === 'dial' ? 'in_progress' : 'missed';
        s.status = decision === 'dial' ? 'open' : 'ended';
        if (decision === 'missed') s.receipt = writeReceipt(s);
        db.prepare('UPDATE review_calls SET state=? WHERE id=?').run(JSON.stringify(s),id);
      } else if (!(row.owner === id && ((decision === 'dial' && s.status === 'open') ||
          (decision === 'missed' && h.outcome === 'missed')))) throw fail(409,'该任务已在其他步骤办理。');
      db.exec('COMMIT');
      return snapshot(s);
    } catch (err) { db.exec('ROLLBACK'); throw err; }
  }
  function progress(s) {
    if (s.identity !== 'verified') return { ok: false, say: fixedSpeech.askName };
    if (s.confirmation) return { ok: true, say: fixedSpeech.confirmed };
    if (s.handoff) return {ok:true, say:fixedSpeech.handoff};
    const a = applicationOf(s);
    const next = a.materials.find((p) => s.points[p.id] !== 'complete');
    return next
      ? { ok: true, point: next.id, say: pointScript(next), source: sourceLabel(a) }
      : { ok: true, askConfirmation: true, say: a.materials.length === 2 ? fixedSpeech.confirmTwo : fixedSpeech.confirmOther };
  }
  function apply(s, e, audibleMs) {
    const a = applicationOf(s), materials = a.materials;
    const currentSpeech = () =>
      s.turns.find((t) => t.connection === s.connection && t.item === e.turn && t.speaker === '商家');
    if (e.type === 'end' && s.status === 'ended' && s.connection === e.connection) return {};
    if (s.status !== 'open' && !['playback', 'recording', 'marker'].includes(e.type)) throw fail(409, '此通电话已结束，请发起新通话。');
    if (e.type === 'connect') {
      s.connection = randomUUID();
      s.localSpeech = ['gateway','local'].includes(e.transport) && Boolean(promptDir);
      s.offline = e.transport === 'local';
      if (s.turnMode === 'local_vad' && !['gateway','local'].includes(e.transport)) throw fail(409,'本地断句需要以网关模式启动。');
      s.turn = null;
      s.confirmationPrompt = null;
      return { connection: s.connection, offline:s.offline, listenerCue:e.listenerCue === true, turnMode:s.turnMode, session: sessionConfig(s.turnMode), next: (s.offline && s.identity === 'verified' && questions(s).length) ? {say:fixedSpeech.repeatQuestion} : progress(s),
        ...(s.identity === 'pending' && s.localSpeech && {opening:{say:fixedSpeech.opening}}) };
    }
    if (s.connection !== e.connection || !s.connection) throw fail(409, '通话连接已更换。');
    if (['marker', 'recording', 'setup', 'usage', 'blocked'].includes(e.type)) return {};
    if (e.type === 'turn') {
      s.turn = e.turn;
      if (!currentSpeech())
        s.turns.push({ connection: s.connection, item: e.turn, speaker: '商家', text: '' });
    } else if (e.type === 'transcript') {
      const turn = currentSpeech();
      if (!turn) throw fail(409, '缺少对应的语音轮次。');
      turn.text = e.text;
      if (s.turn === e.turn && deniesIdentity(e.text,a.merchant)) {
        s.identity = 'denied';
        s.status = 'wrong_number';
        s.handoff = null;
        s.questions = [];
        s.callback = null;
        s.confirmation = null;
      } else if (s.turn === e.turn) {
        if (s.identity === 'verified' && /^(?:请|麻烦|帮我|给我|我要|我想|请帮我|我要投诉[，,。 ]*)*(?:转(?:接)?人工(?:客服|专员)?|找人工客服|人工客服跟进)(?:处理|跟进|一下)?[。！!]?$/u.test(e.text.trim())) {
          s.handoff = {number:job(s,'human'), turn:e.turn, text:e.text};
          s.confirmation = null;
        }
        const prompt = s.confirmationPrompt;
        if (!s.handoff && s.identity === 'verified' && prompt?.connection === e.connection && prompt.turn !== e.turn && !questions(s).length &&
            materials.every((m) => s.points[m.id] === 'complete') &&
            /^(?:好的?|是的|嗯)?(?:这?两项)?(?:我)?(?:都)?(?:清楚了|明白了|了解了|听明白了)(?:没有(?:其他)?问题了?)?(?:谢谢)?$/.test(normalize(e.text))) {
          s.confirmation = { turn: e.turn, connection: e.connection, text: e.text, prompt: prompt.id };
        }
        s.confirmationPrompt = null;
        const action = callbackIntent(e.text, s.identity === 'verified', s.callbackPolicy ?? 'callback-v1');
        s.contactTurn = action === 'none' ? null : {action,turn:e.turn,connection:e.connection};
        if (action === 'declined') {
          db.prepare("UPDATE review_jobs SET status='withdrawn' WHERE case_id=? AND revision=? AND kind='merchant_callback' AND status='pending'")
            .run(s.caseId ?? caseId,s.revision ?? revision);
          s.callback = null;
        }
        if (action === 'callback' || action === 'clarify') {
          const number = action === 'callback' ? job(s,'merchant_callback') : null;
          if (number) db.prepare("UPDATE review_jobs SET status='pending' WHERE case_id=? AND revision=? AND kind='merchant_callback' AND status='withdrawn'")
            .run(s.caseId,s.revision);
          s.callback = {action,number,text:e.text,turn:e.turn,connection:s.connection};
        }
      }
    } else if (e.type === 'tool') {
      let result;
      const words = currentSpeech()?.text ?? '';
      const auto = e.name === 'resolve_local_turn' && s.offline;
      const name = auto ? (s.identity !== 'verified' ? 'verify_merchant' :
        s.confirmation || s.handoff || s.contactTurn?.turn === e.turn || /^(?:请|麻烦)?(?:继续|接着|还有什么没说完|还有哪些)(?:讲|说|说完|说明)?[。？]?$/u.test(words)
          ? 'get_call_progress' : 'lookup_review_guidance') : e.name;
      if (e.turn !== s.turn || !s.turn) result = { ok: false, say: '请听取商家最新的回答。' };
      else if (name === 'verify_merchant') {
        const words = normalize(currentSpeech()?.text || '');
        const previousMerchant = s.turns.findLast((t) =>
          t.connection === s.connection && t.speaker === '商家' && t.item !== e.turn);
        const verification = identify(a, words, previousMerchant?.text);
        if (s.identity === 'verified' || verification === 'verified') {
          s.identity = 'verified';
          result = progress(s);
        } else if (verification === 'clarify') {
          result = { ok: false, say: fixedSpeech.spelling };
        } else result = { ok: false, say: fixedSpeech.retryIdentity };
      } else if (s.identity === 'verified' && !s.handoff && s.contactTurn?.turn === e.turn &&
          s.contactTurn.connection === e.connection && fixedSpeech[s.contactTurn.action]) {
        result={ok:true,say:fixedSpeech[s.contactTurn.action]};
      } else if (s.identity !== 'verified' || s.handoff || name === 'get_call_progress') result = progress(s);
      else if (name === 'lookup_review_guidance') {
        const question = currentSpeech()?.text || '';
        const unrelated = /授权书|盖章页|授权链路/u.test(question) &&
          !a.materials.some(p => /授权书|盖章页|授权链路/u.test(p.requirement));
        const topic = unrelated ? null : guidanceTopic(question, auto ? 'page' : e.topic, s.guidancePolicy ?? 'grounded-v1');
        const faq = topic ? null : lookupFaq(catalog, question);
        const entry = a.answers[topic] ?? commonAnswers[topic];
        const answer = entry?.say ?? faq?.answer;
        result = {
          ok: Boolean(answer),
          topic: faq ? 'faq' : topic,
          say: answer || fixedSpeech.unknown,
          relatedPoint: entry?.point ?? null,
          source: faq?.answer ? '赛方业务包 / ' + faq.citation.sheet + ' / 行 ' + faq.citation.row
            : answer ? sourceLabel(a) : null,
          ...(faq && { citation: faq.citation }),
          questionTurn: e.turn,
        };
        s.questions = questions(s).filter((q) => q.turn !== e.turn || q.connection !== s.connection);
        s.questions.push({ turn: e.turn, connection: s.connection, text: question, hasAnswer: result.ok,
          expectedAnswer: answer ?? null });
        s.confirmation = null;
        s.confirmationPrompt = null;
      } else throw fail(400, '未知业务工具。');
      if(auto) result.executedTool=name;
      s.tools.push({ name, ok: result.ok, turn: e.turn });
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
        if (e.type === 'playback' && e.point && !applicationOf(s).materials.some(m => m.id === e.point))
          throw fail(400,'材料不属于当前案卷。');
        result = apply(s, e, audibleMs);
        if (s.localSpeech && promptDir) for (const plan of [result, result.next, result.opening]) {
          if (plan?.say) {
            const key = promptAudio(s,promptDir,audioKey(plan.say));
            if (key) plan.audio = key;
          }
        }
        if (s.handling?.outcome === 'in_progress' && ['ended','wrong_number'].includes(s.status)) {
          s.handling.outcome = s.status === 'wrong_number' ? 'wrong_number' : s.identity === 'verified' ? 'contacted' : 'unverified';
          db.prepare('UPDATE review_jobs SET status=? WHERE case_id=? AND revision=? AND kind=? AND owner=?')
            .run(s.handling.outcome,s.caseId,s.revision,s.handling.action,id);
        }
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
      return { ...e, ...(result?.executedTool && {name:result.executedTool}), result };
    });
    return evidenceReport(id, s, events, (conn) => stereo(id, conn), applicationOf(state));
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
    create, cards, dispatch, event,
    prompt(id,token,key) {
      const result = promptAudio(load(id,token),promptDir,key,true);
      if (!result) throw fail(404,'当前案卷无此段获准播报的语音。');
      return result;
    },
    screen(id,token,connection,text) {
      const s = load(id,token);
      if (s.connection !== connection || s.status !== 'open') return '连接或案卷已失效';
      return !text?.trim() ? '缺少完整转写' : speechRisks(text,s.identity === 'verified',applicationOf(s)).map(([,label])=>label).join('、');
    },
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
