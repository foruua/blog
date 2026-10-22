-- 同一内容只允许一条 media 记录。上传路径会先按 hash 查重，但并发/竞态下仍可能各查各的。
-- 不用 UNIQUE INDEX：老库可能已有重复 hash，建索引会让启动直接失败；触发器只拦未来的重复写入，
-- 存量数据交给上传查重与清理脚本处理。
CREATE TRIGGER IF NOT EXISTS media_hash_unique_insert
BEFORE INSERT ON media
WHEN NEW.hash IS NOT NULL AND EXISTS (SELECT 1 FROM media WHERE hash = NEW.hash)
BEGIN
  SELECT RAISE(ABORT, 'media.hash 已存在');
END;

CREATE TRIGGER IF NOT EXISTS media_hash_unique_update
BEFORE UPDATE OF hash ON media
WHEN NEW.hash IS NOT NULL AND EXISTS (SELECT 1 FROM media WHERE hash = NEW.hash AND id <> OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'media.hash 已存在');
END;
