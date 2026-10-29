import { gzip, brotliCompress, constants as zlibConstants } from 'node:zlib';
import { promisify } from 'node:util';

// 全站只有一套压缩参数：静态资源、HTML 缓存与主题资源共用，避免「这里 q5、那里默认 q11」
// 导致同一份字节被压出不同结果，也让缓存键/ETag 的判断保持一致。
const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

export const MIN_COMPRESS_BYTES = 1024;

// 只对文本类响应做预压缩；图片/字体/视频再压一遍只会更慢、更大。
const COMPRESSIBLE_TYPE = /^(?:text\/|application\/(?:json|xml|javascript|manifest\+json)|image\/svg\+xml)/i;
export const isCompressibleType = (contentType) => COMPRESSIBLE_TYPE.test(String(contentType ?? ''));

export async function compressBuffer(buffer, encoding, { brotliQuality = 5 } = {}) {
  if (encoding === 'br') {
    return brotliAsync(buffer, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: brotliQuality } });
  }
  if (encoding === 'gzip') return gzipAsync(buffer);
  return buffer;
}
