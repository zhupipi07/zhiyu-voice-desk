// Embedded in the offline export. Work entirely with the bundled JSON and local WAV.
export function bindAnnotations() {
  const reports = JSON.parse(document.getElementById('reports').textContent);
  const number = ms => Number.isFinite(ms) ? (ms / 1000).toFixed(3) + ' 秒' : '待标注';
  for (const box of document.querySelectorAll('[data-review]')) {
    const report = reports.find(r => r.call === box.dataset.review);
    const conn = report.connections.find(c => c.connection === box.dataset.connection);
    const player = box.closest('section').querySelector('audio');
    const select = box.querySelector('select');
    const message = box.querySelector('output');
    const current = () => conn.turns[Number(select.value)];
    function show() {
      const t = current();
      message.textContent = '停语 ' + number(t.confirmedSpeechEndMs == null ? null : t.confirmedSpeechEndMs - conn.recording.originMs) +
        ' · 首字 ' + number(t.firstIntelligibleMs == null ? null : t.firstIntelligibleMs - conn.recording.originMs) +
        ' · 首字间隔 ' + number(t.firstWordLatencyMs) + ' · 正文间隔 ' + number(t.contentWordLatencyMs);
    }
    function jump() {
      const t = current(), at = t.micStartCandidateMs ?? t.markersMs.speech_started ?? t.markersMs.speech_stopped;
      if (Number.isFinite(at)) player.currentTime = Math.max(0,(at - conn.recording.originMs) / 1000 - 2);
      show();
    }
    select.onchange = jump;
    box.onclick = e => {
      const action = e.target.dataset.action;
      if (!action) return;
      const t = current();
      if (action === 'jump') {jump(); return;}
      if (action === 'slow') {player.playbackRate = player.playbackRate === 1 ? 0.65 : 1; e.target.textContent = player.playbackRate + ' 倍速'; return;}
      if (action === 'back' || action === 'next') {player.pause();player.currentTime = Math.max(0,player.currentTime + (action === 'back' ? -0.02 : 0.02));return;}
      if (action === 'export') {
        const url = URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
        const link = document.createElement('a');link.href = url;link.download = report.call + '-annotated.json';link.click();
        setTimeout(() => URL.revokeObjectURL(url),1000);return;
      }
      if (action === 'clear') {t.confirmedSpeechEndMs = null;t.firstIntelligibleMs = null;t.firstContentWordMs = null;}
      else if (['confirmedSpeechEndMs','firstIntelligibleMs','firstContentWordMs'].includes(action)) {
        if (!player.readyState || !Number.isFinite(player.duration)) {message.textContent = '请先加载并回听这段录音。';return;}
        player.pause();
        t[action] = conn.recording.originMs + Math.min(conn.recording.samples / 8,Math.round(player.currentTime * 1000));
      }
      t.firstWordLatencyMs = t.confirmedSpeechEndMs == null || t.firstIntelligibleMs == null ? null :
        Math.round(t.firstIntelligibleMs - t.confirmedSpeechEndMs);
      t.contentWordLatencyMs = t.confirmedSpeechEndMs == null || t.firstContentWordMs == null ? null :
        Math.round(t.firstContentWordMs - t.confirmedSpeechEndMs);
      show();
    };
    show();
  }
}
