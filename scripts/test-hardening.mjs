import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { JSDOM } from 'jsdom';
import sharp from 'sharp';
import { startServer } from './_server.mjs';
import { createChecker } from './_check.mjs';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-hardening-'));
process.env.DATA_DIR = path.join(work, 'data');
process.env.DB_FILE = path.join(work, 'data', 'blog.db');
process.env.CONTENT_DIR = path.join(work, 'content');
process.env.UPLOADS_DIR = path.join(work, 'uploads');
process.env.THEMES_DIR = path.join(work, 'themes');
process.env.BACKUP_ON_PUBLISH = 'false';
// 单独运行（不经 npm test 的 fixtures 继承）时也要断掉外网：定时抓取/检查与头像回源一律关闭，
// 否则会向真实站点发请求，产生 CI 复现不了的抖动。
process.env.FEED_REFRESH_MS = '0';
process.env.LINK_CHECK_MS = '0';
process.env.AVATAR_UPSTREAMS = '';
for (const sub of ['posts','notes']) fs.mkdirSync(path.join(process.env.CONTENT_DIR, sub), { recursive: true });
fs.mkdirSync(process.env.THEMES_DIR, { recursive: true });
const { open, close, migrate, createRepo, createAdminRepo, createCommentRepo, createCrypto } = await import('./_db-stack.mjs');
const { createAdminAuth, clearPassword, hashPassword } = await import('../src/admin/auth.js');
const { createRenderer } = await import('../src/render/markdown.js');
const { adminRoutes } = await import('../src/routes/admin.js');
const { commentRoutes } = await import('../src/routes/comments.js');
const { syncContent } = await import('../src/content/sync.js');
const { recoverWrites, deleteWithFiles } = await import('../src/content/commit.js');
const { snapshot, verifyBackup, restoreBackup, listBackups } = await import('../src/backup.js');
const { acquireMaintenanceLock } = await import('../src/util/lock.js');
const { normalizeImage } = await import('../src/media/image.js');
const { notesStream, splitImages } = await import('../src/render/notes.js');
const { editorPage } = await import('../src/admin/views/content.js');
const db = open(process.env.DB_FILE); migrate(db, { log() {} });
const repo = createRepo(db), adminRepo = createAdminRepo(db), comments = createCommentRepo(db), crypt = createCrypto(db);
repo.setSetting('admin_password_hash', hashPassword('isolated-test-only'));
const auth = createAdminAuth({ db, crypt }), renderer = createRenderer();
const app = adminRoutes({ repo, adminRepo, comments, crypt, auth, renderer });
const cp = commentRoutes({ repo, comments, crypt });
const csrf = 'review-csrf';const cookie = () => 'blog_admin=' + crypt.sign({ uid: 'owner', ep: Number(repo.getSetting('admin_session_epoch') ?? 0), csrf });
const post = (url, body, headers = {}) => app.request(url, { method: 'POST', headers: { Cookie: cookie(), 'x-csrf-token': csrf, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const input = { title: '审查测试', slug: 'review', kind: 'post', date: '2025-01-01', body: 'original', comments: '1' };
const save = async (extra = {}) => { const r = await post('/admin/api/autosave', { ...input, ...extra }); assert.equal(r.status,200,await r.clone().text()); return r.json(); };
const { test, report } = createChecker();
let saved;
try {
  await test('缺失子目录不修改索引，也不删除关联评论', async () => {
    saved = await save(); comments.add({ postId: saved.id, author:'reader', bodyMd:'keep', status:'approved' });
    const source = path.join(process.env.CONTENT_DIR,'posts'); fs.renameSync(source,source+'-missing');
    try { const out = syncContent(repo,{ quiet:true }); assert.ok(out.errors.length); assert.equal(repo.stats().total,1); assert.equal(comments.countOfPost(saved.id),1); }
    finally { fs.renameSync(source+'-missing',source); }
  });
  await test('文件移除只隔离文章，恢复文件后保留评论与修订', async () => {
    const p = adminRepo.get(saved.id), source = p.file_path;
    fs.renameSync(source,source+'.away');
    try { syncContent(repo,{quiet:true}); assert.equal(adminRepo.get(saved.id).missing_file,1); assert.equal(adminRepo.get(saved.id).draft,1); assert.equal(comments.countOfPost(saved.id),1); }
    finally { fs.renameSync(source+'.away',source); }
    syncContent(repo,{quiet:true}); assert.equal(adminRepo.get(saved.id).missing_file,0); assert.equal(adminRepo.get(saved.id).draft,0); assert.ok(adminRepo.revisions(saved.id).length);
  });
  await test('重复 slug 整批拒绝，原内容和版本不变', async () => {
    const duplicate = path.join(process.env.CONTENT_DIR,'notes','duplicate.md');
    fs.writeFileSync(duplicate,'---\nslug: review\ntitle: overwrite\ndate: 2025-01-02\n---\noverwrite');
    const before = adminRepo.get(saved.id);
    try { assert.ok(syncContent(repo,{quiet:true}).errors.some((e)=>e.includes('重复'))); assert.deepEqual(adminRepo.get(saved.id),before); }
    finally { fs.unlinkSync(duplicate); }
  });
  await test('过期版本和缺少版本均返回 409，不覆盖最新正文', async () => {
    const p = adminRepo.get(saved.id); await save({ id:p.id,version:p.version,body:'new' });
    const stale = await post('/admin/api/autosave',{...input,id:p.id,version:p.version,body:'stale'}); assert.equal(stale.status,409);
    assert.equal((await post('/admin/api/autosave',{...input,id:p.id,body:'missing version'})).status,409); assert.equal(adminRepo.get(p.id).body_md,'new');
    const form = await post('/admin/save',{...input,id:p.id,version:p.version,body:'local preserved'}); assert.equal(form.status,409); const html=await form.text(); assert.match(html,/local preserved/); assert.match(html,/data-conflict="1"/);
  });
  await test('数据库更新失败会恢复 Markdown 且不新增修订', async () => {
    const p=adminRepo.get(saved.id), original=fs.readFileSync(p.file_path), revisions=adminRepo.revisions(p.id).length;
    const update=repo.upsertFromFile; repo.upsertFromFile=()=>{throw new Error('injected database failure')};
    try { assert.equal((await post('/admin/api/autosave',{...input,id:p.id,version:p.version,body:'failed'})).status,500); }
    finally { repo.upsertFromFile=update; }
    assert.deepEqual(fs.readFileSync(p.file_path),original); assert.equal(adminRepo.revisions(p.id).length,revisions); assert.equal(adminRepo.get(p.id).body_md,p.body_md);
  });
  await test('文件移动失败阻止删除文章及评论', async () => {
    const p=adminRepo.get(saved.id), rename=fs.renameSync;
    fs.renameSync=(from,to)=>{if(from===p.file_path)throw new Error('injected EACCES');return rename(from,to)};
    try { const r=await post('/admin/delete/'+p.id,{}); assert.match(decodeURIComponent(r.headers.get('location')),/删除失败/); }
    finally { fs.renameSync=rename; }
    assert.ok(adminRepo.get(p.id)); assert.ok(fs.existsSync(p.file_path)); assert.equal(comments.countOfPost(p.id),1);
  });
  await test('缩略图与原图删除的数据库失败均可补偿', async () => {
    const a=path.join(process.env.UPLOADS_DIR,'a.png'),b=a+'.thumb.webp';fs.mkdirSync(process.env.UPLOADS_DIR,{recursive:true});fs.writeFileSync(a,'a');fs.writeFileSync(b,'b');
    assert.throws(()=>deleteWithFiles({repo,files:[{file:a,trash:a+'.trash'},{file:b,trash:b+'.trash'}],remove:()=>{throw new Error('DB error')}}),/DB error/);
    assert.equal(fs.readFileSync(a,'utf8'),'a');assert.equal(fs.readFileSync(b,'utf8'),'b');fs.unlinkSync(a);fs.unlinkSync(b);
  });
  await test('启动恢复未提交写入日志，已提交日志不回滚', async () => {
    const dir=path.join(process.env.DATA_DIR,'.write-journal');fs.mkdirSync(dir,{recursive:true});const p=adminRepo.get(saved.id),old=fs.readFileSync(p.file_path);
    fs.writeFileSync(p.file_path,'partial');fs.writeFileSync(path.join(dir,'pending.json'),JSON.stringify({key:'write_journal:pending',entries:[{file:p.file_path,data:old.toString('base64')}]}));recoverWrites(repo);assert.deepEqual(fs.readFileSync(p.file_path),old);
    repo.setSetting('write_journal:done','committed');fs.writeFileSync(path.join(dir,'done.json'),JSON.stringify({key:'write_journal:done',entries:[{file:p.file_path,data:null}]}));recoverWrites(repo);assert.ok(fs.existsSync(p.file_path));assert.equal(repo.getSetting('write_journal:done'),null);
  });
  await test('写日志损坏时启动不被挡住（隔离坏文件并继续恢复其余日志）', async () => {
    const dir = path.join(process.env.DATA_DIR, '.write-journal'); fs.mkdirSync(dir, { recursive: true });
    const p = adminRepo.get(saved.id), old = fs.readFileSync(p.file_path);
    // 一份被截断的日志：模拟写盘中途被 kill，正是「启动即崩」的触发条件
    fs.writeFileSync(path.join(dir, 'broken.json'), '{"key":"write_journal:broken","entr');
    // 同一目录里合法的那份必须照常恢复
    fs.writeFileSync(p.file_path, 'partial');
    fs.writeFileSync(path.join(dir, 'good.json'), JSON.stringify({ key: 'write_journal:good', entries: [{ file: p.file_path, data: old.toString('base64') }] }));
    const errors = [];
    const recovered = recoverWrites(repo, { log: { error: (m) => errors.push(String(m)) } });
    assert.equal(recovered, 1, '合法日志应被恢复');
    assert.deepEqual(fs.readFileSync(p.file_path), old);
    assert.ok(errors.some((e) => e.includes('journal.corrupt')), `应记录 journal.corrupt：${errors.join('|')}`);
    assert.ok(fs.readdirSync(dir).includes('broken.json.corrupt'), '坏日志应被隔离为 .corrupt，而不是原地留下继续崩');
    assert.ok(!fs.existsSync(path.join(dir, 'broken.json')));
    fs.rmSync(path.join(dir, 'broken.json.corrupt'), { force: true });
  });
  await test('写日志原子落盘：保存成功后不留半截文件', async () => {
    const dir = path.join(process.env.DATA_DIR, '.write-journal');
    const p = adminRepo.get(saved.id);
    await save({ id: p.id, version: p.version, title: 'atomic-write' });
    const left = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    assert.deepEqual(left, [], `写日志目录应为空，实际：${left.join(',')}`);
  });
  await test('评论限流不再泄漏到无关路径（子应用 use(\'*\') 的作用域）', async () => {
    const srv = await startServer({ isolateDb: true });
    try {
      const hit = (p) => fetch(srv.base + p, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', redirect: 'manual',
      });
      let limited = false;
      for (let i = 0; i < 70 && !limited; i++) limited = (await hit('/api/comments')).status === 429;
      assert.ok(limited, '评论端点应在配额用尽后返回 429');
      // 配额已经耗尽：如果限流器被 app.route() 提升成全局中间件，无关路径也会拿到 429
      const unrelated = await hit('/definitely-not-a-route');
      assert.equal(unrelated.status, 404, `无关路径被评论限流拦住了：${unrelated.status}`);
    } finally { await srv.stop(); }
  });
  await test('CSP 覆盖全部内联脚本，且 /healthz 可用于监控', async () => {
    const srv = await startServer({ isolateDb: true });
    try {
      const hashOf = (src) => `'sha256-${crypto.createHash('sha256').update(src, 'utf8').digest('base64')}'`;
      const home = await fetch(srv.base + '/');
      const csp = home.headers.get('content-security-policy') ?? '';
      assert.ok(csp.includes("default-src 'self'"), csp);
      // script-src 绝不能放开 unsafe-inline，否则内联白名单就没意义了
      assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), `script-src 不应含 unsafe-inline：${csp}`);
      const inline = [...(await home.text()).matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
      assert.ok(inline.length >= 1, '首页应有内联的主题引导脚本');
      for (const src of inline) assert.ok(csp.includes(hashOf(src)), `首页内联脚本未被 CSP 覆盖：${src.slice(0, 30)}`);
      const admin = await fetch(srv.base + '/admin/login');
      const acsp = admin.headers.get('content-security-policy') ?? '';
      for (const m of (await admin.text()).matchAll(/<script>([\s\S]*?)<\/script>/g)) {
        assert.ok(acsp.includes(hashOf(m[1])), '后台内联脚本未被 CSP 覆盖');
      }
      const health = await fetch(srv.base + '/healthz');
      assert.equal(health.status, 200);
      const body = await health.json();
      assert.equal(body.ok, true);
      assert.equal(typeof body.uptimeSec, 'number');
    } finally { await srv.stop(); }
  });
  await test('损坏 front matter 可重新保存，原文件留副本', async () => {
    const p=adminRepo.get(saved.id);fs.writeFileSync(p.file_path,'---\ntitle: [\n---\nbroken');await save({id:p.id,version:p.version});assert.ok(fs.readdirSync(path.join(process.env.CONTENT_DIR,'.trash')).some((f)=>f.startsWith('front-')));assert.deepEqual(syncContent(repo,{quiet:true}).errors,[]);
  });
  await test('仅邮箱相同、昵称不同仍待审核', async () => {
    const p=adminRepo.get(saved.id);comments.add({postId:p.id,author:'real',bodyMd:'real',status:'approved',emailHash:crypt.fingerprint('known@example.com')});
    const r=await cp.request('/api/comments',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slug:p.slug,author:'fake',email:'known@example.com',body:'fake',ts:crypt.sign({purpose:'comment-ts',ts:Date.now()-4000,p:p.id})})});assert.equal((await r.json()).status,'pending');
  });
  await test('审核凭证有用途、随机 nonce 和会话代数约束', async () => {
    const c=comments.ofPost(saved.id)[0], ep=Number(repo.getSetting('admin_session_epoch')??0);
    const token=crypt.sign({purpose:'moderation',c:c.id,nonce:c.moderation_nonce,ep});assert.equal((await cp.request('/moderate/'+token)).status,200);
    const wrong=crypt.sign({c:c.id,nonce:c.moderation_nonce,ep});assert.equal((await cp.request('/moderate/'+wrong)).status,400);
    db.prepare('UPDATE comments SET moderation_nonce=? WHERE id=?').run('rotated',c.id);assert.equal((await cp.request('/moderate/'+token)).status,400);
  });
  await test('清除密码立即拒绝旧会话且增加代数', async () => {
    const oldCookie=cookie(), before=Number(repo.getSetting('admin_session_epoch')??0);clearPassword(db);assert.equal(Number(repo.getSetting('admin_session_epoch')),before+1);
    const r=await app.request('/admin',{headers:{Cookie:oldCookie}});assert.equal(r.status,303);repo.setSetting('admin_password_hash',hashPassword('isolated-test-only'));
  });
  await test('流式请求即使谎报 Content-Length 也在解析前返回 413', async () => {
    const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(40000));c.close()}});
    const r=await cp.request(new Request('http://localhost/api/comments',{method:'POST',headers:{'Content-Type':'application/json','Content-Length':'1'},body:stream,duplex:'half'}));assert.equal(r.status,413);
  });
  await test('多字节伪造 CSRF 返回 403 而非 timingSafeEqual 异常', async () => {
    const r=await app.request('/admin/settings',{method:'POST',headers:{Cookie:cookie(),'Content-Type':'application/json'},body:JSON.stringify({_csrf:'中'.repeat(csrf.length)})});assert.equal(r.status,403);
  });
  await test('真实解码拒绝损坏图片，方向校正并移除 EXIF', async () => {
    await assert.rejects(normalizeImage(Buffer.from('89504e470d0a1a0a0000000000000000','hex')));
    const raw=await sharp({create:{width:20,height:10,channels:3,background:'red'}}).jpeg().withMetadata({orientation:6}).toBuffer();const out=await normalizeImage(raw);assert.equal(out.width,10);assert.equal(out.height,20);assert.equal((await sharp(out.buffer).metadata()).exif,undefined);assert.equal((await sharp(out.thumbnail).metadata()).format,'webp');
  });
  await test('带参数图片地址及替代文字只转义一次', async () => {
    const images=splitImages(renderer.render('![a & b](https://example.com/a.png?x=1&y=2)').html).images;
    const dom=new JSDOM(notesStream([{slug:'n',title:'n',text:'',images:images.map(im=>({...im,thumb:'/uploads/preview.webp?x=1&y=2'})),commentsOn:false}]));try{const image=dom.window.document.querySelector('img');assert.equal(image.getAttribute('src'),'/uploads/preview.webp?x=1&y=2');assert.equal(dom.window.document.querySelector('[data-full]').getAttribute('data-full'),'https://example.com/a.png?x=1&y=2');assert.equal(image.alt,'a & b')}finally{dom.window.close()}
  });
  await test('媒体分页可以读取第 121 个记录并按路径独立查找', async () => {
    for(let i=0;i<125;i++)adminRepo.mediaAdd({path:`/uploads/fixture-${i}.png`,filename:`fixture-${i}.png`});
    const first=await(await app.request('/admin/api/media?page=1',{headers:{Cookie:cookie()}})).json();const third=await(await app.request('/admin/api/media?page=3',{headers:{Cookie:cookie()}})).json();assert.equal(first.items.length,60);assert.equal(third.items.length,5);assert.ok(adminRepo.mediaByPath('/uploads/fixture-0.png'));db.prepare("DELETE FROM media WHERE path LIKE '/uploads/fixture-%'").run();
  });
  await test('media.hash 并发重复写入被数据库拒绝', async () => {
    const a = adminRepo.mediaAdd({ path: '/uploads/dup-hash-a.png', hash: 'dup-hash' });
    try {
      assert.throws(() => adminRepo.mediaAdd({ path: '/uploads/dup-hash-b.png', hash: 'dup-hash' }), /已存在/);
      assert.equal(adminRepo.mediaByHash('dup-hash').id, a);
    } finally {
      db.prepare("DELETE FROM media WHERE hash = 'dup-hash'").run();
    }
  });
  await test('备份流式生成完整归档；损坏清单不影响其余备份', async () => {
    const dir=path.join(work,'backups');const snap=await snapshot(db,{dir});const name=path.basename(snap.gzFile).replace('.db.gz','');const verified=verifyBackup(name,{dir,workDir:path.join(work,'verify')});assert.equal(verified.ok,true);assert.ok(verified.bundle.content.length);
    assert.throws(()=>restoreBackup(verified,{dbFile:process.env.DB_FILE}),/关闭/);
    fs.writeFileSync(path.join(dir,'blog-broken.db.gz'),'bad');fs.writeFileSync(path.join(dir,'blog-broken.json'),'{broken');assert.equal(listBackups(dir).length,1);assert.equal(verifyBackup('blog-broken',{dir}).ok,false);
    const target={dbFile:path.join(work,'restored','db'),contentDir:path.join(work,'restored','content'),uploadsDir:path.join(work,'restored','uploads')};restoreBackup(verified,target);const fresh=open(target.dbFile);try{assert.equal(createRepo(fresh).getPost('review').title,input.title)}finally{close(fresh)}
  });
  await test('维护锁跨进程阻止在线恢复和共享内容并发操作', async () => {
    const release=acquireMaintenanceLock([process.env.DB_FILE,process.env.CONTENT_DIR,process.env.UPLOADS_DIR],'fixture-server');
    try{const out=spawnSync(process.execPath,['scripts/restore.mjs','--yes'],{env:process.env,encoding:'utf8',timeout:10000});assert.notEqual(out.status,0);assert.match(out.stderr,/正在使用/);assert.throws(()=>acquireMaintenanceLock([path.join(work,'other.db'),process.env.CONTENT_DIR]),/占用/)}finally{release()}
  });
  await test('维护锁识别 PID 复用：活着但启动时间对不上就当陈旧锁回收', async () => {
    const resource = path.join(work, 'pid-reuse.db');
    const dir = `${resource}.blog-lock`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: 0, token: 'stale', label: 'stale-owner' }));
    const release = acquireMaintenanceLock([resource], 'new-owner');
    release();
    assert.equal(fs.existsSync(dir), false, '应完成回收并清理锁目录');
  });
  await test('维护锁会清理上次恢复留下的陈旧 .reclaim，不会永久卡住启动', async () => {
    const resource = path.join(work, 'stale-reclaim.db');
    const dir = `${resource}.blog-lock`, reclaim = `${dir}.reclaim`;
    const old = new Date(Date.now() - 60 * 60 * 1000);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: 999999, startedAt: Date.now() - 999999, token: 'dead', label: 'dead' }));
    fs.utimesSync(dir, old, old);
    fs.mkdirSync(reclaim, { recursive: true });
    fs.utimesSync(reclaim, old, old);
    const release = acquireMaintenanceLock([resource], 'after-crash');
    release();
    assert.equal(fs.existsSync(dir), false);
    assert.equal(fs.existsSync(reclaim), false);
  });
  await test('密钥文件写不进去时保留数据库里的旧密钥，重启后仍能解密', async () => {
    const keyDbFile = path.join(work, 'secret-db.sqlite');
    const keyDir = path.join(work, 'secret-unwritable');
    const secretFile = path.join(keyDir, '.app-secret');
    const envSecret = process.env.APP_SECRET;
    process.env.APP_SECRET = '';
    fs.mkdirSync(keyDir, { recursive: true, mode: 0o500 });
    try {
      const keyDb = open(keyDbFile);
      keyDb.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      keyDb.prepare('INSERT INTO settings(key, value) VALUES(?,?)').run('app_secret', 'legacy-key-123');
      const first = createCrypto(keyDb, { secretFile });
      const blob = first.encrypt('reader@example.com');
      assert.equal(keyDb.prepare("SELECT value FROM settings WHERE key='app_secret'").get().value, 'legacy-key-123');
      close(keyDb);

      fs.chmodSync(keyDir, 0o700);
      const reopened = open(keyDbFile);
      try {
        const second = createCrypto(reopened, { secretFile });
        assert.equal(second.decrypt(blob), 'reader@example.com');
      } finally { close(reopened); }
    } finally {
      process.env.APP_SECRET = envSecret ?? '';
      fs.chmodSync(keyDir, 0o700);
    }
  });
  await test('评论行内回复框能就地展开收起（后端还加载了 nav.js，也不能被它抢走点击）', async () => {
    const html = `<!doctype html><html><body><div id="app"><table><tbody>
      <tr><td><a class="a-link" href="/admin/comments/7/reply" data-reply-toggle data-no-pjax aria-expanded="false" aria-controls="reply-row-pending-7">回复</a></td></tr>
      <tr class="a-reply-row" id="reply-row-pending-7" hidden><td><form class="a-reply-form" method="post" action="/admin/comments/7/reply">
        <textarea name="body"></textarea><button type="button" data-reply-cancel="7">取消</button>
      </form></td></tr>
    </tbody></table></div></body></html>`;
    const dom = new JSDOM(html, { url: 'http://localhost/admin/comments', runScripts: 'outside-only' });
    const w = dom.window;
    let fetched = 0;
    w.fetch = async () => { fetched++; return { ok: true, text: async () => '', json: async () => ({}), headers: { get: () => '' } }; };
    w.scrollTo = () => {};
    try {
      // 真实后台页面顺序：request.js → ui.js → nav.js → admin.js。
      w.eval(fs.readFileSync('public/request.js', 'utf8'));
      w.eval(fs.readFileSync('public/ui.js', 'utf8'));
      w.eval(fs.readFileSync('public/nav.js', 'utf8'));
      w.eval(fs.readFileSync('public/admin-editor.js', 'utf8'));w.eval(fs.readFileSync('public/admin.js', 'utf8'));
      const link = w.document.querySelector('[data-reply-toggle]');
      const row = w.document.querySelector('.a-reply-row');
      assert.equal(row.hidden, true, '默认应折叠');
      link.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
      assert.equal(row.hidden, false, '点击后展开');
      assert.equal(fetched, 0, '不应被 nav.js 抢走并整页/无刷新跳转（data-no-pjax 必须生效）');
      assert.equal(link.getAttribute('aria-expanded'), 'true');
      assert.equal(w.document.activeElement?.name, 'body', '展开后应聚焦输入框');
      w.document.querySelector('[data-reply-cancel]').dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
      assert.equal(row.hidden, true, '取消后收起');
      assert.equal(link.getAttribute('aria-expanded'), 'false');
      link.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
      w.document.querySelector('textarea').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      assert.equal(row.hidden, true, 'Esc 也应收起');
    } finally { w.close() }
  });
  await test('笔记弹窗提交目标取自表单，失败保留输入并允许重试', async () => {
    const {commentSection}=await import('../src/comments/view.js');const dom=new JSDOM(commentSection({post:{id:9,slug:'note-a',kind:'note',comments_on:1},thread:[],count:0,flash:'',tsToken:'token'}),{url:'http://localhost/notes/',runScripts:'outside-only'});const w=dom.window;let payload;
    w.matchMedia=()=>({matches:false});w.fetch=async(_url,opts)=>{payload=JSON.parse(opts.body);return{json:async()=>({ok:false,error:'try again'})}};
    try{w.eval(fs.readFileSync('public/ui.js', 'utf8'));w.eval(fs.readFileSync('public/request.js', 'utf8'));w.eval(fs.readFileSync('public/app.js','utf8'));const form=w.document.querySelector('form');form.querySelector('[name=author]').value='reader';form.querySelector('[name=email]').value='reader@example.com';form.querySelector('[name=body]').value='local';form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setImmediate(r));assert.equal(payload.slug,'note-a');assert.equal(form.querySelector('[name=body]').value,'local');assert.equal(form.querySelector('button').disabled,false);assert.match(form.textContent,/try again/)}finally{w.close()}
  });
  await test('评论局部刷新保留 id 后缀（同页第二个评论区的 label 不会指到别人家）', async () => {
    // 笔记流一页有多个评论区，服务端给它们内部 id 加 `-<slug>` 后缀；而 `?partial=comments` 回刷的是单独渲染、不带后缀的那份。
    // 照搬会与其他评论区撞 id —— `<label for="c-author">` 会聚焦别人家的框。
    const { commentSection } = await import('../src/comments/view.js');
    const args = (slug) => ({
      post: { id: 9, slug, kind: 'note', comments_on: 1 },
      thread: [], count: 0, flash: '', tsToken: 't',
      replyBase: `/n/${slug}/`, idSuffix: `-${slug}`,
    });
    const dom = new JSDOM(
      `<div id="app"><dialog>${commentSection(args('note-a'))}</dialog><dialog>${commentSection(args('note-b'))}</dialog></div>`,
      { url: 'http://localhost/notes/', runScripts: 'outside-only' });
    const w = dom.window;
    w.matchMedia = () => ({ matches: false });
    // partial 那一份故意按真实行为渲染成**无后缀**
    w.fetch = async (url) => (String(url).includes('/api/comments')
      ? { json: async () => ({ ok: true, status: 'approved', count: 1 }) }
      : { ok: true, text: async () => commentSection({ ...args('note-a'), idSuffix: '' }) });
    try {
      w.eval(fs.readFileSync('public/ui.js', 'utf8'));w.eval(fs.readFileSync('public/request.js', 'utf8'));w.eval(fs.readFileSync('public/app.js', 'utf8'));
      const form = w.document.querySelector('#comments-note-a .c-form');
      assert.ok(form, '第一个笔记的评论区应带 -note-a 后缀');
      form.querySelector('[name=author]').value = '读者甲';
      form.querySelector('[name=email]').value = 'a@example.com';
      form.querySelector('[name=body]').value = '顶';
      form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 20));

      const ids = [...w.document.querySelectorAll('[id]')].map((el) => el.id);
      assert.equal(new Set(ids).size, ids.length, `同页 id 不应重复：${ids.join(', ')}`);

      const a = w.document.getElementById('comments-note-a');
      assert.ok(a, '替换后仍应是原来那一节（id 不变）');
      assert.equal(w.document.getElementById('c-author'), null, '不能再冒出一个无后缀的 c-author');
      const author = a.querySelector('#c-author-note-a');
      assert.ok(author, '内部 id 要补回后缀');
      assert.equal(a.querySelector('label[for="c-author-note-a"]')?.getAttribute('for'), 'c-author-note-a',
        'label 的 for 必须跟着改，否则点了聚焦不到');
      assert.equal(w.document.getElementById('comments-note-b').querySelector('#reply-note-b')?.id, 'reply-note-b',
        '另一个笔记的评论区不受影响');
      assert.equal(a.querySelector('form').dataset.slug, 'note-a');
    } finally { w.close() }
  });
  await test('禁 JS 时正文图不是假按钮：可交互语义由 app.js 补', async () => {
    const html = '<div id="app"><div class="prose">'
      + '<img src="/uploads/x.png" alt="图" data-lightbox="p-a" data-full="/uploads/x.png" data-alt="图">'
      + '</div></div>';
    const dom = new JSDOM(html, { url: 'http://localhost/p/a/', runScripts: 'outside-only' });
    const w = dom.window;
    w.matchMedia = () => ({ matches: false });
    const img = w.document.querySelector('img');
    // 服务端只写数据，不写 role/tabindex/aria-label（这行断言在脚本跑之前）
    assert.equal(img.getAttribute('role'), null, '渲染出来时不该是按钮');
    assert.equal(img.getAttribute('tabindex'), null, '渲染出来时不该能 Tab 进去');
    assert.equal(img.getAttribute('aria-label'), null);
    try {
      w.eval(fs.readFileSync('public/ui.js', 'utf8'));w.eval(fs.readFileSync('public/request.js', 'utf8'));w.eval(fs.readFileSync('public/app.js', 'utf8'));
      assert.equal(img.getAttribute('role'), 'button');
      assert.equal(img.getAttribute('tabindex'), '0');
      assert.equal(img.getAttribute('aria-label'), '查看大图：图');
      // 笔记图集是真链接（<a href=大图>），本来就可聚焦，不该被念成按钮
      const a = w.document.createElement('a');
      a.setAttribute('href', '/uploads/x.png');
      a.setAttribute('data-lightbox', 'p-a');
      w.document.getElementById('app').append(a);
      w.__pjaxHooks.forEach((fn) => fn());
      assert.equal(a.getAttribute('role'), null, '真链接不该被补成按钮');
    } finally { w.close() }
  });
  await test('前台回复评论有「取消回复」，取消后清 parent 且不动已写内容', async () => {
    const { commentSection } = await import('../src/comments/view.js');
    const post = { id: 9, slug: 'note-a', kind: 'note', comments_on: 1 };
    const thread = [{ id: 41, parent_id: null, author: '读者甲', body_md: '顶', created_at: '2026-01-01T00:00:00Z', is_author: 0, replies: [] }];
    const args = { post, thread, count: 1, flash: '', tsToken: 't', replyBase: '/n/note-a/' };

    // 1) 普通模式：落款空、取消键收起，href 兜底到不带 ?reply 的同一页。
    const plain = commentSection(args);
    assert.match(plain, /data-reply-title><\/span>/);
    assert.ok(!plain.includes('写一条评论'), '默认态不该再输出「写一条评论」');
    assert.match(plain, /data-cancel-reply[^>]*\shidden>/);
    assert.match(plain, /href="\/n\/note-a\/#comments"/);

    // 2) 回复模式：文章页 ?reply=<id> 走的就是这条渲染路径
    const replying = commentSection({ ...args, replyTo: thread[0] });
    assert.match(replying, /data-reply-title>回复 读者甲</);
    assert.ok(!/data-cancel-reply[^>]*\shidden/.test(replying), '回复模式下「取消回复」必须可见');
    assert.match(replying, /name="parent" value="41"/);

    // 3) 前端行为：取消 → parent 清空、标题复位、按钮收起，且不碰用户已写的内容
    const dom = new JSDOM(replying, { url: 'http://localhost/n/note-a/', runScripts: 'outside-only' });
    const w = dom.window;
    w.matchMedia = () => ({ matches: false });
    try {
      w.eval(fs.readFileSync('public/ui.js', 'utf8'));w.eval(fs.readFileSync('public/request.js', 'utf8'));w.eval(fs.readFileSync('public/app.js', 'utf8'));
      const form = w.document.querySelector('.c-form');
      const body = form.querySelector('textarea[name="body"]');
      body.value = '写了一半的回复';
      form.querySelector('[data-cancel-reply]').dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
      assert.equal(form.querySelector('input[data-parent]').value, '', '取消后 parent 应清空（否则会当成回复提交）');
      assert.equal(form.querySelector('[data-reply-title]').textContent, '');
      assert.equal(form.querySelector('[data-cancel-reply]').hasAttribute('hidden'), true);
      assert.equal(body.value, '写了一半的回复', '取消回复不能清掉用户已经写的内容');
    } finally { w.close() }

    // 4) 笔记页弹窗路径：点评论下的「回复」→ 标题改写、取消露出；再取消回到普通模式
    const dom2 = new JSDOM(`<div id="app"><dialog>${plain}</dialog></div>`, { url: 'http://localhost/notes/', runScripts: 'outside-only' });
    const w2 = dom2.window;
    w2.matchMedia = () => ({ matches: false });
    try {
      w2.eval(fs.readFileSync('public/ui.js', 'utf8'));w2.eval(fs.readFileSync('public/request.js', 'utf8'));w2.eval(fs.readFileSync('public/app.js', 'utf8'));
      const form = w2.document.querySelector('.c-form');
      const click = (el) => el.dispatchEvent(new w2.MouseEvent('click', { bubbles: true, cancelable: true }));
      click(w2.document.querySelector('.c-list [data-reply]'));
      assert.equal(form.querySelector('input[data-parent]').value, '41');
      assert.equal(form.querySelector('[data-reply-title]').textContent, '回复 读者甲');
      assert.equal(form.querySelector('[data-cancel-reply]').hasAttribute('hidden'), false, '点「回复」后必须露出取消按钮');
      click(form.querySelector('[data-cancel-reply]'));
      assert.equal(form.querySelector('input[data-parent]').value, '');
      assert.equal(form.querySelector('[data-reply-title]').textContent, '');
      assert.equal(form.querySelector('[data-cancel-reply]').hasAttribute('hidden'), true);
    } finally { w2.close() }
  });
  await test('前台回复：文章页就地切换，回复→取消→再回复不会失效（原 pjax 死路）', async () => {
    const { commentSection } = await import('../src/comments/view.js');
    const post = { id: 9, slug: 'note-a', kind: 'post', comments_on: 1 };
    const thread = [{ id: 41, parent_id: null, author: '读者甲', body_md: '顶', created_at: '2026-01-01T00:00:00Z', is_author: 0, replies: [] }];
    // 文章页形态：评论区直接挂在页面里，**没有 <dialog>**（这正是原来失效的那条路径）
    const dom = new JSDOM(`<div id="app">${commentSection({ post, thread, count: 1, flash: '', tsToken: 't', replyBase: '/p/note-a/' })}</div>`,
      { url: 'http://localhost/p/note-a/', runScripts: 'outside-only' });
    const w = dom.window;
    w.matchMedia = () => ({ matches: false });
    try {
      w.eval(fs.readFileSync('public/ui.js', 'utf8'));w.eval(fs.readFileSync('public/request.js', 'utf8'));w.eval(fs.readFileSync('public/app.js', 'utf8'));
      const form = w.document.querySelector('.c-form');
      const link = w.document.querySelector('.c-list [data-reply]');
      const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
      const state = () => [
        form.querySelector('input[data-parent]').value,
        form.querySelector('[data-reply-title]').textContent,
        form.querySelector('[data-cancel-reply]').hasAttribute('hidden'),
      ];

      click(link);
      assert.deepEqual(state(), ['41', '回复 读者甲', false], '点「回复」应进入回复模式');
      click(form.querySelector('[data-cancel-reply]'));
      assert.deepEqual(state(), ['', '', true], '点「取消回复」应退回普通模式（落款清空）');
      // 关键回归：地址栏没有变（就地切换），再点同一个「回复」必须仍然生效
      click(link);
      assert.deepEqual(state(), ['41', '回复 读者甲', false], '取消之后再次点击「回复」必须仍然生效');
      assert.equal(w.location.search, '', '就地切换不该改动地址栏');
    } finally { w.close() }
  });
  await test('历史导航也执行 dirty guard，取消后 DOM 与地址不变', async () => {
    const dom=new JSDOM('<div id="app">editor</div>',{url:'http://localhost/admin/edit/1',runScripts:'outside-only'});const w=dom.window;let hits=0;w.scrollTo=()=>{};w.__beforeNavigate=()=>{hits++;return false};w.fetch=async()=>{throw new Error('should not fetch')};
    try{w.eval(fs.readFileSync('public/ui.js','utf8'));w.eval(fs.readFileSync('public/nav.js','utf8'));w.history.pushState({},'','/admin');w.dispatchEvent(new w.PopStateEvent('popstate',{state:{}}));await new Promise(r=>setImmediate(r));assert.equal(hits,1);assert.equal(w.document.getElementById('app').textContent,'editor');assert.equal(w.location.pathname,'/admin/edit/1')}finally{w.close()}
  });
  await test('旧导航响应不会覆盖最新导航，元数据随页面更新', async () => {
    const dom=new JSDOM('<head><meta name="description" content="old"></head><div id="app">old</div>',{url:'http://localhost/',runScripts:'outside-only'});const w=dom.window;const requests=[];w.scrollTo=()=>{};w.fetch=()=>new Promise(resolve=>requests.push(resolve));
    try{w.eval(fs.readFileSync('public/ui.js','utf8'));w.eval(fs.readFileSync('public/nav.js','utf8'));const a=w.__nav.navigate('http://localhost/a');const b=w.__nav.navigate('http://localhost/b');const response=(value)=>({ok:true,headers:{get:()=> 'text/html'},text:async()=>`<head><meta name="description" content="${value}"></head><div id="app">${value}</div>`});requests[1](response('new'));await b;requests[0](response('stale'));await a;assert.equal(w.document.getElementById('app').textContent,'new');assert.equal(w.document.querySelector('meta[name=description]').content,'new')}finally{w.close()}
  });
  await test('手动保存等待提交事件退出后再提交，保留提交按钮', async () => {
    const p=adminRepo.get(saved.id);const dom=new JSDOM(editorPage({post:p,csrf,aliases:[],revisions:[],badges:{}}),{url:'http://localhost/admin/edit/'+p.id,runScripts:'outside-only'});const w=dom.window;let dispatching=true, submitted=null, deferred;w.setTimeout=fn=>{deferred=fn;return 1};
    const form=w.document.getElementById('editorForm');const button=form.querySelector('[value=save]');
    form.requestSubmit=btn=>{assert.equal(dispatching,false);submitted=btn};
    try{w.eval(fs.readFileSync('public/request.js', 'utf8'));w.eval(fs.readFileSync('public/admin-editor.js', 'utf8'));w.eval(fs.readFileSync('public/admin.js','utf8'));form.dispatchEvent(new w.SubmitEvent('submit',{bubbles:true,cancelable:true,submitter:button}));await new Promise(r=>setImmediate(r));assert.equal(submitted,null);dispatching=false;assert.ok(deferred);deferred();assert.equal(submitted,button)}finally{w.close()}
  });
  await test('编辑器 409 停止自动重试并提供版本比较入口', async () => {
    const p=adminRepo.get(saved.id);const dom=new JSDOM(editorPage({post:p,csrf,aliases:[],revisions:[],badges:{}}),{url:'http://localhost/admin/edit/'+p.id,runScripts:'outside-only'});const w=dom.window;const timers=new Map();let id=0;w.setTimeout=fn=>{timers.set(++id,fn);return id};w.clearTimeout=n=>timers.delete(n);w.confirm=()=>false;
    w.fetch=async(url)=>url.includes('/post/')?{json:async()=>({ok:true,post:{version:p.version+1,body_md:'latest'}})}:{status:409,json:async()=>({ok:false,error:'conflict'})};
    try{w.eval(fs.readFileSync('public/request.js', 'utf8'));w.eval(fs.readFileSync('public/admin-editor.js', 'utf8'));w.eval(fs.readFileSync('public/admin.js','utf8'));const body=w.document.querySelector('[name=body]');body.value='mine';body.dispatchEvent(new w.Event('input',{bubbles:true}));// 一次 input 排两个定时器：草稿（节流 500ms）与自动保存（去抖 3s）。全跑掉；草稿不发请求。
    for(const [n,fn] of [...timers]){timers.delete(n);fn()}await new Promise(r=>setImmediate(r));assert.equal(timers.size,0);assert.equal(w.__beforeNavigate(),false);assert.equal(w.document.querySelector('[data-conflict] textarea').value,'latest');assert.equal(body.value,'mine')}finally{w.close()}
  });
