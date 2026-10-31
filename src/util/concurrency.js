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

/**
 * 整轮后台任务的单飞编排（友圈 refreshAll / 友链 checkAll 共用，此前是两份逐行相同的实现）：
 *  - 自动轮进行中，非强制调用直接复用同一 promise；
 *  - 强制轮（手动「全部刷新」）不能被吞掉：排队等当前轮结束后补跑一轮，且补跑前再查一次
 *    inFlight——若期间又起了自动轮，继续排队而不是并行开第二轮。
 * runRound(opts) 返回整轮的 promise；force 之外的原样透传。
 */
/**
 * @param {object} options
 * @param {(opts: any) => Promise<any>} options.runRound
 * @param {(line: string) => void} [options.log]
 * @param {string} [options.tag]
 */
export function createRoundRunner({ runRound, log = () => {}, tag = 'ROUND' }) {
  let inFlight = null;
  let forced = null;
  function start(opts) {
    // 同步启动 runRound：调用方（checkAll/refreshAll）返回时，任务必须已经排进并发队列——
    // 原实现是 async IIFE，函数体同步执行到第一个 await；这里多包一层微任务会破坏该时序
    // （测试「发起一轮后立刻 release 探针」依赖它）。
    let run;
    try { run = Promise.resolve(runRound(opts)); }
    catch (error) { run = Promise.reject(error); }
    run = run.finally(() => { inFlight = null; });
    inFlight = run;
    run.catch((error) => log(JSON.stringify({ event: `${tag}.round-failed`, code: error?.code ?? 'INTERNAL' })));
    return run;
  }
  return {
    run(opts = {}) {
      if (inFlight) {
        if (!opts.force) return inFlight;
        // 当前轮失败时 then 会被跳过，手动刷新就被吞掉；先吞掉 rejection，保证补跑轮一定执行。
        if (!forced) forced = inFlight.catch(() => {}).then(() => this.run(opts)).finally(() => { forced = null; });
        forced.catch((error) => log(JSON.stringify({ event: `${tag}.forced-round-failed`, code: error?.code ?? 'INTERNAL' })));
        return forced;
      }
      return start(opts);
    },
    busy: () => Boolean(inFlight),
    // 在飞的轮次 promise（含排队中的强制轮），供调用方与自己的单任务 promise 一起 drain。
    pending: () => [inFlight, forced].filter(Boolean),
  };
}
