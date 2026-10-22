-- 发信队列：评论通知、看门狗与备份告警先落库，再由后台定时重试。
-- 以前 send() 是 fire-and-forget，SMTP 抖动一次就永久丢信；也没有全局限流，分布式评论可把站主邮箱打爆。
CREATE TABLE IF NOT EXISTS mail_outbox (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  to_addr         TEXT NOT NULL,
  subject         TEXT NOT NULL,
  text_body       TEXT NOT NULL,
  html_body       TEXT,
  headers_json    TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',   -- pending / sent / skipped / failed
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  sent_at         TEXT
);

-- flush 的唯一热查询：到点待发，按时间/序号取一批。
CREATE INDEX IF NOT EXISTS idx_mail_outbox_due
  ON mail_outbox(status, next_attempt_at);

-- 统计「最近一小时成功发了几封」，用于全局限流。
CREATE INDEX IF NOT EXISTS idx_mail_outbox_sent
  ON mail_outbox(status, sent_at);
