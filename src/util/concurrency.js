/** 网络任务的共享并发额度：手动操作与整轮任务共用。 */
export function createLimiter(limit = 4) {
  let active = 0;
  const queue = [];
  function drain() {
    while (active < limit && queue.length) {
      const { run, resolve, reject } = queue.shift();
      active++;
      Promise.resolve().then(run).then(resolve, reject).finally(() => { active--; drain(); });
    }
  }
  return (run) => new Promise((resolve, reject) => { queue.push({ run, resolve, reject }); drain(); });
}
