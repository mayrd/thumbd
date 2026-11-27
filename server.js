// thumbd — persistent thumbnail daemon (images: sharp/libvips, videos: ffmpeg with HW decode)
// Single-user, Docker, ARM64-optimized. No Express — only Node built-in http.
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

// ---------- Configuration (env) ----------
const PORT = parseInt(process.env.THUMBD_PORT || '8090', 10);
// The media root is ALWAYS /data — mount your folders there (docker-compose).
// No THUMBD_ROOTS env: keeps the whitelist simple and predictable.
let ROOTS = ['/data'];
const TOKEN = process.env.THUMBD_TOKEN || '';            // empty = no auth (internal only)
const CACHE_DIR = process.env.THUMBD_CACHE || '/cache';
const CACHE_MAX_AGE = 60 * 60 * 24 * 7;                  // 7 day disk cache
const MAX_SRC_MB = parseInt(process.env.THUMBD_MAX_SRC_MB || '4096', 10); // source file limit (TV episodes are often 1-2 GB)
const VIDEO_MAX_SEC = parseInt(process.env.THUMBD_VIDEO_MAX_SEC || '600', 10); // videos >10min: only first 10min
const FFMPEG = process.env.THUMBD_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.THUMBD_FFPROBE || 'ffprobe';
const V4L2 = process.env.THUMBD_V4L2 || 'drm';            // HW accel: 'drm' = stateless V4L2 (Pi 5 HEVC); '' = off
const CPUS = Math.max(1, typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.tif', '.tiff', '.bmp']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mpg', '.mpeg', '.avi', '.flv', '.wmv', '.asf', '.mkv', '.webm', '.m4v', '.ts']);

let sharpMod = null;
function getSharp() {
  if (!sharpMod) {
    sharpMod = require('sharp');
    const rawConc = (process.env.THUMBD_SHARP_CONCURRENCY ?? '').trim();
    if (rawConc !== '') {
      const n = parseInt(rawConc, 10);
      if (Number.isFinite(n) && n >= 0) sharpMod.concurrency(n);
    }
  }
  return sharpMod;
}

const LOG_LEVEL_MAP = {
  off: 0, '0': 0,
  error: 1, '1': 1,
  warn: 2, warning: 2, '2': 2,
  info: 3, '3': 3,
  debug: 4, all: 4, '4': 4,
};
const LOG_LEVEL_NAMES = ['off', 'error', 'warn', 'info', 'debug'];

function parseLogLevel(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === '') return 3; // info
  return Object.prototype.hasOwnProperty.call(LOG_LEVEL_MAP, s) ? LOG_LEVEL_MAP[s] : 3;
}

function levelName(lvl) {
  return LOG_LEVEL_NAMES[lvl] || 'info';
}

let logLevel = parseLogLevel(process.env.THUMBD_LOG_LEVEL);
function setLogLevel(lvl) {
  if (typeof lvl === 'string') {
    logLevel = parseLogLevel(lvl);
  } else if (Number.isFinite(lvl)) {
    logLevel = Math.max(0, Math.min(4, Math.trunc(lvl)));
  }
  return logLevel;
}
function getLogLevel() { return logLevel; }

const STATS_INTERVAL_SEC = (() => {
  const raw = (process.env.THUMBD_STATS_INTERVAL_SEC ?? '').trim();
  if (raw === '') return 30;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 30;
})();

// ---------- Helpers ----------
function logAt(levelNum, tag, ...a) {
  if (logLevel >= levelNum) {
    console.log(new Date().toISOString(), tag, ...a);
  }
}
function logError(...a) { logAt(1, 'ERROR', ...a); }
function logWarn(...a) { logAt(2, 'WARN', ...a); }
function logInfo(...a) { logAt(3, 'INFO', ...a); }
function logDebug(...a) { logAt(4, 'DEBUG', ...a); }
function log(...a) { logInfo(...a); }

function safeVal(v) {
  return String(v ?? '-').replace(/[\r\n]+/g, ' ');
}

// Is the path inside one of the roots? (symlink-safe via realpath)
let resolvedRootsCache = null;
async function getResolvedRoots() {
  if (!resolvedRootsCache) {
    const resolved = await Promise.all(ROOTS.map((root) => fsp.realpath(root).catch(() => null)));
    resolvedRootsCache = resolved.filter(Boolean);
  }
  return resolvedRootsCache;
}

async function resolveAllowed(absPath) {
  const real = await fsp.realpath(absPath).catch(() => null);
  if (!real) return null;
  const roots = await getResolvedRoots();
  for (const r of roots) {
    if (real === r || real.startsWith(r + path.sep)) return real;
  }
  return null;
}

function cachePath(realPath, w, h, t, fit) {
  const key = crypto.createHash('sha1').update(`${realPath}|${w}|${h}|${t}|${fit}`).digest('hex');
  return path.join(CACHE_DIR, key.slice(0, 2), key + '.webp');
}

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

// ---------- Video: codec + duration + display dimensions + HW-decode check ----------
function probeVideo(realPath) {
  // returns {codec, duration, width, height, rotation} or null.
  // width/height are the DISPLAY dimensions: ffprobe reports the raw sensor size,
  // while ffmpeg auto-rotates on playback. A 90/270 display matrix (phone
  // recordings are stored landscape) is therefore applied here — otherwise a
  // portrait video would be reported as landscape and the media wall would pick
  // the wrong tile shape.
  return new Promise((resolve) => {
    execFile(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries',
      'stream=codec_name,width,height:stream_side_data=rotation:format=duration',
      '-of', 'json', realPath], { timeout: 15000 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const d = JSON.parse(stdout);
        const s = (d.streams && d.streams[0]) || {};
        const codec = s.codec_name || null;
        const dur = d.format && d.format.duration ? parseFloat(d.format.duration) : null;
        let width = Number.isFinite(s.width) ? s.width : null;
        let height = Number.isFinite(s.height) ? s.height : null;
        let rotation = 0;
        const sd = Array.isArray(s.side_data_list) ? s.side_data_list : [];
        for (const e of sd) {
          const r = parseFloat(e.rotation);
          if (Number.isFinite(r)) { rotation = ((Math.round(r) % 360) + 360) % 360; break; }
        }
        if ((rotation === 90 || rotation === 270) && width && height) {
          const tmp = width; width = height; height = tmp;
        }
        resolve({ codec, duration: Number.isFinite(dur) ? dur : null,
                  width, height, rotation });
      } catch { resolve(null); }
    });
  });
}