await test('多篇文章所在分区被清空、其它分区仍有文件时，不误判为作者删光文章', () => {
  const postsDir = path.join(process.env.CONTENT_DIR, 'posts');
  const notesDir = path.join(process.env.CONTENT_DIR, 'notes');
  const extra = path.join(postsDir, 'guard-extra.md');
  const note = path.join(notesDir, 'guard-note.md');
  fs.mkdirSync(postsDir, { recursive: true }); fs.mkdirSync(notesDir, { recursive: true });
  fs.writeFileSync(extra, '---\ntitle: 保护测试二\nslug: guard-extra\ndate: 2025-01-03\n---\n正文\n');
  fs.writeFileSync(note, '---\ntitle: 保护测试笔记\nslug: guard-note\ndate: 2025-01-04\n---\n正文\n');
  syncContent(repo, { quiet: true });
  const rows = repo.fileRows().filter((row) => row.kind === 'post');
  assert.ok(rows.length >= 2, `需要至少两篇文章才能测分区保护，实际 ${rows.length}`);
  for (const row of rows) fs.renameSync(row.file_path, row.file_path + '.guard-away');
  try {
    const out = syncContent(repo, { quiet: true });
    assert.ok(out.errors.some((e) => e.includes('posts 目录为空')), out.errors.join('|'));
    for (const row of rows) assert.equal(repo.getPostMeta(row.slug).missing_file, 0, row.slug);
  } finally {
    for (const row of rows) fs.renameSync(row.file_path + '.guard-away', row.file_path);
    fs.rmSync(extra, { force: true }); fs.rmSync(note, { force: true });
    syncContent(repo, { quiet: true });
  }
});

} finally { close(db); fs.rmSync(work,{recursive:true,force:true}); }
// 下面两组**不碰** db 与 work（只断言渲染器输出与源码文本），放在 finally 清理之后是安全的。
// 将来若有人往这段后面加「要读库/读文件」的用例，必须把它挪回 try 里面。
// 正文图片回填宽高 + 响应式候选：少这一下图片加载完才撑开高度（CLS），或 480px 的位置去下 2400px 原图
await test('T13a 渲染器按 media 尺寸回填 width/height', () => {
  const r = createRenderer({ imageInfo: (src) => (src === '/uploads/x.png' ? { width: 2400, height: 1520 } : null) });
  const { html } = r.render('![图](/uploads/x.png)');
  assert.match(html, /width="2400"/);
  assert.match(html, /height="1520"/);
});

