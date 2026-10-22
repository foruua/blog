-- 修正 website_host 回填：早期 023 的 SQL 没有剥 userinfo，也把带端口的 IPv6（[::1]:8080）留成了
-- 「[::1]:8080」，与 src/util/url.js 的 websiteHost() 不一致。这里按当前规则重算所有评论的归并键；
-- 对已经正确的行是幂等的。023 也同步修正，保证全新安装与老库升级结果一致。

UPDATE comments SET website_host = CASE
    WHEN instr(lower(website), '://') = 0 THEN NULL
    WHEN instr(substr(lower(website), instr(lower(website), '://') + 3), '/') > 0
      THEN substr(substr(lower(website), instr(lower(website), '://') + 3), 1,
                  instr(substr(lower(website), instr(lower(website), '://') + 3), '/') - 1)
    ELSE substr(lower(website), instr(lower(website), '://') + 3)
  END
 WHERE website IS NOT NULL AND website <> '';

UPDATE comments SET website_host = substr(website_host, instr(website_host, '@') + 1)
  WHERE website_host IS NOT NULL AND instr(website_host, '@') > 0;

UPDATE comments SET website_host = CASE
    WHEN substr(website_host, 1, 1) = '[' AND instr(website_host, ']') > 0
      THEN substr(website_host, 1, instr(website_host, ']'))
    WHEN substr(website_host, 1, 1) <> '[' AND instr(website_host, ':') > 0
         AND length(website_host) - length(replace(website_host, ':', '')) = 1
      THEN substr(website_host, 1, instr(website_host, ':') - 1)
    ELSE website_host
  END
  WHERE website_host IS NOT NULL AND instr(website_host, ':') > 0;

UPDATE comments SET website_host = substr(website_host, 5)
  WHERE website_host IS NOT NULL AND website_host LIKE 'www.%';
