import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { VoiceCall } from '../public/realtime.mjs';

test('the mixer includes the cue in the room recording and excludes it from business playback', () => {
  const messages = [];
  let Mixer;
  const host = {currentFrame:4800, currentTime:0.1, sampleRate:48000,
    AudioWorkletProcessor:class {port={postMessage:m=>messages.push(m)};},
    registerProcessor(name, cls) {if(name==='playback-tap') Mixer=cls;}};
  runInNewContext(readFileSync(new URL('../public/capture.mjs',import.meta.url),'utf8'),host);
  const mixer = new Mixer();
  const render = (body, cue) => {
    const out = new Float32Array(128);
    mixer.process([[new Float32Array(128).fill(body)],[new Float32Array(128).fill(cue)]],[[out]]);
    return out[0];
  };
  const send = data=>mixer.port.onmessage({data});
  send({id:'tool-response'});send({cueTurn:'merchant-1'});
  assert.equal(render(0,0.25),0.25);
  assert.equal(render(0,0.25),0.25);
  mixer.flush();
  assert.equal(messages.filter(m=>m.cueTurn).length,1);
  assert.equal(messages.find(m=>m.cueTurn).atMs,100);
  assert.ok(messages.find(m=>m.samples)?.samples.every(s=>s===0));
  assert.equal(render(0.5,0.25),0.5);
  assert.equal(render(0,0.25),0);
  send({cueTurn:'too-late'});assert.equal(render(0,0.25),0);
  send({id:null});send({cueTurn:'merchant-2'});send({cueTurn:null});
  assert.equal(render(0,0.25),0);
});

test('only one cue is armed after a verified turn, and resumed speech cancels it', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const state={identity:'pending'};
  const heard=[];
  const voice=new VoiceCall({current:()=>state,event:async()=>({})});
  voice.playback.cueBuffer={};voice.playback.context={currentTime:30};
  voice.playback.playCue=id=>heard.push(id);
  const stop=id=>{voice.beginTurn(id);voice.scheduleCue(id);};
  stop('unverified');t.mock.timers.tick(250);assert.deepEqual(heard,[]);
  state.identity='verified';
  stop('resumed');t.mock.timers.tick(100);voice.beginTurn('next');t.mock.timers.tick(250);
  assert.deepEqual(heard,[]);
  voice.scheduleCue('next');voice.scheduleCue('next');t.mock.timers.tick(180);
  assert.deepEqual(heard,['next']);
  voice.lastCueMs=29500;stop('recent');t.mock.timers.tick(250);assert.deepEqual(heard,['next']);
});
