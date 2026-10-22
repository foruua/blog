-- 记录「上传时原始文件」的字节数，供后台媒体库显示。media.bytes 存的是 sharp 重编码后落盘的那份（通常更小），
-- 于是媒体库写 258KB、用户原件却是 1.2MB；这一列把真实值留下。老记录为 NULL（无法回溯），界面回退到 bytes；
-- 重复上传同一张图时会顺手补上这一列。
ALTER TABLE media ADD COLUMN original_bytes INTEGER;
