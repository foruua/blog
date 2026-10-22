import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { Hono } from 'hono';
import { createAvatarCache, BLANK_PNG } from '../src/avatar/cache.js';
import { avatarRoutes } from '../src/routes/avatar.js';
import { emailMd5, AVATAR_MD5_RE } from '../src/avatar/md5.js';
import { avatar } from '../src/comments/render.js';
import { createChecker } from './_check.mjs';

/* 评论头像（Gravatar 协议）的服务端反代。刻意**一次真实网络请求都不发**：上游用注入的 fetchImpl 假装，路由用 Hono 的 app.request 直接打 —— */
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-avatar-'));
const { test, report } = createChecker();

const PNG = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#c00' } }).png().toBuffer();
const JPEG = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#00c' } }).jpeg().toBuffer();
const H1 = emailMd5('reader@example.com');
const H2 = emailMd5('other@example.com');
let seq = 0;
const freshDir = () => path.join(work, `cache-${++seq}`);

const reply = (body, { status = 200, type = 'image/png' } = {}) =>
  new Response(body, { status, headers: { 'content-type': type } });

const upstreamStub = (handler) => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return handler(url, calls.length); };
  return { calls, fetchImpl };
};

try {
  await test('V1 emailMd5 用 Gravatar 口径（trim + 小写），空邮箱为 null', () => {
    assert.equal(emailMd5(' MyEmailAddress@example.com '), '0bc83cb571cd1c50ba6f3e8a78ef1346');
    assert.equal(emailMd5('me@example.com'), emailMd5('ME@Example.COM'));
    assert.equal(emailMd5('   '), null);
    assert.equal(emailMd5(null), null);
    assert.ok(AVATAR_MD5_RE.test(emailMd5('a@b.c')));
    assert.ok(!AVATAR_MD5_RE.test('not-a-hash'));
  });

  await test('V2 透明占位是合法 1×1 PNG（没有头像时字母头像要透出来）', async () => {
    const meta = await sharp(BLANK_PNG).metadata();
    assert.equal(meta.format, 'png');
    assert.equal(meta.width, 1);
    assert.equal(meta.height, 1);
    assert.equal(meta.hasAlpha, true);
  });

  await test('V3 回源成功：按魔数定类型、落盘、第二次不再回源', async () => {
    const dir = freshDir();
    const { calls, fetchImpl } = upstreamStub(() => reply(PNG, { type: 'image/png' }));
    const cache = createAvatarCache({ dir, upstreams: ['https://up.example/avatar'], fetchImpl });
    const one = await cache.resolve(H1);
    assert.equal(one.type, 'image/png');
    assert.equal(one.maxAge, 86400);
    assert.ok(one.body.equals(PNG));
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.startsWith(`https://up.example/avatar/${H1}?s=`), calls[0].url);
    assert.match(calls[0].url, /d=404/);   // 没头像时让上游明确回 404，而不是塞一张默认脸

    const two = await cache.resolve(H1);
    assert.ok(two.body.equals(PNG));
    assert.equal(calls.length, 1, '第二次应该走本地缓存');
  });

  await test('V4 响应头说是 jpeg、实际是 PNG：以字节为准（不信任上游 content-type）', async () => {
    const cache = createAvatarCache({
      dir: freshDir(), upstreams: ['https://up.example/avatar'],
      fetchImpl: upstreamStub(() => reply(PNG, { type: 'image/jpeg' })).fetchImpl,
    });
    assert.equal((await cache.resolve(H1)).type, 'image/png');
  });

  await test('V5 上游 404（这个邮箱没头像）→ 透明占位 + 负缓存，不再反复回源', async () => {
    const { calls, fetchImpl } = upstreamStub(() => reply('', { status: 404, type: 'text/plain' }));
    const cache = createAvatarCache({ dir: freshDir(), upstreams: ['https://up.example/avatar'], fetchImpl });
    const one = await cache.resolve(H1);
    assert.ok(one.body.equals(BLANK_PNG));
    assert.equal(one.maxAge, 3600);
    const two = await cache.resolve(H1);
    assert.ok(two.body.equals(BLANK_PNG));
    assert.equal(two.maxAge, 3600);
    assert.equal(calls.length, 1, '负缓存期内不该再问上游');
  });

  await test('V17 一家回 404 不等于"这邮箱没头像"：继续问下一家', async () => {
    // 真实踩到的：a@uua.me 在 Cravatar 上 404，在另一个 Gravatar 镜像上有图。
    const dir = freshDir();
    const { calls, fetchImpl } = upstreamStub((url) => (url.includes('partial.example')
      ? reply('', { status: 404, type: 'text/plain' })
      : reply(PNG, { type: 'image/png' })));
    const cache = createAvatarCache({
      dir, upstreams: ['https://partial.example/avatar', 'https://full.example/avatar'], fetchImpl,
    });
    const got = await cache.resolve(H1);
    assert.ok(got.body.equals(PNG));
    assert.equal(calls.length, 2, '第二家要被问到');
    assert.ok(!fs.existsSync(`${path.join(dir, H1)}.none`), '有图就不该留负缓存');
  });

  await test('V18 所有上游都 404 才记负缓存', async () => {
    const { calls, fetchImpl } = upstreamStub(() => reply('', { status: 404, type: 'text/plain' }));
    const cache = createAvatarCache({
      dir: freshDir(), upstreams: ['https://a.example/avatar', 'https://b.example/avatar'], fetchImpl,
    });
    assert.ok((await cache.resolve(H1)).body.equals(BLANK_PNG));
    assert.equal(calls.length, 2, '两家都要问到');
    assert.ok((await cache.resolve(H1)).body.equals(BLANK_PNG));
    assert.equal(calls.length, 2, '负缓存之后不再回源');
  });

  await test('V22 404 混合故障或冷静期不写负缓存，上游恢复后可以拿到头像', async () => {
    for (const failure of ['503', 'timeout']) {
      const dir = freshDir();
      let recovered = false;
      const { fetchImpl } = upstreamStub((url) => {
        if (url.startsWith('https://a.')) return reply('', { status: 404 });
        if (recovered) return reply(PNG);
        if (failure === 'timeout') throw new Error('timeout');
        return reply('', { status: 503 });
      });
      const cache = createAvatarCache({ dir, upstreams: ['https://a.example/avatar', 'https://b.example/avatar'], fetchImpl, downMs: 30 });
      assert.equal((await cache.resolve(H1)).maxAge, 0);
      assert.ok(!fs.existsSync(path.join(dir, H1 + '.none')));
      assert.equal((await cache.resolve(H1)).maxAge, 0, '冷静期跳过的上游也不能算作 404');
      recovered = true;
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.ok((await cache.resolve(H1)).body.equals(PNG));
    }
  });

  await test('V6 上游回的不是图片 / 体积超限 / 直接抛错 → 占位、不留缓存（冷静期过后会重试）', async () => {
    const cases = [
      ['text/html', () => reply('<html></html>', { type: 'text/html' })],
      ['超大', () => reply(Buffer.alloc(600 * 1024), { type: 'image/png' })],
      ['抛错', () => { throw new Error('boom'); }],
      ['500', () => reply('nope', { status: 500, type: 'text/plain' })],
    ];
    for (const [label, handler] of cases) {
      const dir = freshDir();
      const { calls, fetchImpl } = upstreamStub(handler);
      // downMs: 0 关掉冷静期（默认刻意留着，别让每请求都等满超时），专门验「失败不会被写进缓存」。
      const cache = createAvatarCache({ dir, upstreams: ['https://up.example/avatar'], fetchImpl, downMs: 0 });
      const got = await cache.resolve(H1);
      assert.ok(got.body.equals(BLANK_PNG), label);
      assert.equal(got.maxAge, 0, `${label}：不该被缓存`);
      assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], [], `${label}：不该落盘`);
      await cache.resolve(H1);
      assert.equal(calls.length, 2, `${label}：下次还要回源`);
    }
  });

  await test('V7 上游链：第一家挂了自动换第二家，之后直接走第二家', async () => {
    const { calls, fetchImpl } = upstreamStub((url) => {
      if (url.includes('down.example')) throw new Error('ECONNREFUSED');
      return reply(JPEG, { type: 'image/jpeg' });
    });
    const cache = createAvatarCache({
      dir: freshDir(), upstreams: ['https://down.example/avatar', 'https://mirror.example/avatar'], fetchImpl,
    });
    const one = await cache.resolve(H1);
    assert.equal(one.type, 'image/jpeg');
    assert.equal(calls.length, 2);
    await cache.resolve(H2);   // 换一个 hash，缓存不命中，但挂掉的那家应在冷静期内被跳过
    assert.equal(calls.length, 3);
    assert.ok(calls[2].url.includes('mirror.example'), calls[2].url);
  });

  await test('V8 并发请求同一个 hash 只回源一次', async () => {
    const { calls, fetchImpl } = upstreamStub(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return reply(PNG, { type: 'image/png' });
    });
    const cache = createAvatarCache({ dir: freshDir(), upstreams: ['https://up.example/avatar'], fetchImpl });
    const [a, b, c] = await Promise.all([cache.resolve(H1), cache.resolve(H1), cache.resolve(H1)]);
    assert.equal(calls.length, 1);
    for (const r of [a, b, c]) assert.ok(r.body.equals(PNG));
  });

  await test('V9 缓存过期但上游挂了：旧图继续用（stale），不把头像刷没', async () => {
    const dir = freshDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, H1), PNG);
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    fs.utimesSync(path.join(dir, H1), old, old);
    const cache = createAvatarCache({
      dir, upstreams: ['https://up.example/avatar'],
      fetchImpl: upstreamStub(() => { throw new Error('offline'); }).fetchImpl,
    });
    const got = await cache.resolve(H1);
    assert.ok(got.body.equals(PNG), '应该给旧图');
    assert.equal(got.maxAge, 600);
  });

  await test('V10 缓存超量时按最久未用淘汰', async () => {
    const dir = freshDir();
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 5; i++) {
      const file = path.join(dir, String(i).padStart(32, '0'));
      fs.writeFileSync(file, PNG);
      const t = new Date(Date.now() - (5 - i) * 3600 * 1000);
      fs.utimesSync(file, t, t);
    }
    const cache = createAvatarCache({ dir, upstreams: [], maxFiles: 3 });
    assert.equal(await cache.prune(), 2);
    assert.deepEqual(fs.readdirSync(dir).sort(), [String(2).padStart(32, '0'), String(3).padStart(32, '0'), String(4).padStart(32, '0')]);
  });

  await test('V11 路由：合法 md5 才响应，头部带自己的缓存策略，HEAD 不带 body', async () => {
    const { fetchImpl } = upstreamStub(() => reply(PNG, { type: 'image/png' }));
    const cache = createAvatarCache({ dir: freshDir(), upstreams: ['https://up.example/avatar'], fetchImpl });
    const app = new Hono({ strict: false });
    app.route('/', avatarRoutes(cache));

    const ok = await app.request(`/avatar/${H1}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'image/png');
    assert.match(ok.headers.get('cache-control'), /public, max-age=86400/);
    assert.equal((await ok.arrayBuffer()).byteLength, PNG.length);

    for (const bad of ['nothex', H1.slice(0, 31), 'g'.repeat(32), `${H1}x`, 'A'.repeat(32) + '..']) {
      assert.equal((await app.request(`/avatar/${bad}`)).status, 404, bad);
    }
    const upper = await app.request(`/avatar/${H1.toUpperCase()}`);
    assert.equal(upper.status, 200, '大小写不该影响结果');

    const head = await app.request(`/avatar/${H1}`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal((await head.text()).length, 0);
  });

  await test('V24 只给已审核评论出现过的 hash 回源，未知 hash 不回源', async () => {
    const { calls, fetchImpl } = upstreamStub(() => reply(PNG, { type: 'image/png' }));
    const cache = createAvatarCache({ dir: freshDir(), upstreams: ['https://up.example/avatar'], fetchImpl });
    const app = new Hono({ strict: false });
    app.route('/', avatarRoutes(cache, { isKnown: (h) => h === H1 }));
    assert.equal((await app.request(`/avatar/${H1}`)).status, 200);
    const before = calls.length;
    const unknown = await app.request(`/avatar/${H2}`);
    assert.equal(unknown.status, 200, '未知 hash 不能靠 404 暴露“邮箱没评论过”');
    assert.equal(unknown.headers.get('content-type'), 'image/png');
    assert.equal((await unknown.arrayBuffer()).byteLength, BLANK_PNG.length);
    assert.equal(calls.length, before, '未知 hash 不能触达上游');
  });

  await test('V12 路由：没配上游时也回合法图片（透明占位），不是碎图标', async () => {
    const cache = createAvatarCache({ dir: freshDir(), upstreams: [] });
    const app = new Hono({ strict: false });
    app.route('/', avatarRoutes(cache));
    const res = await app.request(`/avatar/${H1}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    assert.equal(meta.width, 1);
  });

  await test('V13 avatar()：合法 md5 出本站 img，非法/缺失只出字母头像', () => {
    const withImg = avatar('读者', 40, H1);
    assert.match(withImg, /class="avatar-wrap"/);
    assert.match(withImg, new RegExp(`<img class="avatar avatar-img" src="/avatar/${H1}"`));
    assert.match(withImg, /width="40" height="40"/);
    assert.match(withImg, /alt=""/);
    assert.ok(!/https?:\/\//.test(withImg), '页面里不该出现第三方地址');
    assert.match(withImg, /<svg class="avatar"/, '字母头像要打底');

    for (const bad of [null, '', 'nope', '<script>']) {
      const letter = avatar('读者', 40, bad);
      assert.ok(!letter.includes('<img'), String(bad));
      assert.match(letter, /<svg class="avatar"/);
    }
    // 字母头像的名称要转义
    assert.ok(!avatar('<b>x</b>', 40).includes('<b>'));
  });

  await test('V15 启动探测：记住连得通的上游，之后不再为连不通的那家等超时', async () => {
    const { calls, fetchImpl } = upstreamStub((url) => {
      if (url.includes('down.example')) throw new Error('ECONNREFUSED');
      if (url.includes('0'.repeat(32))) return reply('', { status: 404, type: 'text/plain' });
      return reply(PNG, { type: 'image/png' });
    });
    const cache = createAvatarCache({
      dir: freshDir(), upstreams: ['https://down.example/avatar', 'https://mirror.example/avatar'], fetchImpl,
    });
    assert.equal(await cache.probe(), 'https://mirror.example/avatar');
    const before = calls.length;
    const got = await cache.resolve(H1);
    assert.ok(got.body.equals(PNG));
    assert.equal(calls.length, before + 1, '探测之后取一张头像只该打一次上游');
    assert.ok(calls.at(-1).url.includes('mirror.example'), calls.at(-1).url);
  });

  await test('V16 探测还在飞时到达的请求先等探测结果，不各自去撞一次超时', async () => {
    const { calls, fetchImpl } = upstreamStub((url) => {
      if (url.includes('down.example')) return new Promise((_, rej) => setTimeout(() => rej(new Error('ECONNREFUSED')), 20));
      if (url.includes('0'.repeat(32))) return reply('', { status: 404, type: 'text/plain' });
      return reply(PNG, { type: 'image/png' });
    });
    const cache = createAvatarCache({
      dir: freshDir(), upstreams: ['https://down.example/avatar', 'https://mirror.example/avatar'], fetchImpl,
    });
    const probe = cache.probe();            // 故意不 await：模拟「启动探测还在飞」
    const got = await cache.resolve(H1);    assert.ok(got.body.equals(PNG));
    assert.equal(await probe, 'https://mirror.example/avatar');
    const hitDown = calls.filter((c) => c.url.includes('down.example')).length;
    assert.equal(hitDown, 1, `连不通的上游只该被撞一次（探测那次），实际 ${hitDown} 次`);
  });

  await test('V19 回源成功后按 transform 规范化，并把规范化后的字节落到缓存', async () => {
    const dir = freshDir();
    const small = await sharp(PNG).resize(2, 2).webp().toBuffer();
    const { calls, fetchImpl } = upstreamStub(() => reply(PNG, { type: 'image/png' }));
    const cache = createAvatarCache({
      dir, upstreams: ['https://up.example/avatar'], fetchImpl,
      transform: async () => ({ body: small, type: 'image/webp' }),
    });
    const one = await cache.resolve(H1);
    assert.equal(one.type, 'image/webp');
    assert.ok(one.body.equals(small));
    assert.ok(fs.readFileSync(path.join(dir, H1)).equals(small), '缓存里应是规范化后的图');
    const two = await cache.resolve(H1);
    assert.equal(two.type, 'image/webp');
    assert.equal(calls.length, 1);
  });

  await test('V20 规范化抛错时退回上游原图（不能因为 sharp 读不了就没有头像）', async () => {
    const { fetchImpl } = upstreamStub(() => reply(PNG, { type: 'image/png' }));
    const cache = createAvatarCache({
      dir: freshDir(), upstreams: ['https://up.example/avatar'], fetchImpl,
      transform: async () => { throw new Error('unsupported image format'); },
      log: () => {},
    });
    const got = await cache.resolve(H1);
    assert.equal(got.type, 'image/png');
    assert.ok(got.body.equals(PNG));
  });

  await test('V21 代理里的 normalizer 把大图压成小 WebP（上游可以回 50KB 的 PNG）', async () => {
    const { normalizeAvatar } = await import('../src/avatar/image.js');
    const big = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#3a7' } }).png().toBuffer();
    const out = await normalizeAvatar(big, 160);
    assert.equal(out.type, 'image/webp');
    const meta = await sharp(out.body).metadata();
    assert.equal(meta.format, 'webp');
    assert.equal(meta.width, 160);
    assert.equal(meta.height, 160);
    assert.ok(out.body.length < big.length / 4, `${big.length}B → ${out.body.length}B`);
  });

  await test('V23 头像默认尺寸 96px（覆盖 40px 显示尺寸的 2x 屏，别退回 160）', async () => {
    const { AVATAR_FETCH_SIZE } = await import('../src/config.js');
    assert.equal(AVATAR_FETCH_SIZE, 96);
    const { normalizeAvatar } = await import('../src/avatar/image.js');
    const big = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#3a7' } }).png().toBuffer();
    const out = await normalizeAvatar(big);
    const meta = await sharp(out.body).metadata();
    assert.equal(meta.width, 96);
    assert.equal(meta.height, 96);
  });

  await test('V14 反代不改 CSP：站点仍然只放行 img-src self/data', () => {
    const src = fs.readFileSync('server.js', 'utf8');
    assert.match(src, /"img-src 'self' data:"/);
    assert.ok(!/img-src[^;]*gravatar/.test(src), '别为了头像去放开第三方图片域');
  });
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

process.exitCode = report({ label: '头像反代' });
