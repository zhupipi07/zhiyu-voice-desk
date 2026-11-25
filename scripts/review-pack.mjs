import { readFileSync,writeFileSync,copyFileSync,mkdirSync,existsSync,constants } from 'node:fs';
import { resolve,join,dirname,basename } from 'node:path';
import { parseArgs } from 'node:util';
import { markAcousticCandidates } from '../src/evidence.mjs';
import { evaluateLatency } from './evaluate-latency.mjs';
import { dashboard } from './quality-dashboard.mjs';

const {values,positionals} = parseArgs({allowPositionals:true, options:{out:{type:'string'}}});
if (!values.out || !positionals.length) throw new Error('用法：node scripts/review-pack.mjs --out 新目录 通话A.json 通话B.json');
const dir=resolve(values.out);
const read=p=>JSON.parse(readFileSync(p,'utf8').replace(/^\uFEFF/u,''));
const sources=positionals.map(file=>({file,report:read(file)}));
const reports=sources.map(s=>s.report);
const latency=evaluateLatency(reports);
const pairs=[], details=[];
function stats(numbers) {
  const sorted=[...numbers].sort((a,b)=>a-b);
  return {n:sorted.length,p50Ms:sorted[Math.ceil(.5*sorted.length)-1]??null,p95Ms:sorted[Math.ceil(.95*sorted.length)-1]??null};
}
const assets=[], reference=[];
const referenceMeta=new Map();
for(const {file,report:r} of sources) {
  if (!/^[a-f0-9-]{36}$/u.test(r.call)) throw new Error('无效通话编号');
  const q=r.quality, stages={endpoint:[],toolAfterEndpoint:[],soundAfterTool:[]};
  const usage={reportedResponses:0,inputTokens:0,outputTokens:0};
  let localReplies=0,cloudReplies=0;
  const configs=[];
  for(const c of r.connections) {
    if(!/^[a-f0-9-]{36}$/u.test(c.connection))throw new Error('无效连接编号');
    configs.push({transport:c.transport,vad:c.turnDetection,batchMs:c.batchMs??null,strictAudio:c.strictAudio??null});
    if(c.recording?.samples){
      const name=r.call+'-'+c.connection+'.wav';
      let path=join(dirname(file),name);
      if(!existsSync(path)&&r.connections.filter(x=>x.recording?.samples).length===1)path=join(dirname(file),'call.wav');
      const data=readFileSync(path);
      if(data.toString('ascii',0,4)!=='RIFF'||data.readUInt16LE(22)!==2||data.readUInt32LE(24)!==8000||
          data.length!==44+c.recording.samples*4)throw new Error('质检 WAV 与该连接不符：'+name);
      markAcousticCandidates(c,data.subarray(44));
      assets.push({path,name});
    }
    for(const u of c.usage || []){usage.reportedResponses++;usage.inputTokens+=u.inputTokens;usage.outputTokens+=u.outputTokens;}
    for(const a of [...c.opening,...c.turns.flatMap(t=>t.replies)].filter(a=>a.audibleMs>0))
      if(a.audioSource==='approved_local')localReplies++;else cloudReplies++;
    for(const t of c.turns) {
      const first=t.replies.find(a=>a.text?.trim()&&Number.isFinite(a.firstSoundMs))?.firstSoundMs;
      const end=t.micEndCandidateMs, endpoint=t.markersMs.speech_stopped??t.markersMs.committed;
      const tool=t.tools.find(e=>Number.isFinite(e.atMs))?.atMs;
      const delta=(start,stop)=>Number.isFinite(start)&&Number.isFinite(stop)&&stop>=start?Math.round(stop-start):null;
      const gap=delta(end,first);
      if(gap!=null)pairs.push({call:r.call,turn:t.turn,connection:c.connection,gapMs:gap});
      for(const [name,x,y] of [['endpoint',end,endpoint],['toolAfterEndpoint',endpoint,tool],['soundAfterTool',tool,first]]) {
        const ms=delta(x,y);if(ms!=null)stages[name].push(ms);
      }
    }
  }
  const refFile=join(dirname(file),'reference-latency.json');
  if(existsSync(refFile)){
    const result=read(refFile);
    if(result.call!==r.call)throw new Error('参考语音与案卷不匹配');
    const valid=result.rows.map(x=>x.gapMs).filter(Number.isFinite);
    reference.push(...valid);
    referenceMeta.set(r.call,{total:result.rows.length,...stats(valid)});
    assets.push({path:refFile,name:r.call+'-reference.json'});
  }
  let probe=null;
  const meta=join(dirname(file),'probe.json');
  if(existsSync(meta)){const m=read(meta);if(m.call===r.call)probe=m;}
  details.push({call:r.call,caseId:r.caseId,configs,probe,closedLoop:q.closedLoop,identity:q.identity,
    reference:referenceMeta.get(r.call)??null,longestPairedRun:q.longestPairedRun,recorded:r.connections.some(c=>c.recording?.samples),localReplies,cloudReplies,
    riskHits:q.riskHits,blocked:q.blocked??0,opening:q.findings.find(f=>f.rule==='opening')?.status??null,
    ...evaluateLatency([r]).overall,usage:usage.reportedResponses?usage:null,
    stages:Object.fromEntries(Object.entries(stages).map(([k,v])=>[k,stats(v)]))});
}
const summary={calls:reports.length,recorded:details.filter(c=>c.recorded).length,closedLoops:details.filter(c=>c.closedLoop).length,
  comparable:false,note:'开发试验包含不同版本、断句与网络状态。逐通列出，汇总次数仅描述样本组成。用量按有供应商回报的回复累计。',
  reference:{...stats(reference),total:[...referenceMeta.values()].reduce((n,v)=>n+v.total,0)},
  measured:latency.overall,details,acousticProxy:{pairs,...stats(pairs.map(p=>p.gapMs))}};
mkdirSync(dir,{recursive:false});
for(const {name,path} of assets)copyFileSync(path,join(dir,name),constants.COPYFILE_EXCL);
for(const {report} of sources)writeFileSync(join(dir,report.call+'.json'),JSON.stringify(report,null,2),{flag:'wx'});
writeFileSync(join(dir,'summary.json'),JSON.stringify(summary,null,2));
writeFileSync(join(dir,'index.html'),dashboard(summary,reports,true));
console.log(JSON.stringify({dir:basename(dir),calls:summary.calls,recorded:summary.recorded,closedLoops:summary.closedLoops}));
