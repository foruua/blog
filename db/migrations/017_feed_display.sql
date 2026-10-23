-- 友圈：每个源在前台「友圈」页显示几篇。0 = 默认（按朋友分组即「显示 3 篇」，见 src/config.js 的 FRIENDS_PER_SOURCE）；
-- 设成 N 让很勤的朋友最多占 N 条，其余条目仍留在库里。与「保留条数」是两件事故分两列：display_limit 只影响
-- 前台展示；清理按 max(FEED_KEEP, display_limit) 做，避免"显示 30 条但库里只留 20 条"。

ALTER TABLE feeds ADD COLUMN display_limit INTEGER NOT NULL DEFAULT 0;