await test('T13b 查不到尺寸时不编造属性', () => {
  const r = createRenderer({ imageInfo: () => null });
  const { html } = r.render('![图](/uploads/nope.png)');
  assert.ok(!/width=/.test(html), html);
});

await test('T13c 未传 imageInfo 时行为不变（旧调用点不受影响）', () => {
  const { html } = createRenderer().render('![图](/uploads/x.png)');
  assert.ok(!/width=/.test(html), html);
});

await test('T13e 有响应式变体时输出 srcset 与 sizes', () => {
  const info = {
    width: 2400, height: 1520,
    preview: '/uploads/x.png.v3-w960.webp',
    srcset: '/uploads/x.png.v3-w640.webp 640w, /uploads/x.png.v3-w1280.webp 1280w',
    sizes: '(min-width: 784px) 736px, 100vw',
  };
  const { html } = createRenderer({ imageInfo: () => info }).render('![图](/uploads/x.png)');
  assert.match(html, /srcset="\/uploads\/x\.png\.v3-w640\.webp 640w, \/uploads\/x\.png\.v3-w1280\.webp 1280w"/);
  assert.match(html, /sizes="\(min-width: 784px\) 736px, 100vw"/);
});

await test('T13f 只有尺寸、没有变体时不写空 srcset', () => {
  const { html } = createRenderer({ imageInfo: () => ({ width: 800, height: 450, srcset: '' }) }).render('![图](/uploads/y.png)');
  assert.match(html, /width="800"/);
  assert.ok(!/srcset/.test(html), html);
});

