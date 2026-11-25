import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

export function startRecognizer(python,model) {
  if(!python || !model) throw new Error('本地识别需要 REVIEW_ASR_PYTHON 和 REVIEW_ASR_MODEL。');
  const worker=spawn(python,['-u',fileURLToPath(new URL('../scripts/local-asr.py',import.meta.url)),model],{
    stdio:['pipe','pipe','inherit'],windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8',HF_HUB_OFFLINE:'1'}});
  const ready=Promise.withResolvers(),pending=new Map();
  let stopped=false;
  function fail(message) {
    stopped=true;
    const error=new Error(message);
    ready.reject(error);
    for(const p of pending.values()){clearTimeout(p.timer);p.reject(error);}
    pending.clear();
  }
  const startup=setTimeout(()=>{fail('本地识别模型加载超时。');worker.kill();},90000);
  worker.once('error',()=>{clearTimeout(startup);fail('无法启动本地语音识别 Python。');});
  worker.once('exit',()=>{clearTimeout(startup);fail('本地语音识别进程已退出。');});
  worker.stdin.on('error',()=>fail('本地识别输入通道已关闭。'));
  createInterface({input:worker.stdout}).on('line',line=>{
    let m;try{m=JSON.parse(line);}catch{return;}
    if(m.ready){clearTimeout(startup);ready.resolve();return;}
    const p=pending.get(m.id);if(!p)return;
    clearTimeout(p.timer);pending.delete(m.id);
    if(m.error)p.reject(new Error('本地识别失败：'+m.error));else p.resolve(m.text);
  });
  return {ready:ready.promise,async transcribe(pcm){
    await ready.promise;
    if(stopped || pending.size>=3)throw new Error('本地识别暂时不可用。');
    const id=randomUUID(),p=Promise.withResolvers();
    p.timer=setTimeout(()=>{pending.delete(id);p.reject(new Error('本地识别超时。'));},8000);
    pending.set(id,p);worker.stdin.write(JSON.stringify({id,pcm:pcm.toString('base64')})+'\n');
    return p.promise;
  },close(){worker.kill();}};
}
