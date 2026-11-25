import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { gatewayAnswer } from '../src/media-gateway.mjs';

test('gateway forwards real PCM formats, clears interrupted output and stops both legs on abort', async (t) => {
  let pc, sink, source, cloudClosed = false, peerClosed = false;
  const upstream = [], downstream = [], played = [];
  const track = { stop() {} };
  const rtc = {
    RTCPeerConnection: class {
      constructor() { pc = this; this.iceGatheringState = 'complete'; }
      addTrack() {}
      setRemoteDescription() {}
      createAnswer() { return { sdp: 'answer' }; }
      setLocalDescription(answer) { this.localDescription = answer; }
      getReceivers() { return [{ track }]; }
      close() { peerClosed = true; }
    },
    nonstandard: {
      RTCAudioSource: class {
        constructor() { source = this; }
        createTrack() { return track; }
        onData({ samples, sampleRate }) { played.push({ sample: samples[0], rate: sampleRate }); }
      },
      RTCAudioSink: class {
        constructor() { sink = this; }
        stop() {}
      },
    },
  };
  const ctrl = new AbortController();
  t.after(() => ctrl.abort());
  const ws = { readyState: WebSocket.OPEN, bufferedAmount: 0, send: (raw) => upstream.push(JSON.parse(raw)),
    close() { cloudClosed = true; } };
  const answer = await gatewayAnswer('offer', { key: 'test', workspace: 'test', model: 'model',
    signal: ctrl.signal, rtc, openSocket: () => ws });
  assert.equal(answer, 'answer');
  pc.ondatachannel({ channel: { label: 'oai-events', readyState: 'open', send: (raw) => downstream.push(JSON.parse(raw)),
    close() {} } });
  pc.ontrack({ track: { kind: 'audio' } });
  const cloud = (e) => ws.onmessage({ data: JSON.stringify(e) });
  const frame = { numberOfFrames: 480, channelCount: 2, samples: new Int16Array(960).fill(1200) };
  sink.ondata(frame);
  assert.deepEqual(upstream, []);
  cloud({ type: 'session.updated' });
  for (let i = 0; i < 20; i++) sink.ondata(frame);
  const input = Buffer.from(upstream[0].audio, 'base64');
  assert.equal(input.length, 10 * 160 * 2);
  assert.equal(upstream.length,2);
  assert.equal(input.readInt16LE(0), 1200);
  const audio = Buffer.alloc(9600);
  audio.fill(Buffer.from([0xb0, 0x04]));
  cloud({ type: 'response.created', response: { id: 'r' } });
  cloud({ type: 'response.audio.delta', response_id: 'r', delta: audio.toString('base64') });
  await delay(35);
  assert.ok(played.some((p) => p.rate === 24000 && p.sample === 1200));
  cloud({ type: 'input_audio_buffer.speech_started' });
  cloud({ type: 'response.audio.delta', response_id: 'r', delta: audio.toString('base64') });
  const cut = played.length;
  await delay(35);
  assert.ok(played.length > cut && played.slice(cut).every((p) => p.sample === 0));
  assert.ok(downstream.some((e) => e.type === 'session.updated'));
  ctrl.abort();
  assert.ok(source && peerClosed && cloudClosed);

  // Screened output stays silent until the complete transcript is approved.
  const blocked = [], gateCtrl = new AbortController();
  t.after(()=>gateCtrl.abort());
  await gatewayAnswer('offer',{key:'test',workspace:'test',model:'test',signal:gateCtrl.signal,rtc,
    openSocket:()=>ws,screen:text => text === '安全话术' ? '' : '承诺审核结果',
    onBlocked:(...event)=>blocked.push(event)});
  pc.ondatachannel({channel:{label:'oai-events',readyState:'open',send:raw=>downstream.push(JSON.parse(raw)),close(){}}});
  const begin=id=>{cloud({type:'response.created',response:{id}});cloud({type:'response.audio.delta',response_id:id,delta:audio.toString('base64')});};
  const finish=(id,text)=>cloud({type:'response.done',response:{id,status:'completed',output:[{content:[{transcript:text}]}]}});
  let offset=played.length;
  begin('unsafe');await delay(35);finish('unsafe','保证通过');await delay(35);
  assert.ok(played.length>offset && played.slice(offset).every(p=>p.sample===0));
  assert.equal(blocked[0][0],'unsafe');
  assert.ok(downstream.some(e=>e.type==='review.output_blocked'));
  begin('safe');offset=played.length;await delay(35);
  assert.ok(played.slice(offset).every(p=>p.sample===0));
  finish('safe','安全话术');await delay(35);
  assert.ok(played.slice(offset).some(p=>p.sample===1200));
});
