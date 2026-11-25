// One synthetic browser call in an isolated database. Load credentials only via the server.
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createApp, wav } from '../server.mjs';
import { startRecognizer } from '../src/local-asr.mjs';
import { openStore } from '../src/review.mjs';
import { loadApplications } from '../src/applications.mjs';
import { audioKey } from '../src/prompt-audio.mjs';
import { loadKnowledge } from '../src/knowledge.mjs';
const {values} = parseArgs({options:{case:{type:'string',default:'POP-DEMO-018'},snr:{type:'string'},'asr-delay-ms':{type:'string'},video:{type:'boolean',default:false},out:{type:'string',default:'data/probes'}}});
const applications = loadApplications(process.env.REVIEW_CASES_FILE);
const a = applications.find(row=>row.caseId === values.case);
if (!a || a.method !== '电话' || a.facts.missed) throw new Error('请选择一张直接电话办理的合成案卷。');
const question = a.answers.page ? '请问具体要补哪一页？':'请问从哪里提交？';
const name = '我是' + a.merchant + '。', spelling = a.spelling?.map(p=>p.words[0]+'的'+p.forms[0]).join('，');
const snr = values.snr == null ? null : Number(values.snr);
if (snr != null && (!Number.isFinite(snr) || snr < 0 || snr > 60)) throw new Error('SNR 范围为 0–60 dB。');
const fixtures = new Map([name,spelling,question,'我都清楚了。','请继续说完。'].filter(Boolean)
  .map(words=>[words,readFileSync(join('data/probe-inputs',audioKey(words)+'.wav')).toString('base64')]));
const offline = process.env.REVIEW_TRANSPORT === 'local';
const injectedDelayMs = Number(values['asr-delay-ms'] ?? 0);
if (!Number.isSafeInteger(injectedDelayMs) || injectedDelayMs < 0 || injectedDelayMs > 5000 || (injectedDelayMs && !offline))
  throw new Error('仅本机探针支持 0 至 5000 毫秒的受控识别延迟。');
if (!offline && (!process.env.DASHSCOPE_API_KEY || !process.env.DASHSCOPE_WORKSPACE_ID)) throw new Error('缺少百炼凭据。');
const {chromium} = await import(process.env.PROBE_PLAYWRIGHT ? pathToFileURL(resolve(process.env.PROBE_PLAYWRIGHT)).href:'playwright-core');
const executable = process.env.CHROME_BIN || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/chromium','/usr/bin/google-chrome'].find(existsSync);
const session = new Date().toISOString().replace(/[:.]/g,'-'), dir=resolve(values.out,session);mkdirSync(dir,{recursive:true});
const strictAudio = process.env.REVIEW_STRICT_AUDIO !== '0', localSpeech=process.env.REVIEW_LOCAL_SPEECH !== '0';
const batchMs=Number(process.env.REVIEW_BATCH_MS || 100);
const recognizer=offline ? startRecognizer(process.env.REVIEW_ASR_PYTHON,process.env.REVIEW_ASR_MODEL) : null;
if(recognizer)await recognizer.ready;
if (injectedDelayMs) {
  const transcribe = recognizer.transcribe.bind(recognizer);
  recognizer.transcribe = async pcm => {
    const transcript = await transcribe(pcm);
    await new Promise(resolve => setTimeout(resolve,injectedDelayMs));
    return transcript;
  };
}
const store = openStore(join(dir,'live.sqlite'),{catalog:loadKnowledge(),applications,turnMode:offline?'local_vad':process.env.REVIEW_TURN_MODE || 'server_vad_750',
  promptDir:localSpeech?resolve('data/prompts'):null});
