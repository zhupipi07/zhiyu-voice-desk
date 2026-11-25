const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const seconds = (ms) => ms == null ? '待标注' : (ms / 1000).toFixed(2) + ' 秒';

export function dashboard(summary, reports, audio) {
  function connection(report, conn) {
    const rec = conn.recording;
    const recorded = audio && rec?.samples;
    function line(who, words, time, note) {
      const pos = Number.isFinite(time) && rec ? (time - rec.originMs) / 1000 : null;
      const seek = recorded && pos != null && pos >= 0 && pos <= rec.samples / 8000
        ? '<button data-seek="' + pos.toFixed(2) + '">' + pos.toFixed(1) + ' 秒</button>' : '';
      return '<tr><td>' + who + '</td><td>' + escape(words) + '</td><td>' + escape(note) + '</td><td>' + seek + '</td></tr>';
    }
    const reply = (r) => line('坐席', r.text || '有声片段', r.firstSoundMs, r.interrupted ? '播出被打断，转写可能超出实际播出' : '播放回录');
    const rows = conn.opening.filter((r) => r.text || r.audibleMs).map(reply);
    for (const t of conn.turns) {
      rows.push(line('商家', t.transcript || '缺少转写', t.micStartCandidateMs ?? t.markersMs.speech_started, '语音转写'));
      for (const tool of t.tools) rows.push(line('工具', tool.name, tool.atMs,
        [tool.result?.ok ? '成功' : '待核实', tool.result?.source, tool.result?.topic].filter(Boolean).join(' · ')));
      rows.push(...t.replies.filter((r) => r.text || r.audibleMs).map(reply));
    }
    return '<section>' + (recorded ? '<audio controls preload="none" src="' +
      encodeURIComponent(report.call + '-' + conn.connection + '.wav') + '"></audio>' : '') +
      (rows.length ? '<table><thead><tr><th>来源</th><th>转写或调用</th><th>依据</th><th>回听</th></tr></thead><tbody>' +
        rows.join('') + '</tbody></table>' : '<p>此连接没有取得对话记录。</p>') + '</section>';
  }
  const cards = reports.map((r) => {
    const q = r.quality, count = q.findings.filter((f) => f.status === 'review' || f.status === 'missing').length;
    return '<details><summary>通话 ' + escape(r.call.slice(0, 8)) + '　·　' + (q.closedLoop ? '已确认办理闭环' :
      q.hasReceipt ? '有模拟回执，闭环待核对' : '未完成闭环') + '</summary><p>同连接连续完整配对 ' +
      q.longestPairedRun + ' 轮　·　规则命中 ' + q.riskHits + ' 项　·　待复核或缺证据 ' + count +
      ' 项　·　<a href="' + encodeURIComponent(r.call) + '.json">完整 JSON</a></p>' +
      '<ul>' + q.findings.map((f) => '<li>' + escape(f.label + ' · ' + f.detail) + '</li>').join('') + '</ul>' +
      r.connections.map((c) => connection(r, c)).join('') + '</details>';
  });
  const labels = [['通话记录', summary.calls], ['留有双方录音', summary.recorded], ['已确认办理闭环', summary.closedLoops],
    ['声学间隔 P50', seconds(summary.acousticProxy.p50Ms)]];
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>智语外呼 · 通话质检</title><style>
*{box-sizing:border-box}body{margin:0;background:#f4f5f2;color:#172e29;font:16px/1.65 system-ui,'Microsoft YaHei',sans-serif}
main{max-width:1150px;margin:36px auto;padding:0 24px}h1{font-size:32px;margin:0}h2{font-size:22px;margin-top:30px}
.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:12px}article,details{background:white;border:1px solid #cbd5ce;border-radius:10px;padding:16px}
article strong{display:block;color:#136653;font-size:28px}details{margin:12px 0}summary{cursor:pointer;font-weight:650}
table{border-collapse:collapse;width:100%;font-size:14px}td,th{text-align:left;vertical-align:top;border-bottom:1px solid #dce2dc;padding:8px}
td:first-child,td:last-child{white-space:nowrap}a,button{color:#075d4e}button{cursor:pointer;background:#eef6f1;border:1px solid #9ab4a6;border-radius:5px;padding:5px}
audio{max-width:100%}section{overflow-x:auto}p{margin:10px 0}ul{padding-left:22px}</style><main>
<h1>通话质检</h1><p>POP 商家资审 · 本地模拟办理</p><div class="metrics">` +
    labels.map(([k, v]) => '<article>' + k + '<strong>' + v + '</strong></article>').join('') +
    '</div><p>声学间隔取自 ' + summary.acousticProxy.pairs.length +
    ' 轮商家音量候选终点与坐席首个有声帧。赛题首字时延需回听确认停语和首个可辨字。严重违规需结合上下文复核。</p>' +
    '<h2>逐通证据</h2>' + cards.join('') + '</main><script>document.addEventListener("click",e=>{const b=e.target.closest("button[data-seek]");if(!b)return;const a=b.closest("section").querySelector("audio");a.currentTime=Number(b.dataset.seek);a.play().catch(()=>{});});</script></html>';
}
