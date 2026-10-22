-- 页面摘要：SEO/分享描述不再只能从正文首段截取。空串表示未填写，渲染时回退到正文。
ALTER TABLE posts ADD COLUMN description TEXT NOT NULL DEFAULT '';
