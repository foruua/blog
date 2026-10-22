-- 移除「站点公告」功能后清掉它留下的设置项：site_notice 曾是首页封面标题下方那行小字（后台「设置 → 站点公告」
-- 写入）；功能连同 UI 与 saveSettings 的读写一起删了，不再被任何代码读取。老库里可能存过公告文本，一并清掉。

DELETE FROM settings WHERE key = 'site_notice';
