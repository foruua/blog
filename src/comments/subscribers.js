// 「有人回复了你」退订名单的唯一读写入口，存在 settings 的 mail_unsub，只记邮箱指纹。单独成层是因为
// 这条键曾在三处各解析且语义已分叉（Set/数组/数长度），换结构必漏一处且不报错（退订静默失效）。
const KEY = 'mail_unsub';

function listSubscribers(repo) {
  try {
    const raw = JSON.parse(repo.getSetting(KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((h) => typeof h === 'string') : [];
  } catch { return []; }
}

export const isMuted = (repo, hash) => Boolean(hash) && listSubscribers(repo).includes(hash);

// mail_unsub 整份读写：两个更新交错会互相覆盖（丢退订）。用模块级 promise 链排队，使读写在同段内原子。
let queue = Promise.resolve();
const enqueue = (fn) => {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
};

export function setMuted(repo, hash, muted) {
  return enqueue(() => {
    const set = new Set(listSubscribers(repo));
    if (muted) set.add(hash); else set.delete(hash);
    repo.setSetting(KEY, JSON.stringify([...set]));
  });
}

export const subscriberCount = (repo) => listSubscribers(repo).length;

// 清空也必须走同一条队列：直接写会与并发的退订/订阅互相覆盖。
export const clearSubscribers = (repo) => enqueue(() => repo.setSetting(KEY, '[]'));
