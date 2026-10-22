-- 删掉 links 表：它只写不读。建它是想「把 wiki-link 目标入库做反向链接」，但那个「将来」一直没来——全仓没
-- 任何 SELECT 读它（`[[目标]]` 由路由实时解析 /go/，从不经过这张表）。真要做「哪些文章提到了这篇」：从渲染器
-- 拿到的 labels 重建即可（body_md 才是真相）。留着只是负债。

DROP TABLE IF EXISTS links;