const server = createApp({store,key:process.env.DASHSCOPE_API_KEY,workspace:process.env.DASHSCOPE_WORKSPACE_ID,transport:offline?'local':'gateway',strictAudio,batchMs,recognizer});
const browser = await chromium.launch({executablePath:executable,headless:true,args:['--mute-audio','--autoplay-policy=no-user-gesture-required']});
let phase='接通', error=null, report;
const inputs=[],frames=[];
let capturing=false,captureTask;
try {
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const page=await browser.newPage();
  await page.addInitScript(({snr,video})=>{
    if(video){const Context=window.AudioContext;window.AudioContext=class extends Context{constructor(...args){super(...args);window.probeClock??=this;}};}
    navigator.mediaDevices.getUserMedia=async()=>{
      const ctx=new AudioContext();await ctx.resume();const dest=ctx.createMediaStreamDestination();
      const osc=ctx.createOscillator(),g=ctx.createGain();g.gain.value=.00005;osc.connect(g).connect(dest);osc.start();
      let seed=1853;
      window.speakFixture=async base64=>{
        const audio=await ctx.decodeAudioData(Uint8Array.from(atob(base64),x=>x.charCodeAt(0)).buffer);
        if (snr !== null) {
          const samples=audio.getChannelData(0),rms=Math.sqrt(samples.reduce((v,x)=>v+x*x,0)/samples.length);
          const amplitude=Math.sqrt(3)*rms*10**(-snr/20);
          for (let i=0;i<samples.length;i++) {seed=(Math.imul(1664525,seed)+1013904223)>>>0;samples[i]+=amplitude*(2*seed/4294967296-1);}
        }
        const node=ctx.createBufferSource();node.buffer=audio;node.connect(dest);await new Promise(r=>{node.onended=r;node.start();});
      };
      return dest.stream;
    };
  },{snr,video:values.video});
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.selectOption('#case-select',a.caseId);
  await page.check('#record-evidence');
  if(values.video){
    await page.setViewportSize({width:1360,height:960});
    mkdirSync(join(dir,'frames'));capturing=true;
    captureTask=(async()=>{while(capturing){
      const ms=await page.evaluate(()=>window.probeClock?.currentTime*1000 || 0);
      const name='frame-'+String(frames.length).padStart(4,'0')+'.jpg';
      await page.screenshot({path:join(dir,'frames',name),type:'jpeg',quality:78});
      frames.push({ms,name});await page.waitForTimeout(350);
    }})().catch(()=>{});
  }
  await page.click('#start');
  const state=()=>page.evaluate(async()=>{const t=JSON.parse(sessionStorage.getItem('review-ticket'));return t&&await (await fetch('/api/calls/'+t.id,{headers:{Authorization:'Bearer '+t.token}})).json();});
  const wait=async(label,predicate,timeout=40000)=>{
    phase=label;const end=Date.now()+timeout;
    while(Date.now()<end) {
      const s=await state();if(s&&predicate(s))return s;
      const notice=await page.locator('#notice').textContent();if(notice) throw new Error(notice);
      await page.waitForTimeout(250);
    }
    throw new Error(label+'超时');
  };
  const speak=async words=>{inputs.push({words,key:audioKey(words)});await page.evaluate(data=>window.speakFixture(data),fixtures.get(words));};
  const spoken=s=>s.turns.filter(t=>t.speaker==='AI'&&t.audibleMs>500);
  await wait('开场',s=>spoken(s).length>0,65000);
  await speak(name);
  const s=await wait('核身',s=>s.identity==='verified'||spoken(s).length>=2);
  if(s.identity!=='verified' && spelling){await speak(spelling);await wait('组词核身',s=>s.identity==='verified');}
  if(a.materials.length>1){await wait('第一项实际播完',s=>s.points[0]?.status==='complete');await page.waitForTimeout(450);}
  else await wait('听完第一项',s=>s.points[0]?.status==='complete');
  await speak(question);
  await wait('回答追问',s=>s.tools.some(t=>t.name==='lookup_review_guidance'&&t.ok)&&
    spoken(s).some(t=>t.text.includes(a.answers.page?'按内容认页':'补充材料入口')&&!t.interrupted));
  await wait('播完确认问句',s=>spoken(s).some(t=>t.text.includes('清楚了吗')&&!t.interrupted));
  await speak('我都清楚了。');await wait('确认',s=>s.confirmation);
  await wait('结束语',s=>spoken(s).some(t=>t.text.includes('再见')&&!t.interrupted));
  phase='完成';
} catch(err) {error=err.message;}
finally {
  const page=browser.contexts()[0]?.pages()[0];
  if(page && await page.locator('#end').isEnabled().catch(()=>false)) {
    await page.click('#end');await page.waitForFunction(()=>!document.getElementById('result').hidden,{},{timeout:10000}).catch(()=>{});
  }
  if(capturing){capturing=false;await captureTask;await page.screenshot({path:join(dir,'result.jpg')});writeFileSync(join(dir,'frames.json'),JSON.stringify(frames));}
  const ticket=await page?.evaluate(()=>JSON.parse(sessionStorage.getItem('review-ticket'))).catch(()=>null);
  if(ticket) {
    report=store.report(ticket.id,ticket.token);
    writeFileSync(join(dir,report.call+'.json'),JSON.stringify(report,null,2));
    for(const c of report.connections) if(c.recording?.samples)
      writeFileSync(join(dir,report.call+'-'+c.connection+'.wav'),wav(store.recording(ticket.id,ticket.token,c.connection),2));
  }
  const outcome={session,transport:offline?'local':'gateway',listenerCue:report?.connections[0]?.listenerCue ?? null,injectedDelayMs,screenCapture:values.video,caseId:a.caseId,phase,error,inputs,snr,noise:snr===null?'clean':'合成白噪声，仅在商家输入片段混入',strictAudio,localSpeech,batchMs,turnMode:offline?'local_vad':process.env.REVIEW_TURN_MODE || 'server_vad_750',
    call:report?.call ?? null,closedLoop:report?.quality.closedLoop ?? false,longestPairedRun:report?.quality.longestPairedRun??0};
  writeFileSync(join(dir,'probe.json'),JSON.stringify(outcome,null,2));console.log(JSON.stringify(outcome));
  await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();recognizer?.close();
  // Native WebRTC worker threads on Windows can outlive the already closed peer and server.
  process.exit(error || !outcome.closedLoop ? 1 : 0);
}
