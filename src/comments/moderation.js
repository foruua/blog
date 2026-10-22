// 审核链接签发只此一处：邮件与审核页续签共用，免得 payload 形状/时效各写一遍。链接一次性——
// setStatus 会换掉 nonce 使旧链接失效；表单 action 用刚续签的新链接，站主连点不受影响。
const MODERATION_TTL = 7 * 24 * 3600;

export const signModeration = (crypt, { id, nonce, epoch, action = '' }) =>
  crypt.sign({ purpose: 'moderation', c: id, nonce, ep: epoch, a: action }, MODERATION_TTL);