await test('T13g 文章列表不再出缩略图（编年轨只留文字）', async () => {
  const { listBlock } = await import('../src/render/layout.js');
  const row = {
    day: '2026-01-01', kind: 'post', slug: 'x', title: 'T',
    published_at: '2026-01-01T00:00:00Z', comments: 0, body_head: '',
  };
  // 文章列表走「编年」方案：轨上只留文字、缩略图整条撤掉 —— 传了 mediaOf 也不该再出图。
  const withMedia = listBlock([row], { mediaOf: () => ({ thumbnail: '/uploads/a/b.png.thumb.webp', width: 2400, height: 1520 }) });
  assert.ok(!/class="thumb"/.test(withMedia) && !withMedia.includes('.thumb.webp') && !withMedia.includes('has-thumb'), withMedia);
  assert.ok(withMedia.includes('class="e-main"'), withMedia);
  assert.ok(!listBlock([row]).includes('.thumb.webp'));
});

await test('T13d 笔记画廊沿用正文图片的宽高', async () => {
  const { splitImages } = await import('../src/render/notes.js');
  const { images } = splitImages('<p><img src="/uploads/x.png" alt="a" width="2400" height="1520"></p>');
  assert.equal(images.length, 1);
  assert.equal(images[0].width, '2400');
  assert.equal(images[0].height, '1520');
});

