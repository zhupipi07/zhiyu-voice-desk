import { VoiceCall } from './realtime.mjs';
import { renderResult } from './result.mjs';
const $ = (id) => document.getElementById(id);
const example = new URLSearchParams(location.search).get('example') === 'partial';
let apiReady = false,
  ticket,
  state,
  voice,
  connection,
  busy = false,
  online = false,
  queue = Promise.resolve();
let replay, replayUrl, startedAt;
const labels = {
  pending: '待讲',
  partial: '已播部分',
  complete: '已播完整',
  verified: '已核实',
  denied: '身份不符',
};
const toolNames = {
  verify_merchant: '核实商家身份',
  lookup_review_guidance: '查询材料依据',
  get_call_progress: '读取通话进度',
};
const setNotice = (message) => {
  $('notice').textContent = message;
  $('result-notice').textContent = message;
  $('result-notice').hidden = !message;
};
function uiStatus(message) {
  $('status').textContent = message;
}
setInterval(() => {
  if (!online || !startedAt) return;
  const sec = Math.floor((Date.now() - startedAt) / 1000);
  $('clock').textContent = [Math.floor(sec / 60), sec % 60]
    .map((v) => String(v).padStart(2, '0'))
    .join(':');
}, 500);
function buttons() {
  $('start').disabled = !apiReady || busy || Boolean(voice);
  $('result-start').disabled = $('start').disabled;
  $('record-evidence').disabled = busy || Boolean(voice);
  $('start').textContent = state?.status === 'open' ? '继续上次通话' : '开始模拟通话';
  $('end').disabled = busy || (!voice && state?.status !== 'open');
  $('wave').classList.toggle('live', online);
}
async function request(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { ...(ticket && { Authorization: 'Bearer ' + ticket.token }), ...options.headers },
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw Object.assign(new Error(error.error || '本地服务连接失败。'), { status: res.status });
  }
  return res;
}
function route(suffix = '') {
  return '/api/calls/' + ticket.id + suffix;
}
function downloadButton(label, suffix, filename) {
  const b = document.createElement('button');
  b.className = 'secondary';
  b.textContent = label;
  b.onclick = async () => {
    try {
      const blob = await (await request(route(suffix))).blob();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    } catch (err) { setNotice(err.message); }
  };
  return b;
}
function render(s) {
  state = s;
  renderResult(s, example);
  const downloads = $('evidence-downloads');
  downloads.hidden = !ticket || !s || s.status === 'open' || example;
  if (!downloads.hidden) {
    downloads.replaceChildren(downloadButton('下载逐轮质检记录', '/evidence', ticket.id + '.json'));
    for (const [index, [conn, rec]] of Object.entries(s.recordings || {}).entries()) {
      if (rec.samples) downloads.append(downloadButton('连接 ' + (index + 1) + ' 双声道录音' + (rec.finished ? '' : '（片段）'),
        '/recordings/' + conn, ticket.id + '-' + conn + '.wav'));
    }
  }
  const log = $('transcript');
  log.replaceChildren();
  for (const t of s?.turns || []) {
    const li = document.createElement('li'),
      who = document.createElement('b');
    who.textContent = t.speaker;
    li.append(who, document.createTextNode(t.text || (t.speaker === 'AI' ? '语音片段' : '正在识别…')));
    if (t.interrupted) {
      const hint = document.createElement('small');
      hint.textContent = ' · 已打断';
      li.append(hint);
    }
    if (t.audibleMs > 0) {
      const b = document.createElement('button');
      b.className = 'replay';
      b.textContent = '回听';
      b.disabled = Boolean(voice);
      b.onclick = async () => {
        try {
          stopReplay();
          const blob = await (await request(route('/clips/' + encodeURIComponent(t.item)))).blob();
          replayUrl = URL.createObjectURL(blob);
          replay = new Audio(replayUrl);
          await replay.play();
        } catch (err) {
          setNotice(err.message);
        }
      };
      li.append(b);
    }
    log.append(li);
  }
  if (!log.children.length) log.append(empty('接通后的对话将显示在这里。'));
  log.scrollTop = log.scrollHeight;
  const dl = $('progress');
  dl.replaceChildren();
  const rows = [['身份核验', s?.identity === 'pending' || !s ? '待核实' : labels[s.identity]]];
  for (const p of s?.points || []) rows.push([p.title, labels[p.status]]);
  if (s?.pendingQuestion) rows.push(['待答追问', s.pendingQuestion]);
  for (const [name, value] of rows) {
    const div = document.createElement('div'),
      dt = document.createElement('dt'),
      dd = document.createElement('dd');
    dt.textContent = name;
    dd.textContent = value;
    div.append(dt, dd);
    dl.append(div);
  }
  const tools = $('tools');
  tools.replaceChildren();
  for (const t of (s?.tools || []).slice(-6)) {
    const li = document.createElement('li');
    li.textContent = (toolNames[t.name] || t.name) + ' · ' + (t.ok ? '成功' : '待核实');
    tools.append(li);
  }
  if (!tools.children.length) tools.append(empty('尚无调用'));
  buttons();
}
function empty(text) {
  const li = document.createElement('li');
  li.className = 'empty';
  li.textContent = text;
  return li;
}
function stopReplay() {
  replay?.pause();
  if (replayUrl) URL.revokeObjectURL(replayUrl);
  replay = null;
  replayUrl = null;
}
function event(payload) {
  const url = route('/events'),
    body = JSON.stringify({ connection, ...payload });
  const send = async () => {
    const res = await request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const data = await res.json();
    render(data.snapshot);
    return data;
  };
  const task = queue.then(send);
  queue = task.catch(() => {});
  return task;
}
async function stop(endCall, message = '') {
  busy = true;
  online = false;
  const v = voice;
  voice = null;
  buttons();
  try {
    try {
      await v?.close();
    } catch (err) {
      message ||= err.message;
    }
    await queue;
    if (endCall && ticket && state?.status === 'open')
      await event({ type: 'end', id: crypto.randomUUID() });
  } catch (err) {
    if (!message) message = err.message;
  } finally {
    busy = false;
    uiStatus(
      state?.status === 'wrong_number'
        ? '错号已结束'
        : state?.status === 'open'
          ? '通话已中断'
          : '通话已结束'
    );
    setNotice(message);
    render(state);
  }
}
$('start').onclick = async () => {
  busy = true;
  startedAt = null;
  $('clock').textContent = '00:00';
  stopReplay();
  setNotice('');
  buttons();
  uiStatus('正在准备麦克风');
  try {
    if (!ticket || state?.status !== 'open') {
      const response = await (await request('/api/calls', { method: 'POST' })).json();
      ticket = { id: response.id, token: response.token };
      render(response.snapshot);
      sessionStorage.setItem('review-ticket', JSON.stringify(ticket));
    }
    connection = null;
    const { result, snapshot } = await event({ type: 'connect', id: crypto.randomUUID() });
    connection = snapshot.connection;
    const transport = new VoiceCall({
      config: result.session,
      recordEvidence: $('record-evidence').checked,
      restored: result.next,
      event,
      current: () => state,
      status: (message) => {
        online = transport.ready;
        if (online) startedAt ||= Date.now();
        uiStatus(message);
        buttons();
      },
      failure: (err) => {
        if (voice === transport) void stop(false, err.message);
      },
      exchange: async (sdp, signal) =>
        (
          await request(route('/sdp'), {
            method: 'POST',
            signal,
            headers: { 'Content-Type': 'application/sdp', 'X-Connection': connection },
            body: sdp,
          })
        ).text(),
    });
    voice = transport;
    await transport.start();
  } catch (err) {
    await stop(
      false,
      err.name === 'NotAllowedError' ? '麦克风权限被拒绝，请在地址栏允许后重新连接。' : err.message
    );
  } finally {
    busy = false;
    buttons();
  }
};
$('end').onclick = () => stop(true);
$('result-start').onclick = () => $('start').click();
async function init() {
  try {
    if (example) {
      render(await (await request('/api/examples/partial-result')).json());
      return;
    }
    const health = await (await request('/api/status')).json();
    apiReady = health.ready;
    const saved = sessionStorage.getItem('review-ticket');
    if (saved) {
      try {
        ticket = JSON.parse(saved);
        state = await (await request(route())).json();
        connection = state.connection;
      } catch {
        ticket = null;
        sessionStorage.removeItem('review-ticket');
      }
    }
    uiStatus(state?.status === 'open' ? '可以恢复通话' : '等待接通');
    if (!apiReady) setNotice('请在服务端 .env 配置北京百炼密钥和业务空间，然后重新启动。');
  } catch (err) {
    setNotice(err.message);
  }
  render(state);
}
init();
