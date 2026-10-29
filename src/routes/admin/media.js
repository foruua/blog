import fs from 'node:fs';
import path from 'node:path';
import { ADMIN_PAGE_SIZE, UPLOADS_DIR, DATA_DIR } from '../../config.js';
import { mediaPage, mediaDeletePage, mediaDetailPage, mediaDetailContent } from '../../admin/views/media.js';
import { variantFile, thumbnailFile, previewSrcsetOf, previewSourceOf, originalPathOf, parseVariants, serializeVariants } from '../../media/variants.js';
import { deleteWithFiles } from '../../content/commit.js';
import { mediaFile } from '../../media/paths.js';
import { MAX_UPLOAD } from '../../util/http.js';
import { MAX_INPUT_PIXELS } from '../../util/image.js';
import { normalizeImage, probeImage, sha256File, ALLOWED_MIME, extensionFor } from '../../media/image.js';
import { bumpMediaRevision } from '../../media/revision.js';
import { heroImages } from '../../settings.js';
import { bodyOf, pageNumber, pagination, externalWrite, notice, notFoundPage } from './shared.js';
import { logError } from '../../util/errors.js';
import { syncDirectory } from '../../util/files.js';


// 独占创建 + 顺手做一次符号链接检查：mediaFile() 只校验现有祖先，新建文件本身得由 wx 保证不会覆盖。
// 图片可能很大：异步写 + fsync，别用同步调用堵住整个进程的事件循环。

async function writeNewFileAsync(filePath, data, createdFiles) {
  mediaFile('/uploads/' + path.relative(UPLOADS_DIR, filePath).split(path.sep).join('/'));
  const fh = await fs.promises.open(filePath, 'wx', 0o600);
  createdFiles.push(filePath);
  try { await fh.writeFile(data); await fh.sync(); }
  finally { await fh.close(); }
  // 目录项不在这里同步：一次上传会写原图 + 缩略图 + 最多 8 个变体，逐个 fsync 目录等于
  // 在事件循环上连堵 10 次。调用方写完后统一 syncDirectory 一次即可（见下方上传处理）。
}

async function sameFileContent(filePath, data) {
  let fh;
  try { fh = await fs.promises.open(filePath, 'r'); } catch { return false; }
  try {
    const stat = await fh.stat();
    if (!stat.isFile() || stat.size !== data.length) return false;
    // 流式比较：重复上传大图时不要把已有文件整块读回内存，再和请求体各占一份。
    const chunk = Buffer.allocUnsafe(Math.min(256 * 1024, Math.max(1, data.length)));
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await fh.read(chunk, 0, Math.min(chunk.length, data.length - offset), offset);
      if (!bytesRead) return false;
      if (!chunk.subarray(0, bytesRead).equals(data.subarray(offset, offset + bytesRead))) return false;
      offset += bytesRead;
    }
    return true;
  } catch { return false; }
  finally { await fh.close().catch(() => {}); }
}

async function writeIfAbsentAsync(filePath, data, createdFiles) {
  try { await writeNewFileAsync(filePath, data, createdFiles); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    if (!await sameFileContent(filePath, data)) throw e;
  }
}

