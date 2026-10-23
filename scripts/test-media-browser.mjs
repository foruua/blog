import { launchBrowser, loginAdminPage } from './_browser.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { createFixtures } from './_fixtures.mjs';
import { startServer } from './_server.mjs';
import { normalizeImage } from '../src/media/image.js';
import { variantFile, thumbnailFile, serializeVariants } from '../src/media/variants.js';
const fixtures = await createFixtures();
let server, browser;
try {
  const { open, close } = await import('../db/driver.js');
  const { createAdminRepo } = await import('../db/admin.js');
  const { createRepo } = await import('../db/repo.js');
  const db = open(fixtures.env.DB_FILE), admin = createAdminRepo(db), repo = createRepo(db);
  const paths = ['/uploads/large.png', '/uploads/tiny.png', '/uploads/animated.gif'];
  const large = await sharp({create:{width:3000,height:2000,channels:3,background:'green'}}).png().toBuffer();
  const frames = Buffer.alloc(800 * 600 * 3 * 2, 200); frames.fill(40,800*600*3);
  const animated = await sharp(frames,{raw:{width:800,height:1200,channels:3,pageHeight:600}}).gif({delay:[100,100],loop:0}).toBuffer();
  const inputs = [large, await sharp(large).resize(120).png().toBuffer(), animated];
  let firstId;
  for (let i=0; i<paths.length; i++) {
    const source=paths[i], absolute=path.join(fixtures.env.UPLOADS_DIR,path.basename(source));
    const result=await normalizeImage(inputs[i]); fs.writeFileSync(absolute,result.buffer);
    fs.writeFileSync(thumbnailFile(absolute),result.thumbnail);
    for(const v of result.variants) fs.writeFileSync(variantFile(absolute,v.width),v.data);
    const id=admin.mediaAdd({path:source,width:result.width,height:result.height,mime:i===2?'image/gif':'image/png',animated:i===2?1:0,thumbnail:thumbnailFile(source),variants:serializeVariants(result.variants.map(v=>({w:v.width,path:variantFile(source,v.width)})))});
    firstId ??= id;
  }
  repo.setSetting('hero_image',paths[0]); repo.setSetting('hero_image_w','3000'); repo.setSetting('hero_image_h','2000');
  const body=paths.map(p=>`![图片](${p})`).join('\n\n') + '\n\n![参数](/uploads/tiny.png?x=1&y=2)';
  for(const [kind,slug] of [['posts','media-check'],['notes','media-note']]) fs.writeFileSync(path.join(fixtures.env.CONTENT_DIR,kind,slug+'.md'),`---\ntitle: 图片验证\nslug: ${slug}\ndate: 2026-01-01\n---\n${body}\n`);
  const postId = repo.getPost('why-single-column').id;
  close(db);
  server=await startServer({env:fixtures.env}); browser=await launchBrowser({headless:true});
  const liveDb=open(fixtures.env.DB_FILE);
  try { liveDb.prepare("UPDATE posts SET body_html=body_html || ? WHERE slug='media-check'").run(`<p><img src="${server.base}/uploads/tiny.png" alt="绝对地址"></p>`); }
  finally { close(liveDb); }
  for(const [width,dpr] of [[390,3],[1440,2]]) {
    const page=await browser.newPage({viewport:{width,height:900},deviceScaleFactor:dpr});
    const originalRequests=[], errors=[];
    page.on('request',r=>{const pathname=new URL(r.url()).pathname; if(pathname.startsWith('/uploads/')&&!/\.(?:thumb-v3|v4-w\d+)\.webp$/.test(pathname))originalRequests.push(pathname);});
    page.on('response',r=>{if(r.url().includes('/uploads/')&&r.status()>=400)errors.push(r.status());});
    for(const route of ['/','/posts/','/notes/','/p/media-check/','/n/media-note/']) {
      originalRequests.length=0;
      await page.goto(server.base+route,{waitUntil:'networkidle'});
      for(const img of await page.locator('img[data-full], .gallery img').all()) { await img.scrollIntoViewIfNeeded(); }
      await page.waitForTimeout(150);
      assert.deepEqual(originalRequests,[],`页面提前下载原图：${route}`);
      if(route==='/p/media-check/') {
        assert.match(await page.locator('img[alt="参数"]').getAttribute('src'),/v4-w120/);
        assert.match(await page.locator('img[alt="绝对地址"]').getAttribute('src'),/v4-w120/);
      }
      if(route==='/p/media-check/'||route==='/') {
        const target=page.locator('[data-lightbox]').filter({hasNot:page.locator('img.lb-img')}).first();
        const targetFull=await target.getAttribute('data-full');
        await target.click(); await page.locator('.lb-img').waitFor({state:'visible'});
        await page.waitForFunction(()=>{const img=document.querySelector('.lb-img');return img?.complete&&img.naturalWidth>0;});
        // 静态图灯箱改用最大档 WebP 变体：不下载原图，也不预载。
        assert.match(targetFull,/\.v4-w\d+\.webp$/,'静态图 data-full 应指向变体');
        assert.ok(!originalRequests.includes(paths[0]),`静态图灯箱不该下载原图：${route}`);
        await page.keyboard.press('Escape');
        if(route==='/p/media-check/') {
          originalRequests.length=0;
          await page.locator('img[data-full="/uploads/animated.gif"]').click();
          await page.waitForFunction(()=>document.querySelector('.lb-img')?.getAttribute('src')==='/uploads/animated.gif');
          assert.ok(originalRequests.includes(paths[2]),'动画图灯箱回原图以保留动画');
          await page.keyboard.press('Escape');
        }
      }
    }
    await loginAdminPage(page, server.base, fixtures.env.ADMIN_PASSWORD);
    for(const route of ['/admin/media',`/admin/media/${firstId}`,'/admin/system']) {
      originalRequests.length=0; await page.goto(server.base+route,{waitUntil:'networkidle'}); assert.deepEqual(originalRequests,[],route);
    }
    await page.goto(server.base+`/admin/edit/${postId}`,{waitUntil:'networkidle'});
    originalRequests.length=0;
    await page.click('#a-upload-btn');
    await page.locator('#a-picker img').first().waitFor({state:'visible'});
    await page.waitForTimeout(150);
    assert.deepEqual(originalRequests,[]);
    await page.keyboard.press('Escape');
    await page.goto(server.base+'/admin/system',{waitUntil:'networkidle'});
    originalRequests.length=0;
    // 首页封面也能从媒体库选：打开选择器 → 点一个已有文件 → 进列表（还没保存）→ 移除，回到原状再测上传。
    await page.click('#heroPick');
    await page.locator('#a-picker[open] .a-picker-item').first().waitFor();
    await page.locator('#a-picker .a-picker-item').first().click();
    await page.waitForFunction(()=>document.querySelectorAll('#heroList .a-hero-item').length===2);
    assert.match(await page.locator('#heroState').innerText(),/媒体库/);
    await page.locator('#heroList .a-hero-item').last().locator('[data-hero-remove]').click();
    await page.waitForFunction(()=>document.querySelectorAll('#heroList .a-hero-item').length===1);
    originalRequests.length=0;
    await page.setInputFiles('#heroFile',{name:'animation.gif',mimeType:'image/gif',buffer:animated});
    await page.waitForFunction(()=>document.querySelector('#heroState')?.textContent.includes('已加'));
    assert.match(await page.locator('#heroList .a-hero-item img').last().getAttribute('src'),/\.(?:thumb-v3|v4-w\d+)\.webp$/);
    const heroPaths = () => page.$$eval('#heroList .a-hero-item', (els) => els.map((e) => e.dataset.path));
    const [firstPath, secondPath] = await heroPaths();
    assert.ok(firstPath && secondPath && firstPath !== secondPath, `需要两张首页图：${firstPath} / ${secondPath}`);
    assert.match(await page.locator('#heroList .a-hero-item').first().innerText(), /封面/, '第一张默认就是封面');
    // 用鼠标事件手动拖（dragTo() 只派发一次 dragover，落点常不成立）。量坐标前先滚进视口 —— 鼠标坐标是视口坐标，元素在屏外时指针落到窗口外、drop 不触发。
    // 原生 DnD 的落点由 dragover 的 requestAnimationFrame 计算；最后一步 move 后要留一帧，否则 drop 时 dropBefore 还是 null。
    const dragFirstToSecond = async () => {
      await page.locator('#heroList').scrollIntoViewIfNeeded();
      await page.waitForTimeout(120);
      const src = page.locator('#heroList .a-hero-item').first();
      const dst = page.locator('#heroList .a-hero-item').nth(1);
      await src.scrollIntoViewIfNeeded();
      await dst.scrollIntoViewIfNeeded();
      await page.waitForTimeout(120);
      const sbox = await src.boundingBox();
      const dbox = await dst.boundingBox();
      await page.mouse.move(sbox.x + sbox.width / 2, sbox.y + sbox.height / 2);
      await page.mouse.down();
      await page.mouse.move(sbox.x + sbox.width / 2 + 20, sbox.y + sbox.height / 2, { steps: 6 });
      // 落点取目标格「中线略下、右缘」：既表示插到它后面，又不像右下角那样落到 900px 视口外（指针出窗口就不触发 drop）。
      await page.mouse.move(dbox.x + dbox.width - 3, dbox.y + dbox.height / 2 + 12, { steps: 18 });
      await page.waitForTimeout(220);
      await page.mouse.up();
    };
    const reordered = async () => {
      try {
        await page.waitForFunction(([a, b]) => {
          const paths = [...document.querySelectorAll('#heroList .a-hero-item')].map((el) => el.dataset.path);
          return paths[0] === a && paths[1] === b;
        }, [secondPath, firstPath], { timeout: 2500 });
        return true;
      } catch { return false; }
    };
    let moved = false;
    for (let attempt = 0; attempt < 2 && !moved; attempt++) {
      await dragFirstToSecond();
      moved = await reordered();
    }
    assert.ok(moved, '拖到第二格之后应换序');
    assert.deepEqual(await heroPaths(), [secondPath, firstPath], '拖到第二格之后应换序');
    assert.match(await page.locator('#heroList .a-hero-item').first().innerText(), /封面/, '换到第一位的成为封面');
    assert.ok(!(await page.locator('#heroList .a-hero-item').nth(1).innerText()).includes('封面'), '第二位不再是封面');
    const preview=await page.evaluate(async()=> (await fetch('/admin/api/media/preview?path='+encodeURIComponent('/uploads/tiny.png'))).json());
    assert.match(preview.preview,/v4-w120/);
    assert.deepEqual(originalRequests,[]); assert.deepEqual(errors,[]);
    await page.close(); console.log(`通过 ${width}px / DPR ${dpr}：前后台均不预载原图，静态图灯箱用变体，动画图灯箱才回原图。`);
  }
} finally { if(browser) await browser.close(); if(server) await server.stop(); fixtures.cleanup(); }
