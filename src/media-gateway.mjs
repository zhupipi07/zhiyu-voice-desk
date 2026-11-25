import { randomUUID } from 'node:crypto';
import { LocalEndpoint } from './endpoint.mjs';

// Local WebRTC peer for the competition browser. The only upstream is the
// configured Model Studio session. Both legs carry real, full-duplex audio.
export async function gatewayAnswer(offer, { key, workspace, model, signal, onClose,
  recognizer, screen, onBlocked, batchMs = 100, rtc, openSocket = (url, options) => new WebSocket(url, options) }) {
  try { rtc ??= (await import('@roamhq/wrtc')).default; }
  catch { throw Object.assign(new Error('本地媒体网关需要安装当前平台的 @roamhq/wrtc，请运行 npm ci。'), { status: 503 }); }
  signal.throwIfAborted();
  if (![60,100,200].includes(batchMs)) throw new Error('不支持的上行音频批次。');
  const pc = new rtc.RTCPeerConnection({ iceServers: [] });
  const source = new rtc.nonstandard.RTCAudioSource();
  const track = source.createTrack();
  let ws, sink, channel, timer, handshakeTimer, dialAttempts = 0, closed = false, configured = false;
  let output = Buffer.alloc(0), tailEvent, currentResponse, input = [];
  let localEndpoint, localTurn, generating=null;
  const committedTurns=[], localIds=new Map();
  let silentFrames = 0, preRoll = [], released = !screen, transcript = '';
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    clearTimeout(handshakeTimer);
    clearTimeout(expiry);
    signal.removeEventListener('abort', close);
    pc.onconnectionstatechange = pc.ondatachannel = pc.ontrack = null;
    if (channel) {
      channel.onopen = channel.onclose = channel.onmessage = null;
      channel.close();
    }
    if (sink) { sink.ondata = null; sink.stop(); }
    for (const receiver of pc.getReceivers()) receiver.track?.stop();
    track.stop();
    pc.close();
    ws?.close();
    onClose?.();
  };
  let expiry = setTimeout(close, 25000);
  signal.addEventListener('abort', close, { once: true });
  const forward = (e) => {
    if (channel?.readyState === 'open') channel.send(JSON.stringify(e));
  };
  const sendUp = (e) => {
    if (ws?.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 512000) return close();
    ws.send(JSON.stringify(e));
  };
  function flushInput() {
    if(input.length)sendUp({type:'input_audio_buffer.append',audio:Buffer.concat(input).toString('base64')});
    input=[];
  }
  function manualEndpoint() {
    return new LocalEndpoint({
      start() {
        localTurn='local-turn-'+randomUUID();
        if(generating)sendUp({type:'response.cancel'});
        receive({type:'input_audio_buffer.speech_started',item_id:localTurn});
      },
      audio(frame) {input.push(frame);if(input.length>=batchMs/10)flushInput();},
      stop() {
        flushInput();
        committedTurns.push(localTurn);
        forward({type:'input_audio_buffer.speech_stopped',item_id:localTurn});
        sendUp({type:'input_audio_buffer.commit'});
        sendUp({type:'response.create'});
      },
    });
  }
  function play() {
    const samples = new Int16Array(240);
    const size = released ? Math.min(480, output.length) : 0;
    if (size) {
      output.copy(Buffer.from(samples.buffer), 0, 0, size);
      output = output.subarray(size);
    }
    source.onData({ samples, sampleRate: 24000, bitsPerSample: 16, channelCount: 1, numberOfFrames: 240 });
    if (!output.length && tailEvent) { forward(tailEvent); tailEvent = null; }
  }
  function receive(e) {
    if (localEndpoint) {
      if(e.type==='input_audio_buffer.committed' && e.item_id && committedTurns.length)
        localIds.set(e.item_id,committedTurns.shift());
      if(e.item_id && localIds.has(e.item_id))e={...e,item_id:localIds.get(e.item_id)};
    }
    if(e.type==='response.created')generating=e.response.id;
    if(e.type==='response.done' && e.response.id===generating)generating=null;
    if (e.type === 'response.audio.delta') {
      if (e.response_id !== currentResponse) return;
      const pcm = Buffer.from(e.delta, 'base64');
      if (pcm.length % 2 || output.length + pcm.length > 24000 * 2 * 45) return close();
      output = Buffer.concat([output, pcm]);
      return;
    }
    if (e.type === 'input_audio_buffer.speech_started' || e.type === 'response.created') {
      output = Buffer.alloc(0);
      if (tailEvent) { forward(tailEvent); tailEvent = null; }
      released = !screen;
      transcript = '';
      currentResponse = e.type === 'response.created' ? e.response.id : null;
    }
    if (screen && e.type === 'response.audio_transcript.done' && e.response_id === currentResponse) transcript = e.transcript || '';
    if (screen && e.type === 'response.done' && e.response.id === currentResponse && output.length) {
      if (e.response.status !== 'completed') output = Buffer.alloc(0);
      else {
        const spoken = (e.response.output || []).flatMap(item => item.content || []).map(c => c.transcript || '').join('') || transcript;
        const reason = screen(spoken);
        if (reason) {
          output = Buffer.alloc(0);
          onBlocked?.(currentResponse,spoken,reason);
          forward({type:'review.output_blocked',reason});
        } else released = true;
      }
    }
    if (e.type === 'response.done' && output.length && e.response.id === currentResponse &&
        e.response.status === 'completed') { tailEvent = e; return; }
    if (e.type === 'session.created' || e.type === 'session.updated') clearTimeout(handshakeTimer);
    if (e.type === 'session.updated') configured = true;
    forward(e);
  }
  function startLocal() {
    if (localEndpoint || closed) return;
    clearTimeout(expiry);
    expiry=setTimeout(close,15*60*1000);
    let utterance,frames=[];
    localEndpoint=new LocalEndpoint({
      start(){utterance='local-turn-'+randomUUID();frames=[];forward({type:'input_audio_buffer.speech_started',item_id:utterance});},
      audio(frame){frames.push(frame);},
      stop(){
        const item_id=utterance, pcm=Buffer.concat(frames);frames=[];
        forward({type:'input_audio_buffer.speech_stopped',item_id});
        forward({type:'input_audio_buffer.committed',item_id});
        recognizer.transcribe(pcm).then(transcript=>{
          if(!closed && item_id===utterance)forward({type:'review.local_transcript',item_id,transcript});
        }).catch(()=>{if(!closed)forward({type:'error',error:{message:'本地识别进程未完成本轮转写。'}});});
      }
    });
    timer=setInterval(play,10);
    forward({type:'session.created'});
  }
  function startCloud() {
    if (ws || closed) return;
    clearTimeout(expiry);
    expiry = setTimeout(close, 15 * 60 * 1000);
    ws = openSocket('wss://' + workspace + '.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=' + model,
      { headers: { Authorization: 'Bearer ' + key } });
    const socket = ws;
    dialAttempts++;
    let created = false;
    function lost() {
      if (closed || ws !== socket) return;
      clearTimeout(handshakeTimer);
      if (created || configured || dialAttempts >= 2) return close();
      ws = null;
      socket.onclose = socket.onerror = socket.onmessage = null;
      socket.close();
      forward({type:'review.gateway_retry'});
      startCloud();
    }
    ws.onmessage = ({ data }) => {
      try {
        const event = JSON.parse(data);
        if (event.type === 'session.created') created = true;
        receive(event);
      } catch { close(); }
    };
    ws.onclose = ws.onerror = lost;
    handshakeTimer = setTimeout(lost,8000);
    timer ??= setInterval(play, 10);
  }
  pc.ondatachannel = ({ channel: c }) => {
    if (c.label !== 'oai-events' || channel) return c.close();
    channel = c;
    const start=recognizer ? startLocal : startCloud;
    c.onopen = start;
    c.onclose = close;
    c.onmessage = ({ data }) => {
      try {
        const msg = JSON.parse(data);
        if(recognizer){
          if(msg.type==='session.update'){configured=true;forward({type:'session.updated'});}
          return;
        }
        if (msg.type === 'session.update' && msg.session.turn_detection === null && !configured) localEndpoint ??= manualEndpoint();
        if (['session.update', 'conversation.item.create', 'response.create', 'response.cancel'].includes(msg.type)) sendUp(msg);
      } catch { close(); }
    };
    if (c.readyState === 'open') start();
  };
  pc.onconnectionstatechange = () => {
    if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) close();
  };
  pc.ontrack = ({ track: remote }) => {
    if (remote.kind !== 'audio') return;
    sink?.stop();
    sink = new rtc.nonstandard.RTCAudioSink(remote);
    sink.ondata = ({ samples, numberOfFrames, channelCount }) => {
      if (!configured || closed) return;
      // The sink delivers 10 ms frames. Average input channels and samples in
      // each output bin to send mono PCM16 at the provider's required 16 kHz.
      const pcm = Buffer.alloc(320);
      for (let i = 0; i < 160; i++) {
        const lo = Math.floor(i * numberOfFrames / 160) * channelCount;
        const hi = Math.max(lo + channelCount, Math.floor((i + 1) * numberOfFrames / 160) * channelCount);
        let sum = 0;
        for (let j = lo; j < hi; j++) sum += samples[j];
        pcm.writeInt16LE(Math.round(sum / (hi - lo)), i * 2);
      }
      if (localEndpoint) {localEndpoint.push(pcm);return;}
      // Suppress sustained digital silence (including synthetic microphone
      // dither). Keep two seconds for endpointing and 200 ms before speech.
      if (samples.some((v) => Math.abs(v) >= 8)) silentFrames = 0;
      else silentFrames++;
      if (silentFrames > 200) {
        preRoll.push(pcm);
        if (preRoll.length > 20) preRoll.shift();
        return;
      }
      if (preRoll.length) { input.push(...preRoll); preRoll = []; }
      input.push(pcm);
      if (input.length >= batchMs / 10) {
        flushInput();
      }
    };
  };
  try {
    pc.addTrack(track);
    await pc.setRemoteDescription({ type: 'offer', sdp: offer });
    await pc.setLocalDescription(await pc.createAnswer());
    const start = Date.now();
    while (!closed && pc.iceGatheringState !== 'complete' && Date.now() - start < 5000)
      await new Promise((r) => setTimeout(r, 20));
    if (closed || pc.iceGatheringState !== 'complete') throw new Error('本地媒体协商超时');
    return pc.localDescription.sdp;
  } catch (error) { close(); throw error; }
}
