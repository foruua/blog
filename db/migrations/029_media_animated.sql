-- 动画图（多帧 GIF / WebP / APNG）只有原图保留全部帧；缩略图与响应式变体都只取首帧。
-- 灯箱展示图默认改用最大档 WebP 变体（体积远小于原图），但动画图必须回原图，否则动画会变成静止首帧。
-- 老记录为 NULL：渲染时按 mime 保守判断（GIF 视为可能动画）；scripts/backfill-media.mjs --apply 会补齐。
ALTER TABLE media ADD COLUMN animated INTEGER;
