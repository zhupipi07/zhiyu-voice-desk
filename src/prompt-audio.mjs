import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applicationOf, commonAnswers, pointScript } from './applications.mjs';
import { speechRisks } from './quality.mjs';

export const fixedSpeech = {
  callback:'已经登记您的回电请求，工作人员可按本案记录跟进。',
  clarify:'请确认，您希望工作人员给您回电吗？',
  declined:'已记录您的意愿，将取消本次回电待办。',
  repeatQuestion:'通话已恢复。上次还有一个问题待答复，请您再说一遍。',
  unknown:'现有资料还不能确定这个问题的答复，我先记为待核实。您可以再具体说一下吗？',
  opening:'您好，我是本次模拟通话的 AI 资审专员。请您说出测试商家的完整名称，以便核实身份。',
  spelling:'这个名称有同音的写法。请分别用一个词说明商家名称的前两个字怎么写。',
  retryIdentity:'暂时无法核实，请只说出完整测试商家名称。',
  askName:'请先报出本次测试商家名称，以便核实身份。',
  confirmed:'感谢您的确认和接听，祝您生活愉快，再见。',
  handoff:'已记录您的人工跟进请求，将由工作人员继续核实。',
  confirmTwo:'两项整改要求已说明。请问您都清楚了吗，还有哪项需要再说明？',
  confirmOther:'本次整改要求已说明。请问您都清楚了吗，还有哪项需要再说明？',
};
export const audioKey = text => createHash('sha256').update(text).digest('hex');
export function promptTexts(application, verified) {
  if (!verified) return [fixedSpeech.opening,fixedSpeech.spelling,fixedSpeech.retryIdentity,fixedSpeech.askName];
  return [...Object.values(fixedSpeech), ...application.materials.map(pointScript),
    ...Object.values({...commonAnswers,...application.answers}).map(v=>v.say)];
}
export function promptAudio(state,dir,key,read=false) {
  if (!dir || !/^[a-f0-9]{64}$/u.test(key) || state.status !== 'open') return null;
  const application = applicationOf(state), verified = state.identity === 'verified';
  const texts=promptTexts(application,verified);
  if(verified) for(const q of state.questions ?? []) if(q.hasAnswer && q.expectedAnswer)texts.push(q.expectedAnswer);
  const phrase = texts.find(text=>audioKey(text)===key);
  if (!phrase || speechRisks(phrase,verified,application).length) return null;
  const file = join(dir,key+'.wav');
  return existsSync(file) ? (read ? readFileSync(file) : key) : null;
}
