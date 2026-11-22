import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function outcomes(rows) {
  const measured = rows.filter((r) => r.status === 'measured').map((r) => r.firstWordLatencyMs)
    .sort((a, b) => a - b);
  const percentile = (p) => measured[Math.ceil(measured.length * p) - 1] ?? null;
  return { turns: rows.length, measured: measured.length,
    overlap: rows.filter((r) => r.status === 'overlap').length,
    unpaired: rows.filter((r) => r.status === 'unpaired').length,
    withoutTimedReply: rows.filter((r) => !r.hasTimedReply).length,
    p50Ms: percentile(0.50), p95Ms: percentile(0.95) };
}

export function evaluateLatency(reports) {
  const calls = new Set(), rows = [];
  let openingReplies = 0;
  for (const report of reports) {
    if (!report?.call || !Array.isArray(report.connections)) throw new Error('需要测试台导出的逐轮质检 JSON。');
    if (calls.has(report.call)) throw new Error('重复的通话文件：' + report.call);
    calls.add(report.call);
    for (const conn of report.connections) {
      openingReplies += conn.opening.length;
      for (const turn of conn.turns) {
        const end = turn.confirmedSpeechEndMs, first = turn.firstIntelligibleMs;
        for (const time of [end, first]) {
          if (time == null) continue;
          const rec = conn.recording;
          if (!Number.isFinite(time) || !Number.isFinite(rec?.originMs) ||
              !Number.isSafeInteger(rec.samples) || rec.samples <= 0 ||
              time < rec.originMs || time > rec.originMs + rec.samples / 8)
            throw new Error(`标注超出本次连接的 8 kHz 录音范围：${report.call} / ${conn.connection} / ${turn.turn}`);
        }
        const latency = end == null || first == null ? null : first - end;
        rows.push({ call: report.call, connection: conn.connection, turn: turn.turn,
          withTool: turn.tools.length > 0, hasTimedReply: turn.replies.some((r) => Number.isFinite(r.firstSoundMs)),
          status: latency == null ? 'unpaired' : latency < 0 ? 'overlap' : 'measured',
          confirmedSpeechEndMs: end ?? null, firstIntelligibleMs: first ?? null, firstWordLatencyMs: latency });
      }
    }
  }
  return { calls: calls.size, openingReplies, overall: outcomes(rows),
    withTool: outcomes(rows.filter((r) => r.withTool)), withoutTool: outcomes(rows.filter((r) => !r.withTool)), rows };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const paths = process.argv.slice(2);
    if (!paths.length) throw new Error('用法：npm run eval:latency -- 已标注的通话.json [另一通.json ...]');
    const reports = paths.map((file) => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')));
    console.log(JSON.stringify(evaluateLatency(reports), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
