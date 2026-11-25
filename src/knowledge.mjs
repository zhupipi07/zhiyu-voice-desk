import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export function loadKnowledge(file = new URL('../data/knowledge.json', import.meta.url)) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.scenarios) || !Array.isArray(data.faq))
      throw new Error('知识库格式不符，请重新导入赛方资料包。');
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function disposition(scenario, { submissions = 1, missed = 0, callback = false,
  escalation = false, exposure = false } = {}) {
  if (!['京麦驳回', '电话'].includes(scenario?.method) || !Number.isSafeInteger(submissions) ||
      submissions < 1 || !Number.isSafeInteger(missed) || missed < 0)
    return { action: 'review', reason: '缺少有效场景或次数依据' };
  const source = scenario.source;
  if (callback || escalation || exposure) return { action: 'callback', reason: '命中强制回电条件', source };
  if (scenario.method === '京麦驳回' || submissions >= 3)
    return { action: 'written', reason: submissions >= 3 ? '同场景至少三次提交仍错' : '主表要求京麦驳回', source };
  if (!missed) return { action: 'call', reason: '主表要求电话告知', source };
  if (submissions === 2 && missed === 1) return { action: 'retry', reason: '二次提交仍错且首次未接', source };
  return { action: 'written', reason: '已依次数规则尝试联系', source };
}

// Only reviewed, merchant-facing answers apply across cases. Pin content, so an
// edited source workbook cannot silently authorize different spoken guidance.
const speakable = new Set([
  '28d1124ab60d892f8806567a9b0b0730c9f6f108906b3a1736484227acf3e9f9',
  '5519a4530b51502e73d1a1820bcd46a049df80c20490742f3677ffc176371af7',
  '23e9697ca6bdcf442779875839c1b798c087d4a221b4afdeb78bc3a00a7f368a',
  '8b324f6025793aa56d6a7048272aeba887b991c5a1cb49793b6755a82b3c914b',
  '293532e3f14048e6d8822595f664c5e5dc1df60cdb654250d380a8b2950d7396',
]);
function questionKey(text) {
  return text.normalize('NFKC').trim().replace(/^(?:您好[，,]?|你好[，,]?|请问(?:一下)?[，,]?|我想问一下[，,]?)+/u, '')
    .replace(/[？?。！!呢啊呀\s]+$/u, '').replace(/如何|怎样/gu, '怎么')
    .replace(/店铺名称/gu, '店铺名').replace(/修改/gu, '更改').replace(/\s/gu, '');
}

export function lookupFaq(catalog, words) {
  const key = questionKey(words);
  const matches = catalog?.faq.filter((row) => questionKey(row.question) === key) || [];
  if (matches.length !== 1) return null;
  const { module, question, answer, source } = matches[0];
  const hash = createHash('sha256').update([module, question, answer].join('\n')).digest('hex');
  const cite = { ...source, module };
  return speakable.has(hash) ? { answer, citation: cite } : { answer: null, citation: cite };
}
