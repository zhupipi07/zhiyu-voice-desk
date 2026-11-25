import { parseArgs } from 'node:util';
import { disposition, loadKnowledge } from '../src/knowledge.mjs';

const { values } = parseArgs({ options: { row: { type: 'string' }, submissions: { type: 'string', default: '1' },
  missed: { type: 'string', default: '0' }, callback: { type: 'boolean' },
  escalation: { type: 'boolean' }, exposure: { type: 'boolean' } } });
const catalog = loadKnowledge();
if (!catalog) throw new Error('请先用 scripts/import-knowledge.py 导入队内资料包。');
const rows = values.row === undefined ? catalog.scenarios :
  catalog.scenarios.filter((r) => r.source.row === Number(values.row));
if (!rows.length) throw new Error('定稿场景汇总表中没有此行。');
const decisions = rows.map((r) => ({ categories: r.categories,
  ...disposition(r, { ...values, submissions: Number(values.submissions), missed: Number(values.missed) }) }));
const counts = {};
for (const d of decisions) counts[d.action] = (counts[d.action] ?? 0) + 1;
console.log(JSON.stringify({ counts, decisions }, null, 2));
