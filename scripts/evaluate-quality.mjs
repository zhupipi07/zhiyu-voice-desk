import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { openStore } from '../src/review.mjs';
import { wav } from '../server.mjs';
import { evaluateLatency } from './evaluate-latency.mjs';
import { dashboard } from './quality-dashboard.mjs';

const { values } = parseArgs({ options: { db: { type: 'string', default: 'data/review.sqlite' },
  out: { type: 'string' }, audio: { type: 'boolean', default: false } } });
if (values.audio && !values.out) throw new Error('导出录音需要 --out 目录。');
const dir = values.out && resolve(values.out);
if (dir) mkdirSync(dir, { recursive: true });
const store = openStore(values.db, { readOnly: true });
const calls = [];
const acousticPairs = [];
const exported = [];
function save(filename, content) {
  const path = join(dir, filename);
  try { writeFileSync(path, content, { flag: 'wx' }); }
  catch (err) {
    if (err.code !== 'EEXIST') throw err;
    if (!readFileSync(path).equals(Buffer.from(content))) throw new Error('导出目录已有不同内容，请另选目录：' + filename);
  }
}
try {
  for (const report of store.reports()) {
    const q = report.quality;
    const latency = evaluateLatency([report]).overall;
    for (const c of report.connections) for (const t of c.turns) {
      const first = t.replies.find((r) => r.text?.trim() && Number.isFinite(r.firstSoundMs));
      if (!Number.isFinite(t.micEndCandidateMs) || !first || !c.recording) continue;
      const diff = first.firstSoundMs - t.micEndCandidateMs;
      if (diff < 0 || first.firstSoundMs > c.recording.originMs + c.recording.samples / 8) continue;
      acousticPairs.push({ call: report.call, connection: c.connection, turn: t.turn,
        candidateEndMs: t.micEndCandidateMs, firstSoundMs: first.firstSoundMs, gapMs: Math.round(diff) });
    }
    calls.push({ call: report.call, status: q.status, recorded: report.connections.some((c) => c.recording?.samples),
      identity: q.identity, longestPairedRun: q.longestPairedRun, closedLoop: q.closedLoop, receipt: report.receipt?.number ?? null,
      riskHits: q.riskHits, needsReview: q.findings.filter((f) => f.status === 'review' || f.status === 'missing').length,
      ...latency });
    if (!dir) continue;
    exported.push(report);
    save(report.call + '.json', JSON.stringify(report, null, 2));
    if (values.audio) for (const c of report.connections) {
      if (c.recording?.samples) save(report.call + '-' + c.connection + '.wav', wav(store.stereo(report.call, c.connection), 2));
    }
  }
} finally { store.close(); }
const gaps = acousticPairs.map((r) => r.gapMs).sort((a, b) => a - b);
const summary = { calls: calls.length, recorded: calls.filter((c) => c.recorded).length,
  closedLoops: calls.filter((c) => c.closedLoop).length, details: calls,
  acousticProxy: { definition: '商家有效音量候选终点至坐席首个有声帧，仅供排查时延。',
    pairs: acousticPairs, p50Ms: gaps[Math.ceil(gaps.length * .5) - 1] ?? null,
    p95Ms: gaps[Math.ceil(gaps.length * .95) - 1] ?? null } };
if (dir) save('index.html', dashboard(summary, exported, values.audio));
console.log(JSON.stringify(summary, null, 2));
