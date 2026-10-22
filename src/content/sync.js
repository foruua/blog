import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseFrontmatter } from './frontmatter.js';
import { CONTENT_DIR } from '../config.js';
import { createRenderer } from '../render/markdown.js';
import { parseDate, slugify, validateSlug, wordCount } from '../util/text.js';
import { atomicWrite } from '../util/files.js';
import { mediaRevision } from '../media/revision.js';


const KINDS = [['posts', 'post'], ['notes', 'note'], ['pages', 'page']];

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.isFile() && /\.md$/i.test(entry.name)) out.push(p);
  }
  return out.sort();
}

// 外部导入的 Markdown 有时会把 front-matter 的分隔线转义成 \---（行尾还挂空格）：解析器读不到 title/date，
// 整篇被当成无日期草稿，还会和多出来的同一篇干净副本抢 slug。入库前统一还原成标准 ---，并清掉 front-matter
// 内的行尾空白。只在首行确实是转义分隔线时动手，正常文件原样返回；改过的文件备份原稿（见写回处）。
const ESCAPED_FRONT = /^\\---[ \t]*\r?\n([\s\S]*?)\r?\n\\---[ \t]*(?=\r?\n|$)/;
function repairFrontmatter(raw) {
  const m = ESCAPED_FRONT.exec(raw);
  if (!m) return raw;
  const front = m[1].split(/\r?\n/).map((line) => line.replace(/[ \t]+$/, '')).join('\n');
  return `---\n${front}\n---${raw.slice(m[0].length)}`;
}

// 改渲染器输出形态时必须 +1：body_html 与 toc_json 都入库，不升号会复用旧结果，存量文章永远停在旧 HTML。
const PIPELINE_VERSION = 19;