// ---------- Image: display dimensions incl. EXIF orientation ----------
// sharp reads only the header (no full decode), so this is cheap even on slow
// mounts, and it reports orientation 1-8. Same rule as xplorer's local path:
// orientation 5-8 means rotated 90/270 -> swap the axes, so the tile shape
// matches what the browser shows. ffprobe is NOT usable for this: it does not
// report a JPEG's EXIF orientation and its process start is too slow for
// per-item calls.
function probeImageDimensions(realPath) {
  return new Promise((resolve) => {
    let sharp;
    try {
      sharp = getSharp();
    } catch {
      return resolve(null);            // no sharp -> caller falls back to its own path
    }
    sharp(realPath).metadata().then((m) => {
      if (!m || !m.width || !m.height) return resolve(null);
      const ori = Number(m.orientation) || 1;
      const swap = ori >= 5 && ori <= 8;
      resolve({
        width: swap ? m.height : m.width,
        height: swap ? m.width : m.height,
        rotation: swap ? 90 : 0,
      });
    }).catch(() => resolve(null));
  });
}

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp',
                           '.tif', '.tiff', '.avif', '.heic']);

// Videos -> ffprobe (display matrix), images -> sharp (EXIF orientation).
function probeMediaDimensions(realPath) {
  return IMAGE_EXT.has(path.extname(realPath).toLowerCase())
    ? probeImageDimensions(realPath)
    : probeVideo(realPath);
}

function hasV4l2Decoder(decoder) {
  return new Promise((resolve) => {
    // HW decode needs real /dev/video* devices in the container (Pi 5: video19+)
    let hasDev = false;
    try {
      hasDev = fs.readdirSync('/dev').some(n => n.startsWith('video'));
    } catch { hasDev = false; }
    if (!hasDev) return resolve(false);
    // `drm` is a HWACCEL (checked via -hwaccels), not a codec in -decoders.
    // The Pi 5 stateless V4L2 HEVC path is reached with `-hwaccel drm` (rpt ffmpeg).
    const args = decoder === 'drm' ? ['-hide_banner', '-hwaccels'] : ['-hide_banner', '-decoders'];
    execFile(FFMPEG, args, { timeout: 10000 }, (err, stdout) => {
      if (err) return resolve(false);
      resolve(stdout.includes(decoder));
    });
  });
}

let v4l2Promise = null;
function getV4l2Available() {
  if (!v4l2Promise) {
    v4l2Promise = hasV4l2Decoder(V4L2).catch(() => false);
  }
  return v4l2Promise;
}

// Pi 5: NO HW H.264 decoder (only HEVC via rpi-hevc-dec) — h264 stays software.
// HEVC HW decode uses the STATELESS V4L2 path (`-hwaccel drm`), NOT the mem2mem
// wrapper: `hevc_v4l2m2m` fails on the rpi-hevc-dec with "can't configure decoder:
// Invalid argument" (the rpi decoder is stateless, the wrapper is stateful m2m).
// Requires the Raspberry-Pi-OS ffmpeg (rpt build) in the container — bind it from
// the host (see compose: /usr/bin/ffmpeg → /custom-ffmpeg/bin/ffmpeg) or install
// the rpi packages; the stock Debian ffmpeg has no "V4L2 HEVC stateless" hwaccel.
function pickDecoder(codec, v4l2Available) {
  if (!v4l2Available || !codec) return null;
  if (codec === 'hevc' || codec === 'h265') return 'drm';   // -hwaccel drm (stateless)
  return null; // h264/mpeg/... => software
}

// ---------- Thumbnail generation ----------
async function makeImageThumb(realPath, w, h, outTmp, fit = 'contain') {
  const sharp = getSharp();
  const sharpFit = fit === 'cover' ? 'cover' : 'inside';  // cover = fill+crop, inside = contain (keep ratio)
  const vf = fit === 'cover'
    ? `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`
    : `scale=${w}:${h}:force_original_aspect_ratio=decrease`;
  try {
    await sharp(realPath, { failOn: 'none', limitInputPixels: 100_000_000 })
      .rotate()                       // respect EXIF orientation
      .resize(w, h, { fit: sharpFit, withoutEnlargement: true })
      .webp({ quality: 80 })
      .toFile(outTmp);
    return 'sharp';
  } catch (err) {
    // sharp/libvips is built WITHOUT bmp (and without ImageMagick) support —
    // BMP files fail with "Input file contains unsupported image format".
    // ffmpeg has a BMP decoder, so fall back to ffmpeg for image formats
    // sharp cannot read. The explicit -f webp is required (.tmp suffix).
    const ext = path.extname(realPath).toLowerCase();
    if (ext !== '.bmp') throw err;
    await new Promise((resolve, reject) => {
      execFile(FFMPEG, [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-i', realPath,
        '-frames:v', '1',
        '-vf', vf,
        '-q:v', '4',
        '-f', 'webp',
        outTmp,
      ], { timeout: 60000 }, (e) => e ? reject(e) : resolve());
    });
    return 'ffmpeg-bmp';
  }
}

async function makeVideoThumb(realPath, w, h, t, outTmp, decoder, fit = 'contain') {
  const seek = Math.max(0, t);
  const decArgs = decoder ? ['-hwaccel', decoder] : [];   // null = software; 'drm' = stateless V4L2 (Pi 5 HEVC)
  // cover = scale up to fill + crop to exact box; contain = keep source ratio
  const vf = fit === 'cover'
    ? `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`
    : `scale=${w}:${h}:force_original_aspect_ratio=decrease`;
  await new Promise((resolve, reject) => {
    execFile(FFMPEG, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-ss', String(seek),                 // input seeking (fast)
      ...decArgs,                          // HW decoder when suitable, otherwise software
      '-i', realPath,
      '-frames:v', '1',
      '-vf', vf,
      '-q:v', '4',
      '-f', 'webp',                        // explicit, since .tmp suffix breaks detection
      outTmp,
    ], { timeout: 60000 }, (err) => err ? reject(err) : resolve());
  });
}

