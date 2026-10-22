// HTML 命名实体解码——友圈解析与友链标题提取共用。以前两处各写一份且行为不一致（parse 那份 ~50 项、大小写
// 敏感；check 那份只 6 项、大小写不敏感），同一个站名在两条路径上可能解出不同结果。现在只此一份，表外未知实体
// 原样保留。大小写敏感是刻意的：`&prime;`(′ U+2032) 与 `&Prime;`(″ U+2033) 都是合法实体，折叠成小写会解错；数字实体则挡住代理区与越界码点。
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: '\u00a0', iexcl: '\u00a1', cent: '\u00a2', pound: '\u00a3', yen: '\u00a5',
  sect: '\u00a7', copy: '\u00a9', laquo: '\u00ab', reg: '\u00ae', deg: '\u00b0',
  plusmn: '\u00b1', sup2: '\u00b2', sup3: '\u00b3', micro: '\u00b5', para: '\u00b6',
  middot: '\u00b7', frac12: '\u00bd', times: '\u00d7', divide: '\u00f7',
  ndash: '\u2013', mdash: '\u2014', lsquo: '\u2018', rsquo: '\u2019',
  ldquo: '\u201c', rdquo: '\u201d', bull: '\u2022', hellip: '\u2026',
  permil: '\u2030', prime: '\u2032', Prime: '\u2033', larr: '\u2190',
  rarr: '\u2192', harr: '\u2194', infin: '\u221e', ne: '\u2260',
  le: '\u2264', ge: '\u2265', euro: '\u20ac', trade: '\u2122',
  shy: '\u00ad', ensp: ' ', emsp: ' ', thinsp: ' ',
};

const ENTITY_RE = /&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g;

// @param {{max?:number}} opts max 是一次解码最多还原多少实体（防实体炸弹）。
export function decodeEntities(input, { max = 50000 } = {}) {
  let budget = max;
  return String(input ?? '').replace(ENTITY_RE, (whole, body) => {
    if (budget-- <= 0) return whole;
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      // 代理区/越界/控制字符一律不还原：进 DOM 只会变乱码或注入面。
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      if (code >= 0xd800 && code <= 0xdfff) return whole;
      try { return String.fromCodePoint(code); } catch { return whole; }
    }
    return Object.hasOwn(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : whole;
  });
}