export function registerMediaRoutes(app, { repo, adminRepo, mutate = (fn) => fn() }, { ctx }) {

  const heroPaths = () => new Set(heroImages(repo).map((im) => im.path));

  app.get('/admin/api/media', (c) => {
    const page = pageNumber(c); const search = (c.req.query('q') ?? '').slice(0, 100);
    const items = adminRepo.mediaPage({ page, search });
    return c.json({ ok: true, page, hasMore: items.length > ADMIN_PAGE_SIZE, items: items.slice(0, ADMIN_PAGE_SIZE).map((m) => ({
      id: m.id, path: m.path, thumbnail: previewSourceOf(m), filename: m.filename || m.path.split('/').pop(),
      width: m.width, height: m.height, bytes: m.original_bytes ?? m.bytes, previewSrcset: previewSrcsetOf(m), mime: m.mime,
    })) });
  });

  app.get('/admin/api/media/preview', (c) => {
    const source = c.req.query('path') ?? '';
    const media = adminRepo.mediaByPath(source) ?? adminRepo.mediaByPath(originalPathOf(source));
    return c.json({ ok: true, preview: previewSourceOf(media), srcset: previewSrcsetOf(media), found: Boolean(media) });
  });


  // 去重命中的记录必须对应磁盘上真实存在的原图/缩略图/变体；否则重传同一内容永远返回一个 404 URL。
  function mediaComplete(media) {
    if (!media?.path) return false;
    const paths = [media.path, media.thumbnail, ...parseVariants(media.variants).map((v) => v.path)].filter(Boolean);
    return paths.every((item) => {
      try { return fs.statSync(mediaFile(item)).isFile(); } catch { return false; }
    });
  }

  function finishUpload(c, dup, bytes) {
    if (!mediaComplete(dup)) return c.json({ ok: false, error: '媒体文件缺失，正在重建，请重试' }, 503);
    if (!dup.original_bytes) adminRepo.mediaSetOriginalBytes(dup.id, bytes);
    return c.json({ ok: true, url: dup.path, thumbnail: previewSourceOf(dup), width: dup.width, height: dup.height, bytes, deduped: true });
  }

  // 上传：解码/重编码（可达数百毫秒到数秒）在全局写队列【之外】完成，只把短促的同步写放回队列——否则大图上传期间评论、保存、登录会全部排队。
  externalWrite(app, '/admin/api/upload', async (c) => {
    const temp = c.get('uploadTemp');
    // input 可以是 Buffer（旧 multipart）或临时文件路径（raw）：sharp 两者都接受，
    // raw 路径不要再 readFile 回内存，否则 boundedBody 的流式落盘白做。
    let input = null;
    let bytes = 0;
    let hash = '';
    let filename = null;

    if (temp) {
      // 新前端：body 是原始二进制，已由 boundedBody 流式落到临时文件。
      if (temp.size > MAX_UPLOAD) {
        return c.json({ ok: false, error: `文件超过 ${Math.round(MAX_UPLOAD / 1048576)}MB` }, 413);
      }
      const rawName = c.req.header('x-file-name') ?? '';
      try { filename = decodeURIComponent(rawName).slice(0, 200); } catch { filename = rawName.slice(0, 200); }
      input = temp.file;
      bytes = temp.size;
      hash = await sha256File(temp.file);
    } else {
      // 旧 multipart 表单（兼容旧客户端/脚本）：仍然整块读入，但先按 File.size 拦住超大请求，
      // 别等 arrayBuffer() 把超限负载整块读进堆再判 413。
      const b = await bodyOf(c);
      const file = b instanceof FormData ? b.get('file') : null;
      if (!file || typeof file === 'string') return c.json({ ok: false, error: '没有拿到文件' }, 400);
      const declaredSize = Number(file.size);
      if (Number.isFinite(declaredSize) && declaredSize > MAX_UPLOAD) {
        return c.json({ ok: false, error: `文件超过 ${Math.round(MAX_UPLOAD / 1048576)}MB` }, 413);
      }
      input = Buffer.from(await file.arrayBuffer());
      bytes = input.length;
      filename = file.name ?? null;
      if (bytes > MAX_UPLOAD) {
        return c.json({ ok: false, error: '上传文件过大' }, 413);
      }
      hash = probeImage.sha256(input);
    }

    const dup = adminRepo.mediaByHash(hash);
    if (dup && mediaComplete(dup)) return mutate(() => finishUpload(c, dup, bytes));

    let normalized;
    try { normalized = await normalizeImage(input); }
    catch (error) {
      if (error?.code === 'PIXEL_LIMIT') {
        return c.json({ ok: false, error: `图片像素超过上限（约 ${Math.round(MAX_INPUT_PIXELS / 10000)} 万，可用 MAX_INPUT_PIXELS 调整）` }, 415);
      }
      return c.json({ ok: false, error: '图片损坏或格式不支持' }, 415);
    }
    const buf = normalized.buffer;
    if (buf.length > MAX_UPLOAD) {
      return c.json({ ok: false, error: `文件超过 ${Math.round(MAX_UPLOAD / 1048576)}MB` }, 413);
    }

    const mime = probeImage.mime(buf);
    if (!mime || !ALLOWED_MIME.has(mime)) {
      return c.json({ ok: false, error: '只接受图片 PNG / JPEG / GIF / WebP（不接受 SVG：它可携带脚本）' }, 415);
    }

    const now = new Date();
    const y = String(now.getUTCFullYear());
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dir = path.join(UPLOADS_DIR, y, m);
    const abs = path.join(dir, `${hash.slice(0, 16)}.${extensionFor(mime)}`);
    const thumbAbs = thumbnailFile(abs);
    const rel = `/uploads/${y}/${m}/${path.basename(abs)}`;
    const size = normalized;
    const variants = (size.variants ?? []).map((v) => {
      const absFile = variantFile(abs, v.width);
      return { absFile, data: v.data, w: v.width, path: variantFile(rel, v.width) };
    });
    const createdFiles = [];
    const cleanupOnError = () => { for (const f of createdFiles) fs.rmSync(f, { force: true }); };

    // 写盘/fsync 放在全局写队列外；队列内只做去重与一条 INSERT。
    try {
      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
      mediaFile(rel);
      fs.mkdirSync(dir, { recursive: true });
      await writeIfAbsentAsync(abs, buf, createdFiles);
      await writeIfAbsentAsync(thumbAbs, normalized.thumbnail, createdFiles);
      for (const v of variants) await writeIfAbsentAsync(v.absFile, v.data, createdFiles);
      // 所有文件都写在同一目录：目录项只同步一次，别为每个变体各堵一次事件循环。
      if (createdFiles.length) syncDirectory(dir);
    } catch (e) {
      cleanupOnError();
      throw e;
    }

    return mutate(() => {
      const again = adminRepo.mediaByHash(hash);
      if (again && mediaComplete(again)) {
        // 跨月并发等情况下我们可能新建了另一组文件；只保留最终记录引用的路径。
        const keep = new Set([again.path, again.thumbnail, ...parseVariants(again.variants).map((v) => v.path)]
          .filter(Boolean).map((p) => path.join(UPLOADS_DIR, p.replace(/^\/uploads\//, ''))));
        for (const f of createdFiles) if (!keep.has(f)) fs.rmSync(f, { force: true });
        return finishUpload(c, again, bytes);
      }
      // 记录还在但原图/缩略图/变体缺失：删掉坏行，按本次写好的文件重建。
      // 删坏行、插入新行、bump 媒体修订号必须在同一事务里；否则插入失败会留下已删的旧行，
      // 或插入成功但 revision 没变，存量正文继续引用旧渲染结果。
      try {
        repo.transaction(() => {
          if (again) adminRepo.mediaDelete(again.id);
          adminRepo.mediaAdd({
            path: rel, thumbnail: thumbnailFile(rel), width: size?.width, height: size?.height, bytes: buf.length,
            originalBytes: bytes,
            mime, hash, filename, variants: variants.length ? serializeVariants(variants) : null,
            animated: size?.animated === true,
          });
          // 新增一张图会改变「正文里已引用该路径的文章」的渲染结果；bump 一次让下次内容同步重渲染存量正文。
          bumpMediaRevision(repo);
        });
      } catch (e) {
        cleanupOnError();
        throw e;
      }
      for (const v of size.variantErrors ?? []) {
        console.warn(JSON.stringify({ event: 'media.variant-failed', width: v.width, message: v.message, path: rel }));
      }
      return c.json({ ok: true, url: rel, thumbnail: thumbnailFile(rel), width: size?.width, height: size?.height, bytes });
    });
  });

  app.get('/admin/media', (c) => {
    const page = pageNumber(c);
    const rows = adminRepo.mediaPage({ page });
    const items = rows.slice(0, ADMIN_PAGE_SIZE);
    return c.html(mediaPage(ctx(c, { items, usage: adminRepo.mediaUsage(items), stats: adminRepo.mediaStats(),
      heroPaths: [...heroPaths()], notice: c.req.query('w') ?? '',

      pagination: pagination('/admin/media', page, rows.length > ADMIN_PAGE_SIZE, '', '', { hideSearch: true }),
    })));
  });

  const mediaTrashDir = path.join(DATA_DIR, '.trash', 'uploads');

  app.get('/admin/media/:id', (c) => {
    const item = adminRepo.mediaById(c.req.param('id'));
    if (!item) return notFoundPage(c, ctx, '这个文件不在媒体库里。');
    const details = { item, isHero: heroPaths().has(item.path),
      usedBy: adminRepo.postsUsingPath(item.path) };
    if (c.req.query('partial') === 'details') return c.html(mediaDetailContent(details));
    return c.html(mediaDetailPage(ctx(c, details)));
  });

  app.get('/admin/media/delete/:id', (c) => {
    const item = adminRepo.mediaById(c.req.param('id'));
    if (!item) return notFoundPage(c, ctx, '这个文件不在媒体库里。');
    return c.html(mediaDeletePage(ctx(c, {
      item,
      isHero: heroPaths().has(item.path),
      usedBy: adminRepo.postsUsingPath(item.path),
    })));
  });

  function purgeMedia(item) {
    const abs = mediaFile(item.path);
    const thumbnail = item.thumbnail ? mediaFile(item.thumbnail) : null;
    const trash = path.join(mediaTrashDir, `${Date.now()}-${path.basename(abs)}`);
    // 变体与缩略图是可再生的派生物，跟原图一起进回收站，别在 uploads 里留孤儿文件。
    const variants = parseVariants(item.variants).map((v, i) => ({ file: mediaFile(v.path), trash: `${trash}.w${i + 1}.webp` }));
    return deleteWithFiles({ repo, files: [
      { file: abs, trash },
      ...(thumbnail ? [{ file: thumbnail, trash: trash + '.thumb.webp' }] : []),
      ...variants,
    ], remove: () => adminRepo.mediaDelete(item.id) });
  }

  app.post('/admin/media/delete/:id', (c) => {
    const item = adminRepo.mediaById(c.req.param('id'));
    if (!item) return notice(c, '/admin/media', '✗ 这个文件已经不在媒体库里了');
    if (heroPaths().has(item.path)) {
      return notice(c, `/admin/media/delete/${item.id}`, '✗ 这是当前首页封面，先换掉或移除它');
    }
    // 正文可能引用的是旧变体/缩略图路径（手写 HTML、历史数据），不能只看原图。
    const usedPaths = [item.path, item.thumbnail, ...parseVariants(item.variants).map((v) => v.path)].filter(Boolean);
    if (usedPaths.some((p) => adminRepo.postsUsingPath(p).length)) {
      return notice(c, '/admin/media', '✗ 正文仍引用此图片（或其派生文件），请先移除引用');
    }
    let moved;
    try { moved = purgeMedia(item); } catch (e) {
      // 以前把 e.message（含绝对路径）编进跳转 URL；详情只进日志。
      logError(e, c, 'admin.media-delete-failed');
      return notice(c, '/admin/media', '✗ 删除失败，记录已保留，请稍后重试');
    }
    // 删掉原图与派生文件后，存量正文的 srcset 会指向不存在的候选；bump 一次，下次同步重渲染时去掉 srcset/宽高。
    bumpMediaRevision(repo);
    const note = moved ? `✓ 已删除 ${item.path}（文件在 data/.trash/uploads/）` : `✓ 已删除记录 ${item.path}（磁盘上没找到这个文件）`;
    return notice(c, '/admin/media', note);
  });
}