// 代码高亮（服务端 highlight.js）：写了语言才高亮，其余走回原来的转义
await test('T14a 写了语言的围栏出 hljs 高亮与 hljs 类', () => {
  const { html } = createRenderer().render('```js\nconst a = 1; // 注释\n```');
  assert.match(html, /<code class="hljs language-js">/);
  assert.match(html, /<span class="hljs-keyword">const<\/span>/);
  assert.match(html, /<span class="hljs-number">1<\/span>/);
  assert.match(html, /<span class="hljs-comment">\/\/ 注释<\/span>/);
});

await test('T14b 别名与大小写都认；common 之外的 Dockerfile 也注册了', () => {
  const alias = createRenderer().render('```TS\nconst a: number = 1\n```').html;
  assert.match(alias, /class="hljs language-TS"/);
  assert.match(alias, /hljs-keyword/);
  const docker = createRenderer().render('```dockerfile\nFROM node:22 AS build\nRUN npm ci\n```').html;
  assert.match(docker, /<span class="hljs-keyword">FROM<\/span>/);
});

await test('T14c 没写语言 / 语言不认识时输出与加高亮之前逐字相同', () => {
  const plain = createRenderer().render('```\n<b>&amp;</b>\n```').html;
  assert.equal(plain, '<pre><code>&lt;b&gt;&amp;amp;&lt;/b&gt;\n</code></pre>\n');
  const unknown = createRenderer().render('```nope-lang\n<b>x</b>\n```').html;
  assert.equal(unknown, '<pre><code class="language-nope-lang">&lt;b&gt;x&lt;/b&gt;\n</code></pre>\n');
  assert.ok(!unknown.includes('hljs'), unknown);
});

