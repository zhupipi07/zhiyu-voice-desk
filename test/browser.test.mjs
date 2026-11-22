import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';
import { MODEL, openStore } from '../src/review.mjs';
import { VoiceCall } from '../public/realtime.mjs';

const chrome = [
  process.env.CHROME_BIN,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((path) => path && existsSync(path));

// Runs in the browser. Only the cloud peer is substituted. The application, microphone track,
// ICE, media and data channels, output mixer, HTTP routes and SQLite all run normally.
function installTestPeer() {
  let peer,
    channel,
    gain,
    ctx,
    seq = 0,
    active = 0,
    plan,
    msg;
  const id = () => String(++seq);
  const emit = (e) => {
    if (channel?.readyState === 'open') channel.send(JSON.stringify({ event_id: 'evt' + id(), ...e }));
  };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  window.fixture = {
    speaking: '',
    replies: [],
    events: [],
    diagnostics: () => [peer?.connectionState, channel?.readyState, ctx?.state],
    async answer(offer) {
      active++;
      window.fixture.speaking = '';
      plan = null;
      msg = null;
      peer?.close();
      if (ctx) await ctx.close();
      ctx = new AudioContext();
      await ctx.resume();
      const oscillator = ctx.createOscillator();
      gain = ctx.createGain();
      gain.gain.value = 0;
      const dest = ctx.createMediaStreamDestination();
      oscillator.connect(gain).connect(dest);
      oscillator.start();
      peer = new RTCPeerConnection();
      peer.addTrack(dest.stream.getAudioTracks()[0], dest.stream);
      channel = peer.createDataChannel('txt');
      channel.onopen = () => emit({ type: 'session.created' });
      channel.onmessage = ({ data }) => {
        const e = JSON.parse(data);
        window.fixture.events.push(e.type);
        if (e.type === 'session.update') {
          window.fixture.config = e.session;
          emit({ type: 'session.updated' });
        }
        if (e.type === 'conversation.item.create') {
          if (e.item.type === 'function_call_output') {
            plan = JSON.parse(e.item.output);
            window.fixture.replies.push(plan);
          } else msg = e.item.content[0].text;
        }
        if (e.type === 'response.create') {
          const words = plan?.say || msg || '';
          plan = null;
          msg = null;
          void speak(words, words.includes('第二项') ? 3800 : 1600);
        }
      };
      await peer.setRemoteDescription({ type: 'offer', sdp: offer });
      await peer.setLocalDescription(await peer.createAnswer());
      while (peer.iceGatheringState !== 'complete') await wait(30);
      return peer.localDescription.sdp;
    },
    ask(text, name, topic) {
      active++;
      gain.gain.value = 0;
      window.fixture.speaking = '';
      const turn = 'user' + id();
      emit({ type: 'input_audio_buffer.speech_started', item_id: turn });
      emit({ type: 'input_audio_buffer.committed', item_id: turn });
      emit({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: turn,
        transcript: text,
      });
      if (!name) return;
      const rid = 'tool' + id(),
        call = 'call' + id();
      emit({ type: 'response.created', response: { id: rid } });
      const item = { type: 'function_call', name, call_id: call, arguments: JSON.stringify({ topic }) };
      emit({ ...item, type: 'response.function_call_arguments.done', response_id: rid });
      emit({ type: 'response.done', response: { id: rid, status: 'completed', output: [item] } });
    },
  };
  async function speak(words, duration) {
    const generation = ++active,
      rid = 'response' + id();
    window.fixture.speaking = words;
    emit({ type: 'response.created', response: { id: rid } });
    emit({ type: 'response.audio_transcript.delta', response_id: rid, delta: words.slice(0, 7) });
    await wait(100);
    if (active !== generation) return;
    gain.gain.value = 0.13;
    await wait(duration);
    if (active !== generation) return;
    gain.gain.value = 0;
    window.fixture.speaking = '';
    emit({ type: 'response.audio_transcript.done', response_id: rid, transcript: words });
    emit({ type: 'response.done', response: { id: rid, status: 'completed', output: [] } });
  }
}

test('an answered question between materials resumes the next item while other follow-ups stay pending', async () => {
  const questions = [{ connection: 'conn', turn: 'fee', hasAnswer: false }];
  const next = { point: 'seal', say: '第二项，请补交盖章页。' };
  const voice = new VoiceCall({
    status() {},
    event: async () => ({ result: { next }, snapshot: { points: [], connection: 'conn', questions,
      pendingQuestion: questions.at(-1)?.turn } }),
  });
  voice.playback.cut = async () => ({ pcm: 'audio' });
  const requests = [];
  voice.request = (_instructions, plan) => requests.push(plan.point);
  const reply = { id: 'reply', epoch: voice.epoch, turn: 'page', text: '页码答复',
    plan: { ok: true, questionTurn: 'page' }, tools: new Map() };
  questions.push({ connection: 'conn', turn: 'page', hasAnswer: true });
  await voice.savePlayback(reply, false, true);
  assert.deepEqual(requests, []);
  questions.pop();
  await voice.savePlayback(reply, false, true);
  assert.deepEqual(requests, ['seal']);
});

async function until(fn, label, ms = 12000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err.message;
    }
    await delay(80);
  }
  throw new Error('Timed out: ' + label + ' (' + last + ')');
}
test(
  'browser completes a simulated Flash call across an interruption and plays the recorded evidence',
  { skip: !chrome && 'Set CHROME_BIN to run the browser test', timeout: 65000 },
  async (t) => {
    const root = realpathSync(tmpdir()),
      profile = mkdtempSync(join(root, 'zhiyu-browser-'));
    const proc = spawn(
      chrome,
      [
        '--headless=new',
        '--mute-audio',
        '--disable-gpu',
        '--disable-extensions',
        '--no-first-run',
        '--autoplay-policy=no-user-gesture-required',
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--remote-debugging-port=0',
        '--user-data-dir=' + profile,
        'about:blank',
      ],
      { stdio: 'ignore', windowsHide: true }
    );
    let socket, server;
    const store = openStore(':memory:');
    t.after(async () => {
      socket?.close();
      if (proc.exitCode === null && proc.signalCode === null) {
        const exited = once(proc, 'exit');
        proc.kill();
        await Promise.race([exited, delay(1500)]);
      }
      if (server) {
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
      }
      store.close();
      if (dirname(realpathSync(profile)) === root && profile.startsWith(join(root, 'zhiyu-browser-')))
        rmSync(profile, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
    });
    const port = await until(
      () => readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0],
      'Chrome launch'
    );
    const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    socket = new WebSocket(pages.find((p) => p.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = reject;
    });
    let n = 0;
    const pending = new Map();
    socket.onmessage = ({ data }) => {
      const e = JSON.parse(data);
      const pair = pending.get(e.id);
      if (pair) {
        pending.delete(e.id);
        e.error ? pair.reject(new Error(e.error.message)) : pair.resolve(e.result);
      }
    };
    function cdp(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++n;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    }
    async function run(expression) {
      const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails)
        throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    }
    server = createApp({
      store,
      key: 'local-test-key',
      workspace: 'ws-fixture',
      upstream: async (url, options) => {
        assert.equal(new URL(url).searchParams.get('model'), MODEL);
        return new Response(await run('window.fixture.answer(' + JSON.stringify(options.body) + ')'));
      },
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = 'http://127.0.0.1:' + server.address().port;
    await cdp('Page.enable');
    await cdp('Page.navigate', { url });
    const ui = (id) => run('document.getElementById(' + JSON.stringify(id) + ')?.textContent');
    const click = (id) => run('document.getElementById(' + JSON.stringify(id) + ').click()');
    const ask = (...args) => run('window.fixture.ask(...' + JSON.stringify(args) + ')');
    const text = async (id, part) => {
      try {
        return await until(async () => (await ui(id))?.includes(part), id + ' contains ' + part);
      } catch (err) {
        throw new Error(
          err.message +
            ' ' +
            JSON.stringify(
              await run(
                '({status:document.querySelector("#status").textContent,notice:document.querySelector("#notice").textContent,transcript:document.querySelector("#transcript").textContent,peer:window.fixture?.diagnostics(),events:window.fixture?.events})'
              )
            )
        );
      }
    };
    await until(() => run('document.getElementById("start")?.disabled===false'), 'page ready');
    await run('(' + installTestPeer.toString() + ')()');
    await click('start');
    await text('transcript', '只作开场核身'); // the fixture echoes the opening instruction
    assert.equal(await run('window.fixture.config.turn_detection.type'), 'smart_turn_v2');
    await ask('请先告诉我缺什么', 'lookup_review_guidance', 'page');
    await text('tools', '查询材料依据 · 待核实');
    await text('transcript', '以便核实身份');
    await ask('我是青禾商贸', 'verify_merchant');
    await text('progress', '已核实');
    await until(() => run('window.fixture.speaking.includes("第二项")'), 'second material is being played');
    await delay(850);
    // Replay the field failure: the model selected the authorization chain for a page question.
    await ask('具体要补哪一页', 'lookup_review_guidance', 'chain');
    await text('progress', '已播部分');
    await text('tools', '查询材料依据 · 成功');
    await text('transcript', '按内容认页');
    await until(
      () =>
        run(
          'document.querySelectorAll("#progress dd").length===3 && [...document.querySelectorAll("#progress dd")].filter(x=>x.textContent==="已播完整").length===2'
        ),
      'resume and finish both items',
      16000
    );
    const saved = await run('sessionStorage.getItem("review-ticket")');
    await cdp('Page.reload');
    await text('status', '可以恢复通话');
    assert.equal(await run('sessionStorage.getItem("review-ticket")'), saved);
    await run('(' + installTestPeer.toString() + ')()');
    await click('start');
    await until(
      () => run('window.fixture.speaking.includes("已恢复原通话")'),
      'restored same verified call'
    );
    await click('end');
    await text('status', '通话已结束');
    await text('result-summary', '2 项材料已讲完，0 项材料待跟进');
    assert.equal(await run('document.querySelectorAll("#transcript .replay").length>0'), true);
    await run('document.querySelector("#transcript .replay").click()');
    await run('document.querySelector("#record-evidence").checked = true');
    await click('result-start');
    await until(() => run('window.fixture.speaking.includes("只作开场核身")'), 'new call for mid-item hangup');
    await ask('我是青禾商贸', 'verify_merchant');
    await until(() => run('window.fixture.speaking.includes("第二项")'), 'hang up during second item');
    await delay(900);
    await click('end');
    await text('result-summary', '1 项材料已讲完，1 项材料待跟进');
    await text('completed-items', '授权链路');
    await text('followup-items', '盖章页已播部分');
    const receipt = await ui('receipt-number');
    assert.ok(receipt);
    await text('evidence-downloads', '双声道录音');
    const recorded = await run(`(async () => {
      const { id, token } = JSON.parse(sessionStorage.getItem('review-ticket'));
      const root = '/api/calls/' + id;
      const headers = { Authorization: 'Bearer ' + token };
      const report = await (await fetch(root + '/evidence', {headers})).json();
      const c = report.connections[0];
      const wav = new DataView(await (await fetch(root + '/recordings/' + c.connection, {headers})).arrayBuffer());
      let micAudible = false, agentAudible = false;
      for (let offset = 44; offset < wav.byteLength; offset += 4) {
        micAudible ||= Math.abs(wav.getInt16(offset, true)) > 100;
        agentAudible ||= Math.abs(wav.getInt16(offset + 2, true)) > 100;
        if (micAudible && agentAudible) break;
      }
      return { channels: wav.getUint16(22, true), samples: c.recording.samples, finished: c.recording.finished,
        bytes: wav.byteLength, micAudible, agentAudible, receipt: report.receipt.number, tools: c.turns.flatMap(t => t.tools.map(x => x.name)),
        hasSound: c.turns.some(t => t.replies.some(r => r.firstSoundMs != null && r.gateClosedMs != null)) };
    })()`);
    assert.equal(recorded.channels, 2);
    assert.ok(recorded.samples > 8000);
    assert.equal(recorded.finished, true);
    assert.equal(recorded.bytes, 44 + recorded.samples * 4);
    assert.equal(recorded.receipt, receipt);
    assert.equal(recorded.hasSound, true);
    assert.ok(recorded.micAudible && recorded.agentAudible);
    assert.ok(recorded.tools.includes('verify_merchant'));
    await cdp('Page.reload');
    await text('receipt-number', receipt);
    await text('followup-items', '从本项开头补讲');
    await run('(' + installTestPeer.toString() + ')()');
    await click('result-start');
    await until(
      () =>
        run('window.fixture.speaking.includes("只作开场核身") && window.fixture.diagnostics()[1]==="open"'),
      'new call opens'
    );
    await ask('你打错了');
    await text('status', '错号已结束');
    await text('receipt-status', '未生成书面回执');
    await text('followup-items', '复核联系方式');
    assert.doesNotMatch(await ui('progress'), /盖章页/);
  }
);
