-- 友圈：记住「自动发现」出来的真实订阅地址。站主常只填站点主页，服务端读 <link rel="alternate"> 找 feed；
-- 不记下来则每 30 分钟都要重读那个网页（多一次请求、多一份对朋友的流量）。用单独的列而不是改写 url：
-- url 是站主填的、也是唯一键与列表显示地址，不该被程序悄悄改。

ALTER TABLE feeds ADD COLUMN resolved_url TEXT;
