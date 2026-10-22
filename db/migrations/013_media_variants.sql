-- 响应式图片变体：JSON 数组 [{ w, path }]，渲染时输出 srcset。存 JSON 而不每档加一列（档位以后还会调）。
-- 老记录为 NULL：拿不到变体时渲染退回原图，scripts/backfill-media.mjs 可一次性补齐。
ALTER TABLE media ADD COLUMN variants TEXT;
