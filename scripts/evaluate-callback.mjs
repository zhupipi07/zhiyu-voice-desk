import { readFileSync } from 'node:fs';
import { callbackIntent } from '../src/contact.mjs';

const cases = JSON.parse(readFileSync(new URL('../cases/callback.json', import.meta.url)));
for (const set of ['dev', 'holdout']) {
  const rows = cases.filter((c) => c.set === set).map((c) => ({
    ...c, actual: callbackIntent(c.words, c.verified),
  }));
  const failures = rows.filter((c) => c.actual !== c.expect);
  const required = rows.filter((c) => c.expect === 'callback');
  const others = rows.filter((c) => c.expect !== 'callback');
  console.log(JSON.stringify({
    set, correct: rows.length - failures.length, total: rows.length,
    missed: required.filter((c) => c.actual !== 'callback').length, required: required.length,
    unexpected: others.filter((c) => c.actual === 'callback').length, others: others.length, failures,
  }));
  if (failures.length) process.exitCode = 1;
}
