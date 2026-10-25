// 订阅源的状态是派生的：库里只有 enabled / fail_count / last_ok_at，没有「状态」列。
// 后台的徽章、筛选条、计数都从这里取一份——路由按一套算、模板按另一套显示时最难查（列表说 3 个失败，筛进去只有 2 行）。
export const FEED_STATES = ['failed', 'ok', 'never', 'off'];

// 停用优先：停用的源即便上次抓取失败也只算「已停用」——它已经不再抓了，不该混进要处理的失败堆里，
// 两个筛选的计数也就不会重叠。
export const feedState = (f) => (!f.enabled ? 'off' : f.fail_count > 0 ? 'failed' : f.last_ok_at ? 'ok' : 'never');

// 一次遍历出各状态数量。筛选条上写的是全量数，不是当前页数——否则「失败 2」会被读成「一共就 2 个失败」。
export function feedStateCounts(list) {
  const counts = { all: list.length, failed: 0, ok: 0, never: 0, off: 0 };
  for (const f of list) counts[feedState(f)] += 1;
  return counts;
}
