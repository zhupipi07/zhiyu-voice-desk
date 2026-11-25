import { readFileSync } from 'node:fs';
import { disposition } from './knowledge.mjs';

const defaultFile = new URL('../cases/applications.json', import.meta.url);
const clean = (s) => typeof s === 'string' && s.trim().length > 0;
const strings = (v) => Array.isArray(v) && v.length > 0 && v.every(clean);
const id = (s) => typeof s === 'string' && /^[a-zA-Z0-9_-]{1,64}$/u.test(s);

export function loadApplications(file = defaultFile) {
  const rows = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''));
  if (!Array.isArray(rows) || !rows.length) throw new Error('案卷清单为空。');
  const keys = new Set();
  for (const a of rows) {
    const valid = id(a.caseId) && !keys.has(a.caseId) && Number.isSafeInteger(a.revision) && a.revision > 0 &&
      clean(a.merchant) && strings(a.categories) && a.categories.length === 3 &&
      ['电话','京麦驳回'].includes(a.method) && a.facts &&
      ['callback','escalation','exposure'].every(k => a.facts[k] == null || typeof a.facts[k] === 'boolean') && disposition({method:a.method}, a.facts).action !== 'review' &&
      Array.isArray(a.materials) && a.materials.length > 0 &&
      a.materials.every(m => id(m.id) && clean(m.title) && clean(m.requirement) && typeof m.prefix === 'string' && strings(m.terms)) &&
      new Set(a.materials.map(m => m.id)).size === a.materials.length && a.answers && typeof a.answers === 'object' &&
      Object.entries(a.answers).every(([topic,v]) => ['page','chain','channel','result'].includes(topic) &&
        clean(v?.say) && (!v.point || a.materials.some(m => m.id === v.point))) &&
      (!a.aliases || strings(a.aliases)) && (!a.spelling || a.spelling.length === 2 &&
        a.spelling.every(v => clean(v.forms) && strings(v.words)));
    if (!valid) throw new Error('案卷字段或重复编号有误：' + a.caseId);
    keys.add(a.caseId);
  }
  return rows;
}

export const demoApplications = loadApplications();
export const legacyApplication = demoApplications.find(a => a.caseId === 'POP-DEMO-018');
export const applicationOf = s => s.application ?? legacyApplication;
export const pointScript = point => point.prefix + point.requirement;
export const opinion = a => a.materials.map(p => p.requirement).join('\n');
export const sourceLabel = a => '合成资审单 ' + a.caseId + ' / v' + a.revision;
export const commonAnswers = {
  channel: { say: '在本次模拟中，从京麦该申请的补充材料入口上传，然后重新提交审核。' },
  result: { say: '补齐后会重新审核，无法提前保证通过。' },
};

export function routeApplication(a, catalog) {
  const scenario = catalog ? catalog.scenarios.find(row =>
    row.categories.length === a.categories.length && row.categories.every((v,i) => v === a.categories[i])) :
    {method:a.method, source:{sheet:'合成案卷', caseId:a.caseId, revision:a.revision}};
  return disposition(scenario, a.facts);
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const fold = s => s.normalize('NFKC').replace(/[\s\p{P}]/gu,'');
function nameMatches(words, name) {
  const suffix = '(?:有限公司|有限责任公司)?(?:的|的负责人|没错|对|是我)?';
  const intro = '^(?:您好|你好|对|是的|没错|好的|嗯)*(?:我们是|我是|这里是|这边是|是|我代表|我们公司叫|公司名称是|公司叫)?';
  return new RegExp(intro + escapeRe(fold(name)) + suffix + '$','u').test(words);
}
export function identify(a, words, previous = '') {
  const normalized = fold(words);
  if (nameMatches(normalized,a.merchant)) return 'verified';
  const near = s => [a.merchant,...(a.aliases || [])].some(n => nameMatches(s,n) ||
    (!/不|非|没/u.test(s) && s.endsWith(n) && s.length - n.length <= 2));
  if (a.spelling) {
    const part = (p,i) => '(?:(?:第' + ['一','二'][i] + '个字|' + [...p.forms].map(escapeRe).join('|') +
      ')是|是)?(?:' + p.words.map(escapeRe).join('|') + ')的(?:' + [...p.forms].map(escapeRe).join('|') + ')';
    const re = new RegExp('^(.*?)' + a.spelling.map(part).join('') + '(?:' + escapeRe([...a.merchant].slice(2).join('')) + ')?$','u');
    const match = normalized.match(re);
    if (match && near(match[1] || fold(previous))) return 'verified';
    if (near(normalized)) return 'clarify';
  }
  return 'pending';
}
