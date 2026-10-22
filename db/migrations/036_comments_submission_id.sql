-- 评论提交幂等键：同一次页面提交（双击、移动端重试、代理重放）只落一条。
ALTER TABLE comments ADD COLUMN submission_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_comments_submission
  ON comments(post_id, submission_id) WHERE submission_id IS NOT NULL;
