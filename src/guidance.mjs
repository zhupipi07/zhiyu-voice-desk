// These four question families are the ones the synthetic review record can answer.
// Match the whole clause so an invoice page or a fee inquiry cannot inherit a brand-authorization answer.
const questions = {
  page: [
    /^(?:具体)?(?:是|要|需要|应该)?(?:我)?(?:补交|补充|补|提供|提交|上传|找|看)?(?:的是|的)?(?:哪一?页|第几页|哪一张|哪张页面)$/,
    /^(?:有(?:没有)?|是否有)(?:指定|固定|具体)的?页码$/,
    /^(?:具体)?页码(?:是(?:多少|几)|有要求)?$/,
    /^(?:有印章|盖章)的?那(?:一)?(?:张|页)(?:是|在)?第几页$/,
  ],
  chain: [
    /^(?:授权链路|授权链|授权关系)(?:里|中)?(?:缺少|缺|要补|怎么补|如何补)(?:的是|了|的)?(?:哪一?(?:段|环|层))?$/,
    /^(?:要|需要|缺|请问)?(?:谁|哪家)(?:给|到)(?:谁|哪家)的?授权(?:书|证明|关系)?$/,
    /^(?:要补|需要|缺少)(?:哪一?段|哪一?级)的?授权(?:书|关系|链路)?$/,
  ],
  channel: [
    /^(?:要|需要|应该|可以)?(?:上传|传|交|提交|补交)(?:到|在|去)?(?:哪里|哪儿|哪|哪个(?:入口|页面|平台))$/,
    /^(?:应该|可以|要)?(?:从|在|到|去)?(?:哪里|哪儿|哪个(?:入口|页面|平台))(?:去|可以)?(?:上传|提交|补交|传)$/,
    /^(?:怎么|如何)(?:上传|提交|补交)(?:材料|资料|盖章页)?$/,
    /^(?:我)?(?:该|要|应该)?(?:往|走|用)(?:哪儿|哪里|哪个(?:入口|平台))(?:上传|提交|传过去|传)?$/,
  ],
  result: [
    /^(?:补(?:交|齐|全|上|好|了)?(?:后|以后|之后|了)?|重新提交(?:后)?)(?:是否|是不是|会不会|能不能)?(?:就|还)?(?:保证|一定|肯定|直接)?(?:会|能|可以)?(?:审核)?(?:通过|过审|过)$/,
    /^(?:能否|能不能|可以|能)(?:确保|保证)(?:审核)?通过$/,
    /^(?:补齐|补交|补了)(?:后|以后)?(?:还(?:要|需要)|是否需要)(?:重新)?审核$/,
    /^(?:我)?补(?:齐|交|了)(?:材料|资料)(?:后|以后)?(?:还是|还)?(?:要|需要)(?:重新)?审核$/,
  ],
};
const subjects = /^(?:(?:本次|这个|这份|这张|我的|这两项|这些)?(?:品牌授权书|授权书|授权材料|盖章页|材料|资料)(?:的)?)/u;

function clauseTopic(clause) {
  const words = clause.replace(/^(?:您好|你好|嗯|呃|那|好|请问|我想问(?:一下)?|我是想问|麻烦(?:问|说)一下|请告诉我)+/u, '')
    .replace(/[呢吗啊呀吧]+$/u, '');
  if (!words) return null;
  const subjectless = words.replace(subjects, '');
  for (const [topic, patterns] of Object.entries(questions)) {
    if (patterns.some((pattern) => pattern.test(words) || pattern.test(subjectless))) return topic;
  }
  return 'unknown';
}

export function guidanceTopic(transcript, proposed) {
  if (!Object.hasOwn(questions, proposed)) return null;
  const words = transcript.normalize('NFKC').replace(/\s+/gu, '')
    .replace(/^(?:我)?不是(?:在)?问[^，,。？！?!；;]+[，,](?=(?:我想问|我是想问|我是问|请问))/u, '')
    .replace(/^我是问/u, '我想问');
  const topics = new Set(words.split(/[，,。？！?!.；;]/u).map(clauseTopic).filter(Boolean));
  if (topics.size !== 1 || topics.has('unknown')) return null;
  return [...topics][0];
}
