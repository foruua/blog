-- 删掉 feeds.note 列：「一句话介绍」功能整个撤掉。它只做展示，前台从不读、后台也不再显示；留着只让
-- insert/update 与备份里多一个永远为空的字段。
ALTER TABLE feeds DROP COLUMN note;