// Bounded async concurrency helper; preserves output order and lets active workers
// settle on error before rejecting so caller cleanup in `finally` is race-free.
async function mapConcurrent(items, limit, fn) {
  if (!items.length) return [];
  const cap = Math.max(1, Math.min(limit || 1, items.length));
  const results = new Array(items.length);
  let nextIdx = 0;
  let firstErr = null;
  const worker = async () => {
    while (!firstErr) {
      const idx = nextIdx++;
      if (idx >= items.length) break;
      try {
        results[idx] = await fn(items[idx], idx);
      } catch (err) {
        if (!firstErr) firstErr = err;
        break;
      }
    }
  };
  await Promise.all(Array.from({ length: cap }, worker));
  if (firstErr) throw firstErr;
  return results;
}

// Extract `nFrames` contiguous preview frames from `t` at `fps` in a single ffmpeg pass.
async function extractVideoPreviewFrames(realPath, t, w, h, fps, nFrames, outTmp, decoder, fit = 'contain') {
  const seek = Math.max(0, t);
  const singleFile = `${outTmp}.p0`;
  const extractFallbackFrame = async () => {
    try {
      await extractVideoFrame(realPath, seek, w, h, singleFile, decoder, fit);
    } catch (err) {
      if (seek <= 0) throw err;
      await extractVideoFrame(realPath, Math.max(0, seek - 0.5), w, h, singleFile, decoder, fit);
    }
    return fsp.readFile(singleFile);
  };
  if (nFrames <= 1) {
    try {
      return [await extractFallbackFrame()];
    } finally {
      await fsp.unlink(singleFile).catch(() => {});
    }
  }

  const decArgs = decoder ? ['-hwaccel', decoder] : [];
  const scaleVf = fit === 'cover'
    ? `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`
    : `scale=${w}:${h}:force_original_aspect_ratio=decrease`;
  const pattern = `${outTmp}.p%03d.webp`;
  const dir = path.dirname(outTmp);
  const prefix = `${path.basename(outTmp)}.p`;
  let createdFiles = [];
  try {
    await new Promise((resolve, reject) => {
      execFile(FFMPEG, [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-ss', String(seek),
        ...decArgs,
        '-i', realPath,
        '-vf', `fps=${fps},${scaleVf}`,
        '-frames:v', String(nFrames),
        '-q:v', '4',
        '-c:v', 'libwebp',
        '-f', 'image2',
        pattern,
      ], { timeout: 60000 }, (err) => err ? reject(err) : resolve());
    });
    const entries = await fsp.readdir(dir);
    createdFiles = entries
      .filter((name) => name.startsWith(prefix) && name.endsWith('.webp'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((name) => path.join(dir, name));
    const bufs = [];
    for (const f of createdFiles) {
      bufs.push(await fsp.readFile(f));
    }
    // Near-EOF edge case: fps filter can yield 0 frames if seek lands past the last PTS.
    if (bufs.length === 0) {
      bufs.push(await extractFallbackFrame());
    }
    return bufs;
  } finally {
    await fsp.unlink(singleFile).catch(() => {});
    for (const f of createdFiles) await fsp.unlink(f).catch(() => {});
  }
}

// Extract discrete timestamped frames in parallel (bounded per job across CPUS).
async function extractVideoFramesParallel(realPath, times, w, h, outTmp, tag, decoder, fit = 'contain') {
  const concurrency = Math.max(1, Math.ceil(CPUS / Math.max(1, activeJobs)));
  try {
    return await mapConcurrent(times, concurrency, async (ts, i) => {
      const f = `${outTmp}.${tag}${i}`;
      await extractVideoFrame(realPath, ts, w, h, f, decoder, fit);
      return fsp.readFile(f);
    });
  } finally {
    for (let i = 0; i < times.length; i++) {
      await fsp.unlink(`${outTmp}.${tag}${i}`).catch(() => {});
    }
  }
}

// Animated preview: `mode=preview` — animated WebP from `t` for `d` seconds at `fps`
// (matches the legacy AnimatedVideoThumbnail: -ss 1 -t 3 -vf fps=10 -loop 0).
// Frames are assembled in Node (buildAnimatedWebP) — ffmpeg's webp muxer (v8) uses
// delta-frames/partial ANMF chunks with merged delays, which is inconsistent.
async function makeVideoPreview(realPath, w, h, t, d, fps, outTmp, decoder, fit = 'contain') {
  const nFrames = Math.max(1, Math.round(fps * d));
  const bufs = await extractVideoPreviewFrames(realPath, t, w, h, fps, nFrames, outTmp, decoder, fit);
  const anim = await buildAnimatedWebP(bufs, bufs.map(() => Math.round(1000 / fps)));
  await fsp.writeFile(outTmp, anim);
}

// Extract a single still frame to a file (helper for slideshow)
async function extractVideoFrame(realPath, ts, w, h, outFile, decoder, fit = 'contain') {
  const decArgs = decoder ? ['-hwaccel', decoder] : [];   // 'drm' = stateless V4L2 (Pi 5 HEVC)
  const vf = fit === 'cover'
    ? `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`
    : `scale=${w}:${h}:force_original_aspect_ratio=decrease`;
  await new Promise((resolve, reject) => {
    execFile(FFMPEG, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-ss', String(Math.max(0, ts)),
      ...decArgs,
      '-i', realPath,
      '-frames:v', '1',
      '-vf', vf,
      '-q:v', '4',
      '-f', 'webp',
      outFile,
    ], { timeout: 60000 }, (err) => err ? reject(err) : resolve());
  });
}

// Slideshow: `mode=slideshow` — animated WebP with N frames. Either `interval`
// (one frame every N seconds) or `count` (N frames evenly spaced over the video).
// Each frame is shown for 1 second.
async function makeVideoSlideshow(realPath, w, h, times, outTmp, decoder, fit = 'contain') {
  const frames = await extractVideoFramesParallel(realPath, times, w, h, outTmp, 'f', decoder, fit);
  const anim = await buildAnimatedWebP(frames, frames.map(() => 1000));  // 1s per frame
  await fsp.writeFile(outTmp, anim);
}

// Mix: `mode=mix` — animated preview (t..t+d at fps) followed by a slideshow of the
// remaining video (count evenly spaced frames, or one frame every interval seconds).
// Preview frames are shown at 1/fps s each, slideshow frames for 1 s each.
async function makeVideoMix(realPath, w, h, t, d, fps, times, outTmp, decoder, fit = 'contain') {
  const nPrev = Math.max(1, Math.round(fps * d));
  const prevBufs = await extractVideoPreviewFrames(realPath, t, w, h, fps, nPrev, outTmp, decoder, fit);
  const slideBufs = await extractVideoFramesParallel(realPath, times, w, h, outTmp, 's', decoder, fit);
  const frames = [
    ...prevBufs.map((buf) => ({ buf, dur: 1000 / fps })),
    ...slideBufs.map((buf) => ({ buf, dur: 1000 })),
  ];
  // Assemble the animated WebP in Node (ffmpeg 8's webp muxer corrupts mixed delays)
  const anim = await buildAnimatedWebP(frames.map(fr => fr.buf), frames.map(fr => fr.dur));
  await fsp.writeFile(outTmp, anim);
}

// Build an animated WebP from still frames (each a RIFF/WEBP file with a single
// VP8/VP8L image chunk). Deterministic, version-independent — ffmpeg's webp muxer
// corrupts mixed/short frame delays (observed with ffmpeg 8: 0ms / garbage delays).
// frames: array of Buffers (still webp files). delaysMs: per-frame duration.
async function buildAnimatedWebP(frames, delaysMs) {
  if (!frames.length) throw new Error('buildAnimatedWebP: no frames');
  // canvas size from the first frame's VP8/VP8L image header
  const dims = await getWebpDims(frames[0]);
  const W = dims.width, H = dims.height;

  // VP8X chunk (animation flag 0x02), 10 bytes payload
  const vp8x = Buffer.alloc(10);
  vp8x.writeUInt8(0x02, 0);                       // flags: animation
  vp8x.writeUIntLE(W - 1, 4, 3);                  // canvas width - 1
  vp8x.writeUIntLE(H - 1, 7, 3);                  // canvas height - 1

  // ANIM chunk: background color (4B) + loop count (2B, 0 = infinite)
  const anim = Buffer.alloc(6);
  anim.writeUInt32LE(0, 0);                       // background: black
  anim.writeUInt16LE(0, 4);                       // loop forever

  const chunks = [chunk('VP8X', vp8x), chunk('ANIM', anim)];
  for (let i = 0; i < frames.length; i++) {
    const img = stripWebpContainer(frames[i]);
    const anmf = Buffer.alloc(16 + img.length);
    anmf.writeUIntLE(0, 0, 3);                    // frame x
    anmf.writeUIntLE(0, 3, 3);                    // frame y
    anmf.writeUIntLE(W - 1, 6, 3);                // frame width - 1
    anmf.writeUIntLE(H - 1, 9, 3);                // frame height - 1
    anmf.writeUIntLE(Math.max(1, Math.round(delaysMs[i])), 12, 3); // duration ms
    anmf.writeUInt8(0, 15);                       // flags: no blending (dispose to bg)
    img.copy(anmf, 16);
    chunks.push(chunk('ANMF', anmf));
  }

  const body = Buffer.concat(chunks.map(c => c));
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(4 + body.length, 4);         // file size - 8
  riff.write('WEBP', 8, 'latin1');
  return Buffer.concat([riff, body]);
}

function chunk(tag, payload) {
  const b = Buffer.alloc(8 + payload.length);
  b.write(tag, 0, 'latin1');
  b.writeUInt32LE(payload.length, 4);
  payload.copy(b, 8);
  return b;
}

// Read width/height from a still WebP's VP8/VP8L image header
async function getWebpDims(buf) {
  const sharp = getSharp();
  const m = await sharp(buf).metadata();
  return { width: m.width, height: m.height };
}

// Strip the RIFF/WEBP container, return the image chunk(s) (VP8 or VP8L) verbatim
function stripWebpContainer(buf) {
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') {
    throw new Error('stripWebpContainer: not a webp');
  }
  let i = 12;
  const parts = [];
  while (i + 8 <= buf.length) {
    const tag = buf.toString('latin1', i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    // skip VP8X (the stills are plain VP8/VP8L; VP8X would need frame-level handling)
    if (tag !== 'VP8X' && tag !== 'ALPH') {
      parts.push(buf.subarray(i, i + 8 + size));
    }
    i += 8 + size + (size % 2);
  }
  if (!parts.length) throw new Error('stripWebpContainer: no image chunk');
  return Buffer.concat(parts);
}

// ---------- Concurrency limiter & metrics ----------
// 20 parallel mode=mix requests would spawn 600+ ffmpeg processes on a Pi 5 and
// time everything out. Serialize video generation: MAX_JOBS ffmpeg jobs run in
// parallel, the rest wait in a FIFO queue. Images are cheap — they bypass it.
const DEFAULT_MAX_JOBS = Math.max(1, Math.min(8, CPUS));
const MAX_JOBS = Math.max(1, parseInt(process.env.THUMBD_MAX_JOBS || String(DEFAULT_MAX_JOBS), 10) || DEFAULT_MAX_JOBS);
const DEFAULT_MAX_IMG_JOBS = Math.max(1, Math.min(8, CPUS));
const MAX_IMG_JOBS = Math.max(1, parseInt(process.env.THUMBD_MAX_IMG_JOBS || String(DEFAULT_MAX_IMG_JOBS), 10) || DEFAULT_MAX_IMG_JOBS);
let activeJobs = 0;
const jobQueue = [];
let activeImgJobs = 0;
const imgQueue = [];
let tmpSeq = 0;
let inFlight = 0;
let activeImages = 0;
let activeVideoStill = 0;
let activeProbes = 0;

function makeEmptyStats() {
  return {
    reqs: 0,
    thumbHit: 0,
    thumbGenImg: 0,
    thumbGenStill: 0,
    thumbGenAnim: 0,
    probeHit: 0,
    probeMiss: 0,
    errors: 0,
    aborted: 0,
    peakInFlight: 0,
    peakImg: 0,
    peakStill: 0,
    peakJobs: 0,
    peakQueue: 0,
    peakProbes: 0,
    genCount: 0,
    genTotalMs: 0,
    maxGenMs: 0,
    maxWaitMs: 0,
  };
}

let stats = makeEmptyStats();

function bumpPeak(key, val) {
  if (val > stats[key]) stats[key] = val;
}

function getStatsSnapshot() {
  return {
    ...stats,
    inFlight,
    activeImages,
    activeVideoStill,
    activeJobs,
    queueLen: jobQueue.length,
    activeProbes,
    maxJobs: MAX_JOBS,
  };
}

function resetStats() {
  const snap = getStatsSnapshot();
  stats = makeEmptyStats();
  // Seed peaks with currently active gauges so an ongoing request is reflected in the next window.
  stats.peakInFlight = inFlight;
  stats.peakImg = activeImages;
  stats.peakStill = activeVideoStill;
  stats.peakJobs = activeJobs;
  stats.peakQueue = jobQueue.length;
  stats.peakProbes = activeProbes;
  return snap;
}

function formatStatsLine(snap, windowSec) {
  const genTotal = snap.thumbGenImg + snap.thumbGenStill + snap.thumbGenAnim;
  const avgGenMs = snap.genCount > 0 ? Math.round(snap.genTotalMs / snap.genCount) : 0;
  const load1m = os.loadavg()[0].toFixed(2);
  const mem = process.memoryUsage();
  const rssMb = Math.round(mem.rss / (1024 * 1024));
  const heapMb = Math.round(mem.heapUsed / (1024 * 1024));
  return (
    `stats window=${windowSec}s reqs=${snap.reqs} thumb_hit=${snap.thumbHit} ` +
    `thumb_gen=${genTotal}(img=${snap.thumbGenImg},still=${snap.thumbGenStill},anim=${snap.thumbGenAnim}) ` +
    `probe_hit=${snap.probeHit} probe_miss=${snap.probeMiss} err=${snap.errors} aborted=${snap.aborted} ` +
    `peak_inflight=${snap.peakInFlight} peak_img=${snap.peakImg} peak_still=${snap.peakStill} ` +
    `peak_jobs=${snap.peakJobs}/${snap.maxJobs} peak_queue=${snap.peakQueue} peak_probes=${snap.peakProbes} ` +
    `avg_gen_ms=${avgGenMs} max_gen_ms=${snap.maxGenMs} max_wait_ms=${snap.maxWaitMs} ` +
    `load1m=${load1m} rss_mb=${rssMb} heap_mb=${heapMb}`
  );
}

function startStatsReporter(intervalSec) {
  if (!intervalSec || intervalSec <= 0) return null;
  const timer = setInterval(() => {
    const snap = resetStats();
    if (snap.reqs > 0 || snap.inFlight > 0 || snap.activeJobs > 0 || snap.queueLen > 0) {
      logInfo(formatStatsLine(snap, intervalSec));
    }
  }, intervalSec * 1000);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

function withJobLock(fn, hooks = null) {
  return new Promise((resolve, reject) => {
    const enqueuedAt = Date.now();
    const run = () => {
      activeJobs++;
      bumpPeak('peakJobs', activeJobs);
      const waitMs = Date.now() - enqueuedAt;
      if (waitMs > stats.maxWaitMs) stats.maxWaitMs = waitMs;
      if (hooks && typeof hooks.onStart === 'function') {
        hooks.onStart({ waitMs, activeJobs, queueLen: jobQueue.length, maxJobs: MAX_JOBS });
      }
      fn().then(
        (v) => { activeJobs--; pump(); resolve(v); },
        (e) => { activeJobs--; pump(); reject(e); }
      );
    };
    const pump = () => {
      const next = jobQueue.shift();
      if (next) next();
    };
    if (activeJobs < MAX_JOBS) {
      run();
    } else {
      jobQueue.push(run);
      bumpPeak('peakQueue', jobQueue.length);
      if (hooks && typeof hooks.onQueued === 'function') {
        hooks.onQueued({ queueLen: jobQueue.length, activeJobs, maxJobs: MAX_JOBS });
      }
    }
  });
}

function withImageLock(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      activeImgJobs++;
      fn().then(
        (v) => { activeImgJobs--; pump(); resolve(v); },
        (e) => { activeImgJobs--; pump(); reject(e); }
      );
    };
    const pump = () => {
      const next = imgQueue.shift();
      if (next) next();
    };
    if (activeImgJobs < MAX_IMG_JOBS) {
      run();
    } else {
      imgQueue.push(run);
    }
  });
}

