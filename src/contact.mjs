// Match an explicit statement about the recipient, preserving clause boundaries.
export function deniesIdentity(words, merchant = '青禾商贸') {
  const statements = words.normalize('NFKC').replace(/\s/g, '').split(/[，,。.!！；;]/u);
  return statements.some((clause) => {
    const s = clause.replaceAll(merchant, '目标商家');
    return (
    /^(?:(?:你们?|您)(?:电话)?|这个电话)?(?:打错|拨错|找错)(?:了|号码了?|电话了?|人了?)?$/.test(s) ||
    /^(?:(?:我|我们|这|这里|这儿|这边)(?:公司)?)?(?:不是|并非|不属于)(?:本人|目标商家(?:有限(?:责任)?公司)?(?:的(?:人|员工|负责人)?)?)$/.test(s) ||
    /^(?:这|这里|这家)?不是我们公司$/.test(s)
    );
  });
}

// This decision only creates or changes a local follow-up for a verified merchant.
export const callbackVersion = 'callback-v2';
export const callbackPolicies = {
  'callback-v1': { attitude: false, wording: false },
  'callback-attitude': { attitude: true, wording: false },
  'callback-wording': { attitude: false, wording: true },
  'callback-v2': { attitude: true, wording: true },
};
export function callbackIntent(words, verified, version = callbackVersion) {
  if (!verified) return 'none';
  const policy = callbackPolicies[version];
  if (!policy) throw new Error('未知回电策略版本');
  let text = words.normalize('NFKC').replace(/\s+/g, '');
  if (policy.wording) text = text.replace(/(?:烦请|烦劳|有劳)/gu, '请')
    .replace(/(?:致电给我|致电我|致电|来电告知|打(?:一)?个电话)/gu, '打电话')
    .replace(/回(?:一)?个电话/gu, '回电');
  if (policy.attitude && /回电|回拨|电话|致电|打给我/.test(text)) {
    if (/(?:没(?:有)?说|并非说|不是说|是否|是不是|是指).{0,12}(?:希望|请|需要|回电|打电话)|(?:希望|需要|请).{0,10}(?:回电|打电话|打给我).{0,3}(?:吗|么)/.test(text)) return 'clarify';
    if (/(?:不希望|不想|不愿意)(?:你们?|您)?(?:再)?(?:给我)?(?:回电|回拨|打电话|打给我)/.test(text)) return 'declined';
  }
  if (policy.wording && /^给我(?:回电|打电话)(?:吧|就好)?[。！!]?$/u.test(text)) return 'callback';
  if (/(?:是说|意思是|是不是).{0,8}(?:不用|不要|不需要).{0,8}(?:回电|打电话|联系)|(?:不用|不要|不需要).{0,8}(?:回电|打电话|联系).{0,3}(?:吗|么|是吗)/.test(text)) return 'clarify';
  if (/(?:不用|不要|不必|别|不需要)(?:再)?(?:给我)?(?:回电|回拨|打电话|打给我|联系我)/.test(text)) return 'declined';
  if (/(?:晚点再说|回头再说|过会儿决定)|(?:说不准|还没想好|不确定).{0,10}(?:回电|打电话|要不要联系)/.test(text)) return 'clarify';
  if (/(?:请|麻烦|希望|记得|劳驾|需要)(?:你们?|您)?(?:再)?(?:给我)?(?:回电|回拨|打电话|打给我)|(?:结果|审核完|审核后|处理好|有消息|出了结果).{0,8}(?:给我回电|打给我|电话(?:告诉|通知)我|给我打(?:个)?电话)|(?:给我回个电话|请来个电话)/.test(text)) return 'callback';
  return 'none';
}
