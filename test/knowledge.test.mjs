import test from 'node:test';
import assert from 'node:assert/strict';
import { disposition, lookupFaq } from '../src/knowledge.mjs';

test('disposition distinguishes submissions from attempts and gives call exceptions priority', () => {
  const phone = { method: '电话', source: { row: 83 } };
  const written = { ...phone, method: '京麦驳回' };
  for (const [row, facts, expected] of [
    [phone, {}, 'call'], [written, {}, 'written'], [phone, { missed: 1 }, 'written'],
    [phone, { submissions: 2, missed: 1 }, 'retry'], [phone, { submissions: 2, missed: 2 }, 'written'],
    [phone, { submissions: 3 }, 'written'], [written, { callback: true }, 'callback'],
    [written, { submissions: 3, exposure: true }, 'callback'], [written, { escalation: true }, 'callback'],
    [phone, { submissions: 0 }, 'review'], [undefined, {}, 'review'],
  ]) assert.equal(disposition(row, facts).action, expected);
});
test('an unreviewed FAQ row retains its citation and never supplies a spoken answer', () => {
  const faq = { module: '模拟', question: '如何更新名称', answer: '内部待确认', source: { row: 18 } };
  const lookup = (query, rows = [faq]) => lookupFaq({ faq: rows }, query);
  assert.deepEqual(lookup('请问，怎么更新名称？'), { answer: null, citation: { row: 18, module: '模拟' } });
  assert.equal(lookup('怎么更新名称，还有收费吗？'), null);
  assert.equal(lookup('怎么更新名称', [faq, faq]), null);
});
