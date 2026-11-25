import { readFileSync } from 'node:fs';
import { callbackIntent, callbackPolicies, callbackVersion } from '../src/contact.mjs';

const load = (name) => JSON.parse(readFileSync(new URL('../cases/' + name, import.meta.url), 'utf8'));
const original = load('callback.json');
const generated = [];
function expand(starts, ends, expect) {
  for (const start of starts) for (const end of ends) {
    for (const verified of [false, true])
      generated.push({ words: start + end + '。', expect: verified ? expect : 'none', verified });
  }
}
expand(['请给我', '烦请给我', '麻烦您给我'], ['打个电话', '回电', '致电'], 'callback');
expand(['我不希望你们', '我不想你'], ['再给我打电话', '给我回电'], 'declined');
expand(['你是说', '是不是'], ['需要给我回电吗', '希望给我打电话吗'], 'clarify');
expand(['请问', '我想知道'], ['联系电话填在哪里', '这份材料是否有效'], 'none');

function score(rows, version) {
  const failures = [], causes = {};
  for (const row of rows) {
    const actual = callbackIntent(row.words, row.verified, version);
    if (actual === row.expect) continue;
    const cause = actual === 'callback' ? '误触发回电' : row.expect === 'callback' ? '漏掉回电' : '意愿状态判错';
    causes[cause] = (causes[cause] || 0) + 1;
    failures.push({ words: row.words, verified: row.verified, expected: row.expect, actual, cause });
  }
  return { version, total: rows.length, correct: rows.length - failures.length, causes, failures };
}
const baseline = 'callback-v1';
const development = [...original.filter((c) => c.set === 'dev'), ...generated];
// Fit on development only. Rank false callbacks first, then overall correctness;
// prefer fewer changes on ties (the baseline is enumerated first).
const trials = Object.keys(callbackPolicies).map((version) => score(development, version));
const selected = [...trials].sort((a, b) =>
  (a.causes['误触发回电'] || 0) - (b.causes['误触发回电'] || 0) || b.correct - a.correct)[0];
const holdout = [...original.filter((c) => c.set === 'holdout'), ...load('callback-transfer.json')];
const before = score(holdout, baseline), after = score(holdout, selected.version);
const regressions = holdout.filter((row) => callbackIntent(row.words, row.verified, baseline) === row.expect &&
  callbackIntent(row.words, row.verified, selected.version) !== row.expect);
const accept = selected.correct > trials[0].correct && after.correct > before.correct && !regressions.length &&
  !after.causes['误触发回电'];
console.log(JSON.stringify({ task: '核身后的本地回电待办意图', generated: generated.length,
  development: trials, selected: selected.version, heldOut: { before, after, regressions },
  decision: accept ? '通过离线回归' : '暂缓', configuredVersion: callbackVersion,
  rollbackVersion: baseline }, null, 2));
if (!accept || selected.version !== callbackVersion) process.exitCode = 1;
