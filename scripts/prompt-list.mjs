import { loadKnowledge,lookupFaq } from '../src/knowledge.mjs';
import { loadApplications } from '../src/applications.mjs';
import { promptTexts, audioKey } from '../src/prompt-audio.mjs';
const applications = loadApplications(process.env.REVIEW_CASES_FILE);
const texts = process.argv[2] === 'True' ? new Set([
  ...applications.flatMap(a => ['我是' + a.merchant + '。', a.spelling?.map(p => p.words[0] + '的' + p.forms[0]).join('，')]).filter(Boolean),
  '请问具体要补哪一页？','请问从哪里提交？','我都清楚了。','请继续说完。','请转人工客服。'
]) : new Set(applications.flatMap(a=>promptTexts(a,true)));
if (process.argv[2] !== 'True') {
  const k=loadKnowledge();
  for(const row of k?.faq ?? []) {const faq=lookupFaq(k,row.question);if(faq?.answer)texts.add(faq.answer);}
}
console.log(JSON.stringify([...texts].map(text => ({key:audioKey(text),text}))));
