import { readFileSync } from 'node:fs';
import { guidanceTopic, guidanceVersions } from '../src/guidance.mjs';
const load = file => JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/u,''));
const historical = {call:'1b596e6c-5fd1-4965-8026-7c50bb47a26d',text:'要补哪一页？',proposed:'chain',expect:'page'};
if (process.argv[2]) {
  const report = load(process.argv[2]);
  const turn = report.connections.flatMap(c=>c.turns).find(t=>t.transcript?.replace(/\s/gu,'') === historical.text);
  const tool = turn?.tools.find(t=>t.name === 'lookup_review_guidance');
  if (report.call !== historical.call || tool?.requestedTopic !== historical.proposed) throw new Error('原始错答案例与引用不一致。');
}
const stems = [['要补哪一页','chain','page'],['从哪里上传','result','channel'],
  ['补齐后一定能过吗','page','result'],['谁给谁的授权书','page','chain'],['发票要补哪一页','page',null],
  ['补哪页，传到哪里','page',null],['怎么交保证金','chain',null]];
const dev = stems.flatMap(([question,proposed,expect])=>['','请问','想咨询一下，','我想请教一下，'].map(prefix =>
  ({text:prefix + question + '？',proposed,expect})));
function score(rows,version) {
  const errors = [];
  let citedAnswers = 0, correctAnswers = 0, unsafeAnswers = 0;
  for (const row of rows) {
    const actual = version === 'proposal' ? row.proposed : guidanceTopic(row.text,row.proposed,version);
    if (actual) {citedAnswers++; if (actual === row.expect) correctAnswers++; else unsafeAnswers++;}
    if (actual !== row.expect) errors.push({...row,actual,cause:actual === null ? '有依据但未识别' : '答非所问或依据不适用'});
  }
  return {version,total:rows.length,correct:rows.length-errors.length,citedAnswers,correctAnswers,unsafeAnswers,errors};
}
const trials = guidanceVersions.map(v=>score(dev,v));
const selected = [...trials].sort((a,b)=>a.unsafeAnswers-b.unsafeAnswers || b.correct-a.correct)[0].version;
const holdout = load(new URL('../cases/guidance-holdout.json',import.meta.url));
const before = score(holdout,'grounded-v1'), after = score(holdout,selected);
const regressions = holdout.filter(r=>guidanceTopic(r.text,r.proposed,'grounded-v1')===r.expect &&
  guidanceTopic(r.text,r.proposed,selected)!==r.expect);
const accept = after.correct > before.correct && after.unsafeAnswers <= before.unsafeAnswers && !regressions.length;
console.log(JSON.stringify({version:1,task:'已有案卷的材料追问',scope:'团队自建转写。依据正确指主题与案卷匹配；不测真人 ASR 或实际播完。',
  historical:{...historical,baseline:historical.proposed,selected:guidanceTopic(historical.text,historical.proposed,selected)},
  development:trials,selected,holdout:{proposal:score(holdout,'proposal'),before,after,regressions},
  decision:accept?'通过离线回归':'暂缓',rollback:'grounded-v1'},null,2));
if (!accept) process.exitCode=1;
