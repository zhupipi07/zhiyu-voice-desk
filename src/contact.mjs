// Match an explicit statement about the recipient, preserving clause boundaries.
export function deniesIdentity(words) {
  const statements = words.normalize('NFKC').replace(/\s/g, '').split(/[，,。.!！；;]/u);
  return statements.some((s) =>
    /^(?:(?:你们?|您)(?:电话)?|这个电话)?(?:打错|拨错|找错)(?:了|号码了?|电话了?|人了?)?$/.test(s) ||
    /^(?:(?:我|我们|这|这里|这儿|这边)(?:公司)?)?(?:不是|并非|不属于)(?:本人|青禾商贸(?:有限(?:责任)?公司)?(?:的(?:人|员工|负责人)?)?)$/.test(s) ||
    /^(?:这|这里|这家)?不是我们公司$/.test(s)
  );
}

// This decision only creates or changes a local follow-up for a verified merchant.
export function callbackIntent(words, verified) {
  if (!verified) return 'none';
  const text = words.normalize('NFKC').replace(/\s+/g, '');
  if (/(?:是说|意思是|是不是).{0,8}(?:不用|不要|不需要).{0,8}(?:回电|打电话|联系)|(?:不用|不要|不需要).{0,8}(?:回电|打电话|联系).{0,3}(?:吗|么|是吗)/.test(text)) return 'clarify';
  if (/(?:不用|不要|不必|别|不需要)(?:再)?(?:给我)?(?:回电|回拨|打电话|打给我|联系我)/.test(text)) return 'declined';
  if (/(?:晚点再说|回头再说|过会儿决定)|(?:说不准|还没想好|不确定).{0,10}(?:回电|打电话|要不要联系)/.test(text)) return 'clarify';
  if (/(?:请|麻烦|希望|记得|劳驾|需要)(?:你们?|您)?(?:再)?(?:给我)?(?:回电|回拨|打电话|打给我)|(?:结果|审核完|审核后|处理好|有消息|出了结果).{0,8}(?:给我回电|打给我|电话(?:告诉|通知)我|给我打(?:个)?电话)|(?:给我回个电话|请来个电话)/.test(text)) return 'callback';
  return 'none';
}