// ---------- Request handler ----------
async function handle(req, res) {
  const startMs = Date.now();
  const u = new URL(req.url, 'http://localhost');
  // Health always reachable without auth (Docker healthcheck)
  if (u.pathname === '/health') {
    logDebug('health status=200');
    return send(res, 200, 'ok');
  }

  inFlight++;
  stats.reqs++;
  bumpPeak('peakInFlight', inFlight);

  let released = false;
  const releaseInFlight = () => {
    if (released) return;
    released = true;
    inFlight = Math.max(0, inFlight - 1);
  };
  res.on('finish', releaseInFlight);
  res.on('close', () => {
    const aborted = !res.writableEnded;
    releaseInFlight();
    if (aborted) {
      stats.aborted++;
      logWarn(
        `client_aborted ep=${u.pathname} elapsed_ms=${Date.now() - startMs} ` +
        `inflight=${inFlight} jobs=${activeJobs}/${MAX_JOBS} queue=${jobQueue.length} ` +
        `path=${safeVal(u.searchParams.get('path'))}`
      );
    }
  });

  const fail = (code, body, reason) => {
    stats.errors++;
    logWarn(
      `req ep=${u.pathname} status=${code} ms=${Date.now() - startMs} ` +
      `reason=${safeVal(reason || body)} inflight=${inFlight} path=${safeVal(u.searchParams.get('path'))}`
    );
    return send(res, code, body);
  };

  if (req.method !== 'GET') return fail(405, 'method not allowed (only GET)', 'method_not_allowed');
  // Auth
  if (TOKEN) {
    const got = req.headers['x-thumb-token'] || '';
    const a = Buffer.from(got);
    const b = Buffer.from(TOKEN);
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!ok) return fail(401, 'unauthorized', 'unauthorized');
  }
  // Duration metadata: GET /duration?path=<abs> -> JSON {"duration": 12.34}
  // Used by xplorer's getMediaLength() — thumbd owns ffprobe, so the app image
  // stays slim (no ffmpeg/ffprobe binaries needed in the PHP container).
  if (u.pathname === '/duration') {
    const dp = u.searchParams.get('path');
    if (!dp) return fail(400, 'missing path', 'missing_path');
    const dAbs = path.isAbsolute(dp) ? dp : path.join(ROOTS[0], dp);
    const dReal = await resolveAllowed(dAbs);
    if (!dReal) return fail(403, 'path not allowed or not found', 'forbidden_path');
    // cache: duration of a file never changes → key on realPath only
    const dKey = crypto.createHash('sha1').update(`duration|${dReal}`).digest('hex');
    const dFile = path.join(CACHE_DIR, dKey.slice(0, 2), dKey + '.json');
    try {
      const cached = await fsp.readFile(dFile, 'utf8');
      stats.probeHit++;
      logDebug(`probe ep=/duration src=cache ms=${Date.now() - startMs} inflight=${inFlight} path=${safeVal(dReal)}`);
      return send(res, 200, cached, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=604800' });
    } catch { /* cache miss */ }
    stats.probeMiss++;
    activeProbes++;
    bumpPeak('peakProbes', activeProbes);
    let dInfo;
    try {
      dInfo = await probeVideo(dReal);
    } finally {
      activeProbes = Math.max(0, activeProbes - 1);
    }
    const dur = (dInfo && dInfo.duration !== null) ? dInfo.duration : 0;
    const body = JSON.stringify({ duration: dur });
    await fsp.mkdir(path.dirname(dFile), { recursive: true }).catch(() => {});
    await fsp.writeFile(dFile, body).catch(() => {});
    logInfo(`probe ep=/duration src=probed ms=${Date.now() - startMs} duration=${dur}s inflight=${inFlight} probes=${activeProbes} path=${safeVal(dReal)}`);
    return send(res, 200, body, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=604800' });
  }
  // Display dimensions: GET /dimensions?path=<abs> -> JSON
  //   {"width":1080,"height":1920,"rotation":90}
  // Used by xplorer to pick the media-wall tile shape (portrait -> tall tile).
  // width/height are display dimensions (rotation applied); 0/0 when the file is
  // not probeable. Nothing is cached in that case, so a later retry can succeed.
  if (u.pathname === '/dimensions') {
    const mp = u.searchParams.get('path');
    if (!mp) return fail(400, 'missing path', 'missing_path');
    const mAbs = path.isAbsolute(mp) ? mp : path.join(ROOTS[0], mp);
    const mReal = await resolveAllowed(mAbs);
    if (!mReal) return fail(403, 'path not allowed or not found', 'forbidden_path');
    const mKey = crypto.createHash('sha1').update(`dimensions|${mReal}`).digest('hex');
    const mFile = path.join(CACHE_DIR, mKey.slice(0, 2), mKey + '.json');
    try {
      const cached = await fsp.readFile(mFile, 'utf8');
      stats.probeHit++;
      logDebug(`probe ep=/dimensions src=cache ms=${Date.now() - startMs} inflight=${inFlight} path=${safeVal(mReal)}`);
      return send(res, 200, cached, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=604800' });
    } catch { /* cache miss */ }
    stats.probeMiss++;
    activeProbes++;
    bumpPeak('peakProbes', activeProbes);
    let mInfo;
    try {
      mInfo = await probeMediaDimensions(mReal);
    } finally {
      activeProbes = Math.max(0, activeProbes - 1);
    }
    const rw = (mInfo && mInfo.width) || 0;
    const rh = (mInfo && mInfo.height) || 0;
    const rrot = (mInfo && mInfo.rotation) || 0;
    const mBody = JSON.stringify({
      width: rw,
      height: rh,
      rotation: rrot,
    });
    if (mInfo && mInfo.width && mInfo.height) {
      // dimensions of a file never change → cache only real results
      await fsp.mkdir(path.dirname(mFile), { recursive: true }).catch(() => {});
      await fsp.writeFile(mFile, mBody).catch(() => {});
    }
    logInfo(`probe ep=/dimensions src=probed ms=${Date.now() - startMs} dims=${rw}x${rh} rot=${rrot} inflight=${inFlight} probes=${activeProbes} path=${safeVal(mReal)}`);
    return send(res, 200, mBody, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=604800' });
  }
  if (u.pathname !== '/thumb') return fail(404, 'not found: use /thumb?path=...&w=...&h=...&t=...', 'not_found');

  const p = u.searchParams.get('path');
  const w = Math.min(parseInt(u.searchParams.get('w') || '320', 10) || 320, 1024);
  const h = Math.min(parseInt(u.searchParams.get('h') || '320', 10) || 320, 1024);
  const t = Math.max(0, parseFloat(u.searchParams.get('t') || '1'));
  const fit = u.searchParams.get('fit') === 'cover' ? 'cover' : 'contain';  // contain (keep ratio) default, cover (fill+crop) optional
  const noCache = u.searchParams.get('nocache') === '1' || u.searchParams.get('nocache') === 'true';  // skip cache read (still writes)
  // Video modes: still (default, single frame at t), preview (animated, t..t+d at fps),
  // slideshow (animated, either interval=seconds or count=N evenly spaced over the video)
  const mode = u.searchParams.get('mode') || 'still';
  const d = Math.max(0.2, parseFloat(u.searchParams.get('d') || '3'));
  const fps = Math.max(1, Math.min(30, parseInt(u.searchParams.get('fps') || '10', 10) || 10));
  const count = Math.max(1, Math.min(60, parseInt(u.searchParams.get('count') || '3', 10) || 3));
  const interval = Math.max(0, parseFloat(u.searchParams.get('interval') || '0'));
  if (!p) return fail(400, 'missing path', 'missing_path');

  // Build absolute path (only if already absolute, otherwise relative to first root)
  const abs = path.isAbsolute(p) ? p : path.join(ROOTS[0], p);
  const real = await resolveAllowed(abs);
  if (!real) return fail(403, 'path not allowed or not found', 'forbidden_path');

  const stat = await fsp.stat(real).catch(() => null);
  if (!stat || !stat.isFile()) return fail(404, 'not a file', 'not_a_file');
  if (stat.size > MAX_SRC_MB * 1024 * 1024) return fail(413, 'source too large', 'source_too_large');

  const ext = path.extname(real).toLowerCase();
  const isVideo = VIDEO_EXTS.has(ext);
  const isImage = IMAGE_EXTS.has(ext);
  if (!isVideo && !isImage) return fail(415, 'unsupported type', 'unsupported_type');

  // Cache (read is skipped when nocache=1, write still happens below)
  // cache key includes the mode + mode params so still/preview/slideshow stay separate
  const cacheVariant = isVideo ? `${mode}|${t}|${d}|${fps}|${count}|${interval}|${fit}` : fit;
  const cp = cachePath(real, w, h, cacheVariant);
  if (!noCache) {
    try {
      const st = await fsp.stat(cp);
      stats.thumbHit++;
      const hitMs = Date.now() - startMs;
      const outKb = Math.round(st.size / 1024);
      const kindLabel = isVideo ? 'video' : 'image';
      const modeLabel = isVideo ? mode : 'img';
      if (hitMs >= 250) {
        logWarn(`thumb status=200 src=cache slow=true kind=${kindLabel} mode=${modeLabel} size=${w}x${h} ms=${hitMs} out_kb=${outKb} inflight=${inFlight} path=${safeVal(real)}`);
      } else {
        logDebug(`thumb status=200 src=cache kind=${kindLabel} mode=${modeLabel} size=${w}x${h} ms=${hitMs} out_kb=${outKb} inflight=${inFlight} path=${safeVal(real)}`);
      }
      res.writeHead(200, {
        'Content-Type': 'image/webp',
        'Cache-Control': `public, max-age=${CACHE_MAX_AGE}`,
        'ETag': `"${st.size}-${st.mtimeMs}"`,
        'X-Thumb-Source': 'cache',
      });
      fs.createReadStream(cp).pipe(res);
      return;
    } catch { /* cache miss */ }
  }

  // Generate
  const outTmp = `${cp}.tmp.${process.pid}.${++tmpSeq}`;
  await fsp.mkdir(path.dirname(cp), { recursive: true });
  let waitMs = 0;
  let workMs = 0;
  let usedDec = isVideo ? 'sw' : 'sharp';
  try {
    if (isVideo) {
      // Video generation is heavy (mix = 30+ frames) — run it through the
      // concurrency limiter so N parallel requests don't overwhelm the host.
      // mode=still is ONE cheap ffmpeg call (~0.5s): it bypasses the queue so a
      // cold grid fills instantly with stills while the animated mixes queue up
      // behind them (progressive thumbnail UX — see xplorer thumb-progressive.js).
      const run = async () => {
        const workStart = Date.now();
        const info = await probeVideo(real);
        const v4l2 = await getV4l2Available();
        const decoder = pickDecoder(info ? info.codec : null, v4l2);
        usedDec = decoder || 'sw';
        const dur = info ? info.duration : null;
        // clamp seek time for long videos (still/preview only)
        const seek = (dur !== null && t > dur) ? Math.max(0, Math.min(VIDEO_MAX_SEC, dur / 2)) : t;
        const generate = async (dec) => {
        if (mode === 'preview') {
          // clamp the preview window to the video end (short videos, ts >= dur fails)
          const dEff = dur !== null ? Math.max(0.05, Math.min(d, dur - seek)) : d;
          await makeVideoPreview(real, w, h, seek, dEff, fps, outTmp, dec, fit);
        } else if (mode === 'slideshow' || mode === 'mix') {
          // build the frame timestamps: interval (every N s) or count (N evenly spaced)
          let times;
          if (!dur) throw new Error(`${mode} needs a probeable video duration`);
          // mix: slideshow covers only the video AFTER the preview window (t+d).
          // Clamp the preview window to the video end so SHORT videos (< t+d) don't
          // seek past the last frame (ffmpeg fails on ts >= duration → 500).
          const dEff = mode === 'mix' ? Math.max(0.05, Math.min(d, dur - seek)) : d;
          const restStart = mode === 'mix' ? Math.min(seek + dEff, dur) : 0;
          const restLen = Math.max(0, dur - restStart);
          if (interval > 0) {
            times = [];
            for (let ts = restStart + interval; ts < dur && times.length < 60; ts += interval) times.push(ts);
            if (!times.length) times = restLen >= 0.5 ? [Math.max(restStart + 0.5, dur / 2)] : [Math.max(0.1, dur / 2)];
          } else {
            times = [];
            if (restLen >= 0.5) {
              for (let i = 1; i <= count; i++) times.push(restStart + restLen * i / (count + 1));
            } else {
              // preview already covers (nearly) the whole video → single frame at the middle
              times = [Math.max(0.1, dur / 2)];
            }
          }
          if (mode === 'mix') {
            await makeVideoMix(real, w, h, seek, dEff, fps, times, outTmp, dec, fit);
          } else {
            await makeVideoSlideshow(real, w, h, times, outTmp, dec, fit);
          }
        } else {
          await makeVideoThumb(real, w, h, seek, outTmp, dec, fit);
        }
      };
      try {
        await generate(decoder);
      } catch (hwErr) {
        if (decoder) {
          // HW decode failed (e.g. codec details) → software retry
          usedDec = 'sw-fallback';
          logWarn(`hw_decode_fallback path=${safeVal(real)} err=${safeVal(hwErr.message)}`);
          await generate(null);
        } else throw hwErr;
      } finally {
        workMs = Date.now() - workStart;
      }
      };
      if (mode === 'still') {
        activeVideoStill++;
        bumpPeak('peakStill', activeVideoStill);
        try {
          await run();  // cheap single ffmpeg call — no queue, grid fills instantly
        } finally {
          activeVideoStill = Math.max(0, activeVideoStill - 1);
        }
        stats.thumbGenStill++;
      } else {
        await withJobLock(run, {
          onQueued: ({ queueLen }) => {
            const msg = `thumb queued mode=${mode} active=${activeJobs}/${MAX_JOBS} queue=${queueLen} inflight=${inFlight} path=${safeVal(real)}`;
            if (queueLen >= MAX_JOBS * 2) logWarn(msg);
            else logInfo(msg);
          },
          onStart: ({ waitMs: wms }) => { waitMs = wms; },
        });  // preview/slideshow/mix are heavy — serialize
        stats.thumbGenAnim++;
      }
    } else {
      usedDec = await withImageLock(async () => {
        activeImages++;
        bumpPeak('peakImg', activeImages);
        const workStart = Date.now();
        try {
          return await makeImageThumb(real, w, h, outTmp, fit);
        } finally {
          workMs = Date.now() - workStart;
          activeImages = Math.max(0, activeImages - 1);
        }
      });
      stats.thumbGenImg++;
    }
    // Retry rename if directory was removed between mkdir and rename
    let renamed = false;
    for (let attempt = 0; attempt < 3 && !renamed; attempt++) {
      try {
        await fsp.rename(outTmp, cp);
        renamed = true;
      } catch (renameErr) {
        if (renameErr.code === 'ENOENT') {
          // Directory may have been removed; recreate and retry
          await fsp.mkdir(path.dirname(cp), { recursive: true });
          continue;
        }
        throw renameErr;
      }
    }
    if (!renamed) {
      // Final attempt failed after retries
      await fsp.unlink(outTmp).catch(() => {});
      stats.errors++;
      logError(`thumb status=500 kind=${isVideo ? 'video' : 'image'} mode=${isVideo ? mode : 'img'} wait_ms=${waitMs} total_ms=${Date.now() - startMs} inflight=${inFlight} jobs=${activeJobs}/${MAX_JOBS} queue=${jobQueue.length} path=${safeVal(real)} err=rename_failed_after_3_attempts`);
      return send(res, 500, 'thumbnail failed: rename failed');
    }
  } catch (e) {
    await fsp.unlink(outTmp).catch(() => {});
    stats.errors++;
    logError(`thumb status=500 kind=${isVideo ? 'video' : 'image'} mode=${isVideo ? mode : 'img'} wait_ms=${waitMs} total_ms=${Date.now() - startMs} inflight=${inFlight} jobs=${activeJobs}/${MAX_JOBS} queue=${jobQueue.length} path=${safeVal(real)} err=${safeVal(e.message)}`);
    return send(res, 500, 'thumbnail failed: ' + e.message);
  }

  const st = await fsp.stat(cp);
  const totalMs = Date.now() - startMs;
  stats.genCount++;
  stats.genTotalMs += totalMs;
  if (totalMs > stats.maxGenMs) stats.maxGenMs = totalMs;
  logInfo(
    `thumb status=200 src=generated kind=${isVideo ? 'video' : 'image'} mode=${isVideo ? mode : 'img'} ` +
    `size=${w}x${h} fit=${fit} dec=${usedDec} wait_ms=${waitMs} work_ms=${workMs} total_ms=${totalMs} ` +
    `out_kb=${Math.round(st.size / 1024)} inflight=${inFlight} img=${activeImages} still=${activeVideoStill} ` +
    `jobs=${activeJobs}/${MAX_JOBS} queue=${jobQueue.length} path=${safeVal(real)}`
  );
  res.writeHead(200, {
    'Content-Type': 'image/webp',
    'Cache-Control': `public, max-age=${CACHE_MAX_AGE}`,
    'ETag': `"${st.size}-${st.mtimeMs}"`,
    'X-Thumb-Source': 'generated',
  });
  fs.createReadStream(cp).pipe(res);
}

// ---------- Start ----------
async function main() {
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  const hw = await getV4l2Available();
  let sharpConc = 'unavailable';
  try {
    sharpConc = getSharp().concurrency();
  } catch { /* sharp binary may target a different platform in dev */ }
  const uvPool = process.env.UV_THREADPOOL_SIZE || 4;
  logInfo(
    `thumbd start port=${PORT} roots=${ROOTS.join(',')} cache=${CACHE_DIR} ` +
    `max_jobs=${MAX_JOBS} max_img_jobs=${MAX_IMG_JOBS} sharp_concurrency=${sharpConc} uv_threadpool=${uvPool} ` +
    `max_src_mb=${MAX_SRC_MB} video_max_sec=${VIDEO_MAX_SEC} ` +
    `v4l2=${V4L2 || 'off'} v4l2_available=${hw} log_level=${levelName(logLevel)} ` +
    `stats_interval_s=${STATS_INTERVAL_SEC} cpus=${CPUS}`
  );
  startStatsReporter(STATS_INTERVAL_SEC);
  http.createServer(handle).listen(PORT, '0.0.0.0');
}

// Testability: only start when executed directly; export as module otherwise
if (require.main === module) {
  main().catch(e => { logError('fatal:', e); process.exit(1); });
}

// Test hook: tests run with a temp dir instead of /data (ROOTS is otherwise fixed).
function setRoots(roots) { ROOTS = Array.isArray(roots) ? roots : [roots]; resolvedRootsCache = null; }

module.exports = {
  handle, main, resolveAllowed, cachePath, probeVideo, hasV4l2Decoder, pickDecoder,
  makeImageThumb, makeVideoThumb, makeVideoPreview, makeVideoSlideshow, makeVideoMix,
  buildAnimatedWebP, stripWebpContainer, extractVideoFrame, extractVideoPreviewFrames,
  extractVideoFramesParallel, mapConcurrent, withJobLock, withImageLock,
  parseLogLevel, setLogLevel, getLogLevel, getStatsSnapshot, resetStats, formatStatsLine,
  setRoots, ROOTS, CACHE_DIR, TOKEN, PORT, CPUS, MAX_JOBS, MAX_IMG_JOBS,
};
