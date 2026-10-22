-- 友链页：谁来过、留言几条、对方的站还开不开。「谁在友链页上」不落表——那是 comments 的派生态（approved +
-- 填了网址 + 非博主），页面因此永远与评论区一致，也不必在四条写入路径上补同步钩子。这张表只存评论里没有、也
-- 推不出来的东西：可达性、站名、失败次数、手动隐藏。website_host 是归并键（只按 host 认人；不剥 www. 会把
-- www.a.com 与 a.com 算成两位访客）。JS 侧唯一实现是 src/util/url.js 的 websiteHost()，下面三条 UPDATE 是它的
-- 一次性回填版本 —— 两边必须同结果。

ALTER TABLE comments ADD COLUMN website_host TEXT;

-- 回填第一步：剥协议，取到首个 '/' 之前（此步之后仍可能带端口）。
UPDATE comments SET website_host = CASE
    WHEN instr(lower(website), '://') = 0 THEN NULL
    WHEN instr(substr(lower(website), instr(lower(website), '://') + 3), '/') > 0
      THEN substr(substr(lower(website), instr(lower(website), '://') + 3), 1,
                  instr(substr(lower(website), instr(lower(website), '://') + 3), '/') - 1)
    ELSE substr(lower(website), instr(lower(website), '://') + 3)
  END
 WHERE website IS NOT NULL AND website <> '';

-- userinfo（https://u:p@a.com/）不属于 host：取第一个 '@' 之后。入库前的 normalizeUrl 允许它，
-- 归并键必须与 src/util/url.js 的 websiteHost() 同结果。
UPDATE comments SET website_host = substr(website_host, instr(website_host, '@') + 1)
  WHERE website_host IS NOT NULL AND instr(website_host, '@') > 0;

-- 回填第二步：剥端口（a.com:8080 → a.com），同时正确处理带端口的 IPv6（[::1]:8080 → [::1]）。
-- 同一台机器换个端口不改身份；IPv6 的冒号不是端口分隔符，必须看方括号。
UPDATE comments SET website_host = CASE
    WHEN substr(website_host, 1, 1) = '[' AND instr(website_host, ']') > 0
      THEN substr(website_host, 1, instr(website_host, ']'))
    WHEN substr(website_host, 1, 1) <> '[' AND instr(website_host, ':') > 0
         AND length(website_host) - length(replace(website_host, ':', '')) = 1
      THEN substr(website_host, 1, instr(website_host, ':') - 1)
    ELSE website_host
  END
  WHERE website_host IS NOT NULL AND instr(website_host, ':') > 0;

-- 回填第四步：剥 www.
UPDATE comments SET website_host = substr(website_host, 5)
 WHERE website_host IS NOT NULL AND website_host LIKE 'www.%';

-- 友链页的取数按 website_host 分组，评论审核按 status 过滤，两列一起建。
CREATE INDEX IF NOT EXISTS idx_comments_website_host ON comments(website_host, status);

CREATE TABLE IF NOT EXISTS link_sites (
  host        TEXT PRIMARY KEY,             -- 归并键：小写、剥 www.、无端口、无路径
  url         TEXT NOT NULL DEFAULT '',     -- 探测时用的地址（跟随重定向后的最终地址）
  title       TEXT NOT NULL DEFAULT '',     -- 对方 <title>，只当悬停提示（可能是「请稍候」这类挑战页）
  alive       INTEGER NOT NULL DEFAULT 1,   -- 0 = 连续失败到门槛，前台隐藏；站回来自动恢复
  hidden      INTEGER NOT NULL DEFAULT 0,   -- 站主手动隐藏。与 alive 分开，自动下线不该顶掉人的判断
  fail_count  INTEGER NOT NULL DEFAULT 0,   -- 连续失败次数，一次成功即归零
  checked_at  TEXT,                         -- 最近一次探测（无论结果）
  last_ok_at  TEXT,                         -- 最近一次探通
  last_error  TEXT,                         -- 给站主看的失败原因（已截断）
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
