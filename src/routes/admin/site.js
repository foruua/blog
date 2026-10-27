import { clientIp } from '../../util/http.js';
import { externalWrite, bodyOf, val, checked, notice } from './shared.js';
import { applySiteIdentity, saveSiteIdentity } from '../../site/identity.js';
import { saveNav } from '../../site/nav.js';
import { saveCommentSettings } from '../../settings.js';

// 站点配置的写入路由。全部落在已有的 settings 表里，保存后 redirect 回 /admin/system 带一行提示。
// 每个表单一个端点：改站名不该把导航顺序、密码一起提交（那样一处校验失败就全都不生效）。

/** 表单里的并行数组（key[0]、label[0]…）。行数由 key 决定：未勾选的 checkbox 根本不会出现在请求里。 */
function collect(body, name) {
  const out = [];
  if (typeof body?.has !== 'function') return out;
  for (let i = 0; body.has(`${name}[${i}]`); i += 1) out.push(val(body, `${name}[${i}]`));
  return out;
}

/** 「上移/下移」按钮的值是 `行号:方向`。认不出就不动，别把一次误点变成一次乱序保存。
 *  方向写成 (-1|1) 而不是 -?1：`?1` 会被 test-regressions 的「SQL 不得用编号参数」那条守卫误判。 */
function parseMove(raw) {
  const m = /^(\d{1,3}):(-1|1)$/.exec(String(raw ?? '').trim());
  return m ? { index: Number(m[1]), dir: Number(m[2]) } : null;
}

export function registerSiteRoutes(app, { repo, auth, crypt }) {
  const run = (fn) => repo.transaction(fn);

  app.post('/admin/site/identity', async (c) => {
    const body = await bodyOf(c);
    const error = run(() => saveSiteIdentity(body, (k, v) => repo.setSetting(k, v), val));
    if (error) return notice(c, '/admin/system', `✗ ${error}`);
    // 立刻生效：SITE 是各处共享的同一个对象，改完下一次渲染就是新值（页面缓存随 settings 写入失效）。
    applySiteIdentity((key) => repo.getSetting(key));
    return notice(c, '/admin/system', '✓ 站点身份已保存');
  });

  app.post('/admin/site/nav', async (c) => {
    const body = await bodyOf(c);
    const keys = collect(body, 'key');
    if (!keys.length) return notice(c, '/admin/system', '✗ 导航项为空，回去刷新一次再改');
    const payload = {
      keys,
      labels: collect(body, 'label'),
      groups: collect(body, 'group'),
      hrefs: collect(body, 'href'),
      shows: keys.map((_, i) => checked(body, `show[${i}]`)),
      moreLabel: val(body, 'moreLabel'),
      removeKey: val(body, 'remove'),
      move: parseMove(val(body, 'move')),
      newLabel: val(body, 'newLabel'),
      newHref: val(body, 'newHref'),
      newGroup: val(body, 'newGroup'),
    };
    const error = run(() => saveNav(payload, (k, v) => repo.setSetting(k, v)));
    return error
      ? notice(c, '/admin/system', `✗ ${error}`)
      : notice(c, '/admin/system', '✓ 导航菜单已保存');
  });

  app.post('/admin/site/comments', async (c) => {
    const body = await bodyOf(c);
    const error = run(() => saveCommentSettings({
      open: checked(body, 'open'),
      moderateAll: checked(body, 'moderateAll'),
      rate: val(body, 'rate'),
    }, (k, v) => repo.setSetting(k, v)));
    return error
      ? notice(c, '/admin/system', `✗ ${error}`)
      : notice(c, '/admin/system', '✓ 评论设置已保存');
  });

  // 改密码：scrypt 约 32MB/次，与登录同理登记为 external write，不进全局写队列。
  externalWrite(app, '/admin/password', async (c) => {
    const body = await bodyOf(c);
    const current = val(body, 'current');
    const next = val(body, 'next');
    const confirm = val(body, 'confirm');

    if (!current) return notice(c, '/admin/system', '✗ 请先输入当前密码');
    if (next.length < 8) return notice(c, '/admin/system', '✗ 新密码至少 8 位');
    if (next.length > 200) return notice(c, '/admin/system', '✗ 新密码太长了（最多 200 位）');
    if (next !== confirm) return notice(c, '/admin/system', '✗ 两次输入的新密码不一致');
    if (next === current) return notice(c, '/admin/system', '✗ 新密码和当前密码一样');

    let result;
    try {
      result = await auth.changePassword(c, current, next, crypt.ipHash(clientIp(c)));
    } catch {
      return notice(c, '/admin/system', '✗ 保存失败，密码未改动（详情见服务端日志）');
    }
    if (result.ok) return notice(c, '/admin/system', '✓ 密码已更新，其它设备上的登录已失效');
    if (result.reason === 'bad-password') return notice(c, '/admin/system', '✗ 当前密码不正确');
    if (result.reason === 'rate-limited') return notice(c, '/admin/system', '✗ 试错太频繁，请 15 分钟后再试');
    return notice(c, '/admin/system', '✗ 还没设置过后台密码，请先在服务器上运行 npm run set-password');
  });
}