export function syncContent(repo, { log = console.log, quiet = false, renderer = createRenderer() } = {}) {
  const present = [];
  const presentByKind = new Map();
  const missingDirs = new Set();
  const records = [];
  const slugs = new Map();

  // 失效键是「渲染器版本 : 媒体修订号」；后者让 backfill-media/删图这类「文件没变但结果该变」也能触发重渲染，不必手工改版本号。
  const pipelineKey = `${PIPELINE_VERSION}:${mediaRevision(repo)}`;
  const prevKey = repo.getSetting('content_pipeline_version');
  const stalePipeline = prevKey !== pipelineKey;
  if (stalePipeline && prevKey && prevKey !== '0') {
    log(`[content] 内容管线 ${prevKey} → ${pipelineKey}，忽略文件哈希做全量重建`);
  }
  const out = { inserted: 0, updated: 0, skipped: 0, removed: 0, total: 0, errors: [] };
  // 一次查询同时服务“空目录保护”和后面的改名复用，避免同一份 fileRows 查两遍。
  const existingFileRows = typeof repo.fileRows === 'function' ? repo.fileRows() : null;
  // 「阻断性错误」= 不能安全地只应用一部分的全局问题：内容目录缺失（此时 prune 会把整类内容误标缺失）、
  // 重复 slug（两个文件争同一个地址，谁赢都说不清）。单文件解析/校验失败则只隔离该文件，其余照常入库——
  // 否则一个坏文件会让全站索引永远停在旧状态，而且每次启动都全量重渲染再失败。
  let blocked = false;
  let renderFailed = false;

  for (const [sub, kind] of KINDS) {
    const dir = path.join(CONTENT_DIR, sub);
    if (!fs.existsSync(dir)) {
      // 固定页目录允许缺省（老站升级没 content/pages/）：当成"还没有页面"跳过，但要把库里已有的页面文件算进
      // present——否则 pruneMissingFiles 会把它们全标 missing_file 转草稿（目录不可见=一次性下架所有固定页）。
      missingDirs.add(kind);
      if (kind === 'page') {
        for (const r of repo.pageFiles()) present.push(r.file_path);
        continue;
      }
      out.errors.push(`内容目录缺失，已保留全部索引：${sub}`);
      blocked = true;
      continue;
    }

    let files;
    try { files = walk(dir); } catch (e) { out.errors.push(`${sub}: ${e.message}`); blocked = true; continue; }
    for (const file of files) {
      present.push(file);
      presentByKind.set(kind, (presentByKind.get(kind) ?? 0) + 1);
      out.total++;

      try {
        const original = fs.readFileSync(file, 'utf8');
        const repaired = repairFrontmatter(original).replace(/^(---\r?\n)([\s\S]*?)(\r?\n---)/, (_, open, front, close) =>
          open + front.replace(/^(date:\s*['"]?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}):00([+-]\d{2}:\d{2}['"]?\s*)$/gm, '$1$2') + close);
        const raw = repaired;
        const fileHash = crypto.createHash('sha256').update(raw).digest('hex');
        const { data, content } = parseFrontmatter(raw);

        const base = path.basename(file).replace(/\.md$/i, '');
        const slug = data.slug ? String(data.slug) : slugify(base);
        const slugError = validateSlug(slug, kind);
        if (slugError) throw new Error(`${slugError}：${slug}`);
        if (slugs.has(slug)) {
          const conflict = new Error(`重复 slug「${slug}」：${slugs.get(slug)}`);
          conflict.blocking = true;   // 两个文件争同一地址：整批不写，避免"谁后同步谁赢"的隐性覆盖
          throw conflict;
        }
        slugs.set(slug, path.relative(CONTENT_DIR, file));
        const title = String(data.title ?? base);
        const bodyMd = content.trim();

        const hasDate = data.date != null && data.date !== '';
        const publishedAt = hasDate ? parseDate(data.date) : null;
        const draft = data.draft === true || !publishedAt;

        // 正文没变就不必再渲染：以前每次启动都对全站 Markdown 重跑 markdown-it，算完立刻被 upsertFromFile
        // 按 file_hash 丢掉（500 篇实测约一半启动同步时间白烧）。
        // 预检只需要元数据与旧渲染结果；用 getPostMeta 避免整行正文随每次启动进内存。
        const existing = (typeof repo.getPostMeta === 'function' ? repo.getPostMeta(slug) : repo.getPost(slug));
        const unchanged = !stalePipeline && Boolean(existing)
          && existing.file_hash === fileHash && !existing.missing_file;
        let rendered;
        if (unchanged) rendered = { html: existing.body_html, toc: existing.toc };
        else {
          try { rendered = renderer.render(bodyMd); }
          catch (error) { error.renderFailed = true; throw error; }
        }

        records.push({
          file,
          // 只有真的发生元数据修复时才在内存里保留第二份全文；否则 records 里存 null 即可。
          original: repaired !== original ? original : null,
          repaired: repaired !== original ? repaired : null,
          prev: existing,
          rec: {
            slug, kind, title, description: data.description ? String(data.description) : '', bodyMd, bodyHtml: rendered.html, toc: rendered.toc,
            lang: data.lang ? String(data.lang) : 'zh', commentsOn: data.comments !== false,
            draft, publishedAt, wordCount: unchanged ? existing.word_count : wordCount(bodyMd),
            filePath: file, fileHash, existing,
          },
        });
      } catch (err) {
        if (err.blocking) blocked = true;
        if (err.renderFailed) renderFailed = true;
        out.errors.push(`${path.relative(CONTENT_DIR, file)}: ${err.message}`);
      }
    }
  }

  // 按 kind 分别保护：posts 挂载失败变空、notes 还有文件时，旧的“全站 present 非空”判断会漏掉整类文章。
  // 只保护“多篇内容突然全没了”的场景；单篇站点删掉最后一篇是正常操作，不应被挡。
  for (const [sub, kind] of KINDS) {
    if (missingDirs.has(kind)) continue;
    const expected = existingFileRows?.filter((row) => row.kind === kind).length ?? 0;
    const actual = presentByKind.get(kind) ?? 0;
    if (expected >= 2 && actual === 0) {
      out.errors.push(`${sub} 目录为空，但索引里仍有 ${expected} 个${kind === 'note' ? '笔记' : kind === 'page' ? '页面' : '文章'}：已保留该类索引并跳过 prune`);
      blocked = true;
    }
  }

  // 预检完成。只有阻断性错误才整批放弃；单文件错误已在预检里隔离，继续应用其余文件。
  if (!blocked) {
    const presentSet = new Set(present);
    // 纯文件改名（未写 frontmatter slug）时，新 slug 查不到旧行；按内容哈希找回「文件已不在本轮 present 里」
    // 的旧行，复用 id，writePost 会顺手写入旧 URL 的 301 alias，评论/修订也就不会挂到 missing 行上。
    if (existingFileRows) {
      const oldByHash = new Map();
      for (const row of existingFileRows) {
        if (row.file_hash && !presentSet.has(row.file_path)) oldByHash.set(row.file_hash, row);
      }
      const claimed = new Set();
      for (const item of records) {
        if (item.prev || !item.rec.fileHash) continue;
        const candidate = oldByHash.get(item.rec.fileHash);
        if (!candidate || claimed.has(candidate.id) || candidate.kind !== item.rec.kind) continue;
        item.prev = candidate;
        claimed.add(candidate.id);
      }
    }
    const repairs = [];
    try {
      repo.transaction(() => {
        for (const { file, original, repaired, prev, rec } of records) {
          // slug 预检已保证唯一，allowMove 直接用预检那一行，少一次 SELECT。
          const allowMove = Boolean(prev?.file_path && !presentSet.has(prev.file_path));
          // 预检已查到这行，把 id 带进去，writePost 不必再按 filePath/slug 点查。
          // 管线/媒体修订号变化会触发全量重渲染，但文件哈希没变 = 正文没改，updated_at 必须保留：
          // 否则每上传一张图再重启，所有旧文的 Feed updated / sitemap lastmod 都会跳到今天。
          const res = repo.upsertFromFile({ ...rec, id: prev?.id, allowMove }, {
            ignoreHash: stalePipeline,
            preserveUpdatedAt: stalePipeline && Boolean(prev) && prev.file_hash === rec.fileHash,
          });
          if (res.action === 'inserted') out.inserted++;
          else if (res.action === 'updated' || res.action === 'moved') out.updated++;
          else out.skipped++;
          if (repaired !== original) repairs.push({ file, original, repaired });
        }
        out.removed = repo.pruneMissingFiles(present);
        // 有文件渲染失败时不推进全局版本：否则该文件哈希没变，下次启动会一直复用旧的 body_html。
        if (!renderFailed) repo.setSetting('content_pipeline_version', pipelineKey);
      });
    } catch (e) {
      out.errors.push(e.message);
      out.inserted = out.updated = out.removed = out.skipped = 0;
      repairs.length = 0;
    }
    // 元数据修复（转义分隔线、旧式日期）写回 .md 必须在事务提交之后：写在事务里一旦回滚，数据库复原、文件却已改好，下次同步对不上。
    for (const { file, original, repaired } of repairs) {
      try {
        if (!fs.existsSync(`${file}.before-fix`)) fs.writeFileSync(`${file}.before-fix`, original, { mode: 0o600 });
        atomicWrite(file, repaired);
      } catch (err) {
        // 库里已按修好的元数据落库；写文件失败只记一笔，不回滚已提交的同步。
        out.errors.push(`${path.relative(CONTENT_DIR, file)}: 元数据修复写回失败：${err.message}`);
      }
    }
    if (!quiet && repairs.length) log(`[content] 已修复 ${repairs.length} 个文件的元数据（原稿备份为 .before-fix）`);
  }

  if (!quiet) {
    log(`[content] 扫描 ${out.total} 个文件 → 新增 ${out.inserted} / 更新 ${out.updated} / 未变 ${out.skipped} / 删除 ${out.removed}`);
    for (const e of out.errors) log(`[content] ✗ ${e}`);
  }
  return out;
}
