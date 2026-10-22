-- 拒绝抓取期间被修改、停用或清空的订阅源的旧结果。
ALTER TABLE feeds ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
