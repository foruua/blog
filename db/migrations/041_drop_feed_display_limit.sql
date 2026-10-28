-- 017 引入的「每源展示条数」从未有后台入口，也没有读取点；保留列只会让后来的人误以为功能存在。
ALTER TABLE feeds DROP COLUMN display_limit;
