// 视频附件：只认容器魔数，不解码、不转码。和图片一样按内容哈希命名，直接原样落盘、原样提供。
// 体积上限、MIME 与扩展名都在这里，上传路由与渲染器共用同一套判断，避免「能传不能放」。

const VIDEO_EXT = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };
export const videoExtension = (mime) => VIDEO_EXT[mime] ?? 'mp4';

// 正文里出现这些后缀就按视频渲染（上传落盘时扩展名由 MIME 决定，能对得上）。
const VIDEO_SRC_RE = /\.(?:mp4|webm|mov|m4v)(?:$|[?#])/i;
export const isVideoSource = (src) => typeof src === 'string' && VIDEO_SRC_RE.test(src);

// 首页封面统一比例：优先用列表里的第一段视频，没有视频则 16:9。前后台共用，避免两边各算一套。
export function heroAspectOf(items = []) {
  const video = (items ?? []).find((im) => isVideoSource(im?.path) && Number(im.w) > 0 && Number(im.h) > 0);
  const a = Math.max(1, Math.round(Number(video?.w) || 16));
  const b = Math.max(1, Math.round(Number(video?.h) || 9));
  const gcd = (x, y) => (y ? gcd(y, x % y) : x);
  const g = gcd(a, b);
  return { ratio: `${a / g}/${b / g}`, style: `${a / g} / ${b / g}` };
}

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

function ebmlUint(buf, start, end) {
  if (end <= start || end - start > 8) return 0;
  let value = 0;
  for (let i = start; i < end; i++) value = value * 256 + buf[i];
  return value;
}

const WEBM_CONTAINERS = new Set([0x18538067, 0x1654AE6B, 0xAE, 0xE0, 0xE1]);

function webmDimensions(buf, start, end, depth = 0) {
  if (depth > 6) return null;
  let width = 0, height = 0;
  for (const el of ebmlElements(buf, start, end)) {
    if (el.id === 0xb0) width = ebmlUint(buf, el.start, el.end);
    else if (el.id === 0xba) height = ebmlUint(buf, el.start, el.end);
    else if (WEBM_CONTAINERS.has(el.id)) {
      const found = webmDimensions(buf, el.start, el.end, depth + 1);
      if (found) return found;
    }
  }
  return width > 0 && height > 0 ? { width, height } : null;
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

function* mp4Boxes(buf, start, end) {
  let offset = start;
  while (offset + 8 <= end) {
    const size32 = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    let header = 8;
    let size = size32;
    if (size32 === 1) {
      if (offset + 16 > end) return;
      const large = buf.readBigUInt64BE(offset + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) return;
      size = Number(large); header = 16;
    } else if (size32 === 0) {
      size = end - offset;
    }
    if (size < header || offset + size > end) return;
    yield { type, start: offset + header, end: offset + size };
    offset += size;
  }
}

const MP4_CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta', 'mvex']);

// tkhd 末尾的 width/height 是 16.16 定点数；音轨这两项为 0，所以「第一个非零轨道」就是视频轨。
function tkhdDimensions(buf, box) {
  const version = buf[box.start];
  const offset = version === 1 ? 88 : 76;
  if (box.end - box.start < offset + 8) return null;
  const width = Math.round(buf.readUInt32BE(box.start + offset) / 65536);
  const height = Math.round(buf.readUInt32BE(box.start + offset + 4) / 65536);
  return width > 0 && height > 0 ? { width, height } : null;
}

function mp4Dimensions(buf, start, end, depth = 0) {
  if (depth > 8) return null;
  for (const box of mp4Boxes(buf, start, end)) {
    if (box.type === 'tkhd') {
      const found = tkhdDimensions(buf, box);
      if (found) return found;
    } else if (MP4_CONTAINERS.has(box.type)) {
      const found = mp4Dimensions(buf, box.start, box.end, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** 按文件头判断视频容器；不认识返回 null。伪装成 video/* 的文本/图片一律落到图片分支再被 sharp 拒绝。 */
export function sniffVideoType(buf) {
  if (buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp') {
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

/** 尺寸只用于占位与媒体库展示；解析失败不拦上传，渲染时退回无宽高。 */
export function videoDimensions(buf, mime) {
  try {
    if (mime === 'video/webm') return webmDimensions(buf, 0, buf.length) ?? { width: 0, height: 0 };
    return mp4Dimensions(buf, 0, buf.length) ?? { width: 0, height: 0 };
  } catch {
    return { width: 0, height: 0 };
  }
}
