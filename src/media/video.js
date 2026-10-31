// 视频容器识别：只认魔数，不解码、不转码。首页封面的上传入口与转码模块共用这一份判断，
// 避免「能传不能转」或把伪装成视频的图片送进 ffmpeg。
// 扩展名判断只用于已入库的封面路径（历史数据/手工导入），上传侧一律以魔数为准。

// 首页封面视频的源文件上限（转码后的成片另有限制）。与 Nginx client_max_body_size 40m 对齐；
// 放在这个纯常量模块里，避免只为读一个上限把 config.js（含环境变量快照）提前加载。
export const MAX_COVER_VIDEO_BYTES = 40 * 1024 * 1024;

// 正文与封面里出现这些后缀就按视频渲染（上传落盘时扩展名由 MIME 决定，能对得上）。
const VIDEO_SRC_RE = /\.(?:mp4|webm|mov|m4v)(?:$|[?#])/i;
export const isVideoSource = (src) => typeof src === 'string' && VIDEO_SRC_RE.test(src);

const MP4_AUDIO_IMAGE_BRANDS = new Set(['M4A ', 'M4B ', 'M4P ', 'heic', 'heix', 'mif1', 'msf1', 'avif']);

function readEbmlVint(buf, offset, keepMarker) {
  if (offset < 0 || offset >= buf.length) return null;
  const first = buf[offset];
  if (!first) return null;
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && !(first & mask)) { mask >>= 1; length++; }
  if (length > 8 || offset + length > buf.length) return null;
  const valueMask = 0xff >> length;
  let value = keepMarker ? first : (first & valueMask);
  let unknown = (first & valueMask) === valueMask;
  for (let i = 1; i < length; i++) {
    value = value * 256 + buf[offset + i];
    if (buf[offset + i] !== 0xff) unknown = false;
  }
  return { value, length, unknown };
}

function* ebmlElements(buf, start, end) {
  let offset = start;
  while (offset < end) {
    const id = readEbmlVint(buf, offset, true);
    if (!id) return;
    const size = readEbmlVint(buf, offset + id.length, false);
    if (!size) return;
    const dataStart = offset + id.length + size.length;
    const dataEnd = size.unknown ? end : dataStart + size.value;
    if (dataStart > end || dataEnd > end || dataEnd < dataStart) return;
    yield { id: id.value, start: dataStart, end: dataEnd };
    offset = dataEnd;
  }
}

function webmDocType(buf) {
  for (const el of ebmlElements(buf, 0, buf.length)) {
    if (el.id !== 0x1a45dfa3) continue;
    for (const child of ebmlElements(buf, el.start, el.end)) {
      if (child.id === 0x4282) return buf.toString('latin1', child.start, child.end).replace(/\0+$/, '').trim();
    }
  }
  return '';
}

/** 按文件头判断视频容器；不认识返回 null。伪装成 video/* 的文本/图片一律拒收。 */
export function sniffVideoType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buf.toString('latin1', 8, 12);
    if (MP4_AUDIO_IMAGE_BRANDS.has(brand)) return null;
    return brand === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  }
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0x1a45dfa3) {
    const docType = webmDocType(buf);
    // matroska(.mkv) 与 webm 共用 EBML 头，但浏览器只保证 WebM 能放；明确是 mkv 就拒掉。
    return docType && docType !== 'webm' ? null : 'video/webm';
  }
  return null;
}
