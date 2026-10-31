// 首页封面视频转码：把后台上传的源视频统一成一份浏览器都能播的 MP4（H.264 / yuv420p / faststart），
// 再从成片首帧抽一张 WebP 海报。封面是静音装饰，音轨一律去掉。
// 只接受魔数确认过的 MP4 / WebM / MOV；不信任扩展名与 Content-Type。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
// ffmpeg-static 是可选依赖：装不上（GitHub 下载失败/平台不支持）时不能让站点起不来，
// 只要服务器有系统 ffmpeg 并通过 FFMPEG_PATH 指过去就仍能转码。
let bundledFfmpeg = null;
try { ({ default: bundledFfmpeg } = await import('ffmpeg-static')); } catch { /* 用 FFMPEG_PATH 或返回明确错误 */ }
import { MAX_COVER_VIDEO_BYTES, sniffVideoType } from './video.js';

export const HERO_VIDEO_MAX_SECONDS = 8;
export const HERO_VIDEO_MAX_SOURCE_BYTES = MAX_COVER_VIDEO_BYTES;
export const HERO_VIDEO_WIDTH = 960;
export const HERO_VIDEO_HEIGHT = 540;
export const HERO_VIDEO_MAX_BYTES = 3 * 1024 * 1024;
const TARGET_BYTES = 2.5 * 1024 * 1024;
const FPS = 24;
const PROBE_TIMEOUT_MS = 20_000;
const ENCODE_TIMEOUT_MS = 120_000;

const fail = (code, message) => Object.assign(new Error(message), { code });

function ffmpegBin() {
  const bin = process.env.FFMPEG_PATH || bundledFfmpeg;
  if (!bin) throw fail('FFMPEG_MISSING', 'ffmpeg binary not found');
  return bin;
}

function runFfmpeg(args, { timeoutMs = ENCODE_TIMEOUT_MS, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(ffmpegBin(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      reject(fail('FFMPEG_MISSING', String(error?.message ?? error)));
      return;
    }
    let stderr = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, fail('VIDEO_TIMEOUT', 'video processing timed out'));
    }, timeoutMs);
    timer.unref?.();
    child.stderr.on('data', (chunk) => {
      // 只留末尾一段：ffmpeg 的报错关键信息在后面，别让一个坏文件把内存刷满。
      stderr = (stderr + chunk.toString()).slice(-24_000);
    });
    child.on('error', (error) => {
      if (error?.code === 'ENOENT') { finish(reject, fail('FFMPEG_MISSING', String(error.message))); return; }
      finish(reject, fail('VIDEO_ENCODE_FAILED', String(error?.message ?? error)));
    });
    child.on('close', (code) => {
      if (code === 0 || allowFailure) { finish(resolve, stderr); return; }
      finish(reject, fail('VIDEO_ENCODE_FAILED', stderr.trim().split('\n').slice(-3).join(' ') || `ffmpeg exited ${code}`));
    });
  });
}

function durationFromFfmpeg(stderr) {
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

async function probeDuration(input) {
  const stderr = await runFfmpeg(['-hide_banner', '-nostdin', '-i', input], {
    timeoutMs: PROBE_TIMEOUT_MS, allowFailure: true,
  });
  return durationFromFfmpeg(stderr);
}

const videoFilter = `scale=${HERO_VIDEO_WIDTH}:${HERO_VIDEO_HEIGHT}:force_original_aspect_ratio=increase,`
  + `crop=${HERO_VIDEO_WIDTH}:${HERO_VIDEO_HEIGHT},fps=${FPS}`;

async function encodeMp4(input, output, crf) {
  await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-i', input,
    '-t', String(HERO_VIDEO_MAX_SECONDS),
    '-an', '-sn', '-dn',
    '-vf', videoFilter,
    '-c:v', 'libx264', '-profile:v', 'main', '-level', '4.0', '-pix_fmt', 'yuv420p',
    '-crf', String(crf), '-preset', 'veryfast', '-threads', '2',
    '-movflags', '+faststart', '-map_metadata', '-1',
    output,
  ]);
}

/**
 * @param {string} input 已落盘的源文件路径
 * @returns {Promise<{ buffer: Buffer, poster: Buffer, width: number, height: number, duration: number, truncated: boolean, sourceMime: string }>}
 */
export async function transcodeHeroVideo(input) {
  const head = Buffer.alloc(16_384);
  let fh;
  try {
    fh = await fs.promises.open(input, 'r');
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    if (bytesRead < 12) throw fail('UNSUPPORTED_VIDEO', 'file too small');
  } finally {
    await fh?.close().catch(() => {});
  }
  const sourceMime = sniffVideoType(head);
  if (!sourceMime) throw fail('UNSUPPORTED_VIDEO', 'not a supported video container');

  const sourceDuration = await probeDuration(input);
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'blog-cover-video-'));
  const out = path.join(dir, 'cover.mp4');
  const frame = path.join(dir, 'poster.png');
  try {
    await encodeMp4(input, out, 23);
    let bytes = (await fs.promises.stat(out)).size;
    if (bytes > TARGET_BYTES) {
      // 一次降档：封面是首屏装饰，宁可略糊也别把首页拖成几 MB 的下行。
      await encodeMp4(input, out, 28);
      bytes = (await fs.promises.stat(out)).size;
    }
    if (bytes > HERO_VIDEO_MAX_BYTES) throw fail('VIDEO_OUTPUT_TOO_LARGE', 'encoded video still too large');

    await runFfmpeg([
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-i', out, '-frames:v', '1', '-vf', videoFilter, '-an', frame,
    ]);
    const poster = await sharp(frame).webp({ quality: 82, effort: 4 }).toBuffer();
    const buffer = await fs.promises.readFile(out);
    return {
      buffer,
      poster,
      width: HERO_VIDEO_WIDTH,
      height: HERO_VIDEO_HEIGHT,
      duration: Math.min(sourceDuration || HERO_VIDEO_MAX_SECONDS, HERO_VIDEO_MAX_SECONDS),
      truncated: Boolean(sourceDuration && sourceDuration > HERO_VIDEO_MAX_SECONDS + 0.05),
      sourceMime,
    };
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
