const $ = (id) => document.getElementById(id);
const issuedDate = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'medium',
});

function item(title, detail, status = '') {
  const li = document.createElement('li');
  const heading = document.createElement('strong');
  heading.textContent = title;
  li.append(heading);
  if (status) {
    const label = document.createElement('span');
    label.className = 'item-status';
    label.textContent = status;
    li.append(label);
  }
  if (detail) {
    const p = document.createElement('p');
    p.textContent = detail;
    li.append(p);
  }
  return li;
}

export function renderResult(s, example) {
  const visible = ['ended','wrong_number','scheduled'].includes(s?.status);
  const entering = visible && $('result').hidden;
  $('result').hidden = !visible;
  $('workspace').classList.toggle('show-result', visible);
  $('transcript-card').hidden = example && visible;
  if (!visible) return;

  const h = s.handling, scheduled = s.status === 'scheduled';
  $('retry-dial').hidden = !scheduled || Boolean(h?.outcome);
  $('retry-missed').hidden = !scheduled || h?.action !== 'retry' || Boolean(h?.outcome);
  $('result-start').hidden = example || Boolean(h);
  $('example-back').hidden = !example;
  $('case-ref').textContent = [example ? '中途挂断示例' : h ? '分流办理' : '通话已结束', s.caseId, '审核版本 ' + s.revision].join(' · ');
  const complete = s.points.filter((p) => p.status === 'complete');
  const pending = s.points.filter((p) => p.status !== 'complete');
  const verified = s.identity === 'verified';
  const wrongNumber = s.status === 'wrong_number';
  $('result-summary').textContent = verified
    ? '已核实商家身份 · ' + complete.length + ' 项材料已讲完，' + pending.length + ' 项材料待跟进' +
      (s.confirmation ? ' · 商家已确认理解' : ' · 尚无商家确认记录')
    : wrongNumber ? '接听方身份不符，需复核联系方式。' : '通话在核身完成前结束，需重新联系商家。';

  const completedList = $('completed-items');
  completedList.replaceChildren(...complete.map((p) => item(p.title, p.requirement, '已播完整')));
  if (!complete.length) completedList.append(item('暂无已完整播出的材料'));

  const followups = $('followup-items');
  followups.replaceChildren(...pending.map((p) => item(
    p.title,
    (p.status === 'partial' ? '下次从本项开头补讲。' : '下次联系时告知。') + p.requirement,
    p.status === 'partial' ? '已播部分' : '待讲'
  )));
  if (!verified && !h) followups.append(item(
    wrongNumber ? '复核联系方式' : '重新核实商家身份',
    wrongNumber ? '核对申请单上的联系人后再安排联系。' : '联系到商家并核身后，再说明整改要求。'
  ));
  if (h && (scheduled || h.action === 'written' || h.outcome === 'missed')) {
    $('result-summary').textContent = h.action === 'written' ? '本单按规则直接书面告知，外呼次数为零。' :
      h.outcome === 'missed' ? '二次外呼未接，已按规则转为书面告知。' :
      h.outcome ? '本审核版本的跟进任务已有办理记录。' : '已建立跟进任务，等待二次联系。';
    if (scheduled) followups.append(item('外呼任务单',h.job,s.routing?.reason));
  }
  if (verified) {
    if (s.handoff) followups.append(item('转人工处理',s.handoff.number + ' · ' + s.handoff.text,'已登记'));
    for (const question of s.questions || [])
      followups.append(item('答复商家追问', question.text, question.hasAnswer ? '待答复' : '待核实'));
    if (s.callback) followups.append(item(
      s.callback.action === 'callback' ? '安排回电' : '澄清是否需要回电', [s.callback.number,s.callback.text].filter(Boolean).join(' · '), '待跟进'
    ));
  }
  if (!followups.children.length) followups.append(item('本通电话暂无待跟进事项'));

  const receipt = s.receipt;
  $('receipt-details').hidden = !receipt;
  $('receipt-status').textContent = receipt
    ? example ? '示例回执，仅供预览' : '书面意见已写入本地模拟库'
    : scheduled ? '等待跟进结果。' : verified ? '这次通话没有已保存的模拟回执。' : '核身未通过，本次未生成书面回执。';
  $('receipt-number').textContent = receipt?.number || '';
  $('receipt-date-row').hidden = !receipt?.issuedAt;
  $('receipt-date').textContent = receipt?.issuedAt ? issuedDate.format(new Date(receipt.issuedAt)) : '';
  $('receipt-opinion').textContent = receipt?.opinion || '';
  if (entering) $('result-title').focus();
}