await test('T14d 高亮不引入可执行 HTML：代码里的标签/引号仍然转义', () => {
  const cases = [
    ['html', '<script>alert(1)</script>'],
    ['javascript', 'const s = "</code><img src=x onerror=alert(1)>";'],
    ['bash', 'echo "<b>hi</b>" & rm -rf /'],
  ];
  for (const [lang, code] of cases) {
    const { html } = createRenderer().render('```' + lang + '\n' + code + '\n```');
    assert.ok(!/<(script|img|b)\b/i.test(html), `${lang}: ${html}`);
    assert.ok(html.includes('&lt;'), `${lang} 应该转义而不是丢弃：${html}`);
  }
});

await test('T14e 残缺代码不抛异常，退回纯文本', () => {
  const { html } = createRenderer().render('```javascript\nfunction ( { [ \n```');
  assert.match(html, /<pre><code/);
  assert.ok(!html.includes('undefined'), html);
});

// 隔离式 UI 审计：绝不能往临时目录之外写库
// 真实踩过的坑：用 startServer 的 srv.dbFile 定位「副本」，而它 isolateDb:false 时返回 DB_FILE（相对路径 data/blog.db，即真实库），
// 临时口令就写进了真实库、覆盖使用者后台密码。目标路径必须自己拼 + 带硬防护。
await test('T12a 隔离审计的临时口令只写进自己拼出的临时库（不再取 srv.dbFile）', () => {
  const src = fs.readFileSync('scripts/ui-audit.mjs', 'utf8');
  assert.ok(!/new DatabaseSync\(srv\.dbFile\)/.test(src), '又去用 srv.dbFile 定位库了');
  assert.match(src, /guard\(dbFile\)/, '写库前没有走 guard');
});

await test('T12b 隔离审计对写入目标有"必须在临时目录内"的防护', () => {
  const src = fs.readFileSync('scripts/ui-audit.mjs', 'utf8');
  assert.match(src, /不在临时目录内/, '缺少越界写入防护');
  assert.match(src, /startsWith\(path\.resolve\(work\)/, '防护没有比对临时目录前缀');
  assert.match(src, /THEMES_DIR: dirs\.themes/, '主题没有隔离');
  assert.match(src, /FEED_REFRESH_MS: '0'/, '抓取没有关闭');
  assert.match(src, /AVATAR_UPSTREAMS: ''/, '头像回源没有关闭');
});

process.exitCode = report();
