import yaml from 'js-yaml';

// 只支持内容规范中的 YAML 头；正文永远不参与元数据序列化。
export function parseFrontmatter(raw) {
  const text = String(raw).replace(/^\uFEFF/, '');
  const opening = /^---(?:yaml)?[ \t]*\r?\n/.exec(text);
  if (!opening) return { data: {}, content: text };
  const rest = text.slice(opening[0].length);
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (!closing) throw new Error('YAML 元数据缺少结束分隔线');
  const data = yaml.load(rest.slice(0, closing.index), { schema: yaml.CORE_SCHEMA }) ?? {};
  if (typeof data !== 'object' || Array.isArray(data)) throw new Error('YAML 元数据必须是键值映射');
  return { data, content: rest.slice(closing.index + closing[0].length) };
}

export function stringifyFrontmatter(data, body) {
  const front = yaml.dump(data, { schema: yaml.CORE_SCHEMA, noRefs: true, lineWidth: -1 });
  return `---\n${front}---\n${String(body)}`;
}
