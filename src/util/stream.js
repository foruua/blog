// 有界流读取：边读边计数，超限立刻 cancel；成功返回 Buffer，超限返回 null（调用方各自决定错误语义）。
//
// **不要**塞进 util/http.js：它顶层 import config.js，而测试夹具依赖「先设 env 再动态 import」，
// 任何顶层间接拉起 config.js 的模块都会让夹具读到真实仓库路径。这里只依赖 node 内置，保持纯净。
export async function readBoundedStream(body, limit) {
  const reader = body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) { await reader.cancel().catch(() => {}); return null; }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock?.(); }
  return Buffer.concat(chunks);
}
