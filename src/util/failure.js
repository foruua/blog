// 把失败报文压成一句人话——后台「友圈」「友链」行里的半行说明。报文给机器看（`对方返回 HTTP 403`…），
// 整条挂上行里就是半屏灰字；站主要回答的只有：对方不让读、连不上、内容不对。所以行里只写标签，原文
// 挪进 title 悬停可见。认不出的照原样截短（宁可难看也不能因将来多一条错误消息让整行塌掉）；因它只认
// 文本不认代码，库里存量老报文也一并变短，不必等下一轮抓取刷掉。
const HTTP_WORD = {
  400: '请求有误', 401: '需要登录', 403: '拒绝访问', 404: '地址不存在',
  405: '方法不允许', 410: '已下线', 429: '请求过多', 451: '已下线',
};

export function failureLabel(message) {
  const text = String(message ?? '').trim();
  if (!text) return '';

  const http = /HTTP\s*(\d{3})/.exec(text);
  if (http) {
    const code = Number(http[1]);
    return `${code} ${HTTP_WORD[code] ?? (code >= 500 ? '对方服务异常' : '对方拒绝了这次请求')}`;
  }
  if (/超时/.test(text)) return '超时';
  if (/解析/.test(text)) return '域名解析不了';
  if (/内网|保留地址/.test(text)) return '指向内网地址';
  if (/格式不对|只支持 http|账号密码/.test(text)) return '地址无效';
  if (/网页|JSON Feed|不是订阅源|不是 RSS|根元素/.test(text)) return '不是订阅源';
  if (/空内容/.test(text)) return '对方返回空内容';
  if (/没有(任何)?条目/.test(text)) return '源里没有条目';
  if (/超过 \d+KB|内容过大/.test(text)) return '内容过大';
  if (/跳转/.test(text)) return '跳转过多';
  if (/XML/.test(text)) return 'XML 太复杂';
  // 「读取」要先于「连不上」判：读到一半断开的报文里也带 ECONNRESET，它是连上之后才断的。
  if (/读不到|读取对方/.test(text)) return '读不到内容';
  if (/连不上|ECONN|socket/.test(text)) return '连不上对方';

  // 兜底：冒号前那半句通常就是结论（`xxx 失败：原生错误`），再不行按字数截。
  const head = text.split('：')[0];
  return head.length > 16 ? `${head.slice(0, 16)}…` : head;
}
