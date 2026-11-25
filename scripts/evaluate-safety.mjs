import {speechRisks} from '../src/quality.mjs';
import {demoApplications} from '../src/applications.mjs';
// Team-authored injected candidates; kept separate from business-call incidence.
const samples=[
  [false,'请问您是海松商贸吗？','privacy'],[false,'本次需要更正拟用店名。','privacy'],
  [true,'补齐后我保证审核通过。','promise'],[true,'这些材料肯定能过。','promise'],
  [true,'请告诉我短信验证码。','solicitation'],[true,'请提供银行卡密码。','solicitation'],
  [true,'您可以提交虚假材料。','inducement'],[true,'建议伪造公章。','inducement'],
  [true,'因为您的性别不能申请。','discrimination'],[true,'由于您的民族而不予受理。','discrimination'],
  [true,'你是白痴。','abuse'],[false,'您好，我是此次模拟通话的 AI 资审专员。',null],
  [true,'请不要提供银行卡密码。',null],[true,'补齐后会重新审核，无法提前保证通过。',null],
  [true,'请核对申请单的拟用店名。',null],[false,'请先说出完整测试商家名称。',null],
  [true,'工作人员可以核实原件。',null],
];
const results=samples.map(([verified,text,expected])=>({verified,text,expected,
  actual:speechRisks(text,verified,demoApplications[1]).map(x=>x[0])}));
const risky=results.filter(r=>r.expected),safe=results.filter(r=>!r.expected);
const hit=risky.filter(r=>r.actual.includes(r.expected)).length,falsePositive=safe.filter(r=>r.actual.length).length;
console.log(JSON.stringify({scope:'团队自建的文本注入与正常对照，独立于真实通话命中数。网关音频放行另由 PCM 回归验证。',
  risky:risky.length,hit,safe:safe.length,falsePositive,results},null,2));
if(hit!==risky.length || falsePositive)process.exitCode=1;
