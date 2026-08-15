// thumbd — persistent thumbnail daemon (images: sharp/libvips, videos: ffmpeg with HW decode)
// Single-user, Docker, ARM64-optimized. No Express — only Node built-in http.
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

// ---------- Configuration (env) ----------
const PORT = parseInt(process.env.THUMBD_PORT || '8090', 10);
const ROOTS = (process.env.THUMBD_ROOTS || '/data').split(',').map(s => s.trim()).filter(Boolean);
const TOKEN = process.env.THUMBD_TOKEN || '';            // empty = no auth (internal only)
const CACHE_DIR = process.env.THUMBD_CACHE || '/cache';
const CACHE_MAX_AGE = 60 * 60 * 24 * 7;                  // 7 day disk cache
const MAX_SRC_MB = parseInt(process.env.THUMBD_MAX_SRC_MB || '4096', 10); // source file limit (TV episodes are often 1-2 GB)
const VIDEO_MAX_SEC = parseInt(process.env.THUMBD_VIDEO_MAX_SEC || '600', 10); // videos >10min: only first 10min
const FFMPEG = process.env.THUMBD_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.THUMBD_FFPROBE || 'ffprobe';
const V4L2 = process.env.THUMBD_V4L2 || 'h264_v4l2m2m';   // HW decoder, if available
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.tif', '.tiff', '.bmp']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mpg', '.mpeg', '.avi', '.flv', '.wmv', '.asf', '.mkv', '.webm', '.m4v', '.ts']);

// ---------- Helpers ----------
function log(...a) { console.log(new Date().toISOString(), ...a); }

// Is the path inside one of the roots? (symlink-safe via realpath)
async function resolveAllowed(absPath) {
  const real = await fsp.realpath(absPath).catch(() => null);
  if (!real) return null;
  for (const root of ROOTS) {
    const r = await fsp.realpath(root).catch(() => null);
    if (r && (real === r || real.startsWith(r + path.sep))) return real;
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

// ---------- Video: codec + duration + HW-decode check ----------
function probeVideo(realPath) {
  // returns {codec, duration} or null
  return new Promise((resolve) => {
    execFile(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name:format=duration',
      '-of', 'json', realPath], { timeout: 15000 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const d = JSON.parse(stdout);
        const codec = d.streams && d.streams[0] ? d.streams[0].codec_name : null;
        const dur = d.format && d.format.duration ? parseFloat(d.format.duration) : null;
        resolve({ codec, duration: Number.isFinite(dur) ? dur : null });
      } catch { resolve(null); }
    });
  });
}

function hasV4l2Decoder(decoder) {
  return new Promise((resolve) => {
    // v4l2-m2m needs real /dev/video* devices in the container (Pi 5: video19+)
    let hasDev = false;
    try {
      hasDev = fs.readdirSync('/dev').some(n => n.startsWith('video'));
    } catch { hasDev = false; }
    if (!hasDev) return resolve(false);
    execFile(FFMPEG, ['-hide_banner', '-decoders'], { timeout: 10000 }, (err, stdout) => {
      if (err) return resolve(false);
      resolve(stdout.includes(decoder));
    });
  });
}

// Pi 5: NO HW H.264 decoder (only HEVC via rpi-hevc-dec) — h264 stays software.
function pickDecoder(codec, v4l2Available) {
  if (!v4l2Available || !codec) return null;
  if (codec === 'hevc' || codec === 'h265') return 'hevc_v4l2m2m';
  return null; // h264/mpeg/... => software
}

// ---------- Thumbnail generation ----------
async function makeImageThumb(realPath, w, h, outTmp, fit = 'contain') {
  const sharp = require('sharp');
  const sharpFit = fit === 'cover' ? 'cover' : 'inside';  // cover = fill+crop, inside = contain (keep ratio)
  await sharp(realPath, { failOn: 'none', limitInputPixels: 100_000_000 })
    .rotate()                       // respect EXIF orientation
    .resize(w, h, { fit: sharpFit, withoutEnlargement: true })
    .webp({ quality: 80 })
    .toFile(outTmp);
}

async function makeVideoThumb(realPath, w, h, t, outTmp, decoder, fit = 'contain') {
  const seek = Math.max(0, t);
  const decArgs = decoder ? ['-c:v', decoder] : [];   // null = software
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

// Animated preview: `mode=preview` — animated WebP from `t` for `d` seconds at `fps`
// (matches the legacy AnimatedVideoThumbnail: -ss 1 -t 3 -vf fps=10 -loop 0)
async function makeVideoPreview(realPath, w, h, t, d, fps, outTmp, decoder, fit = 'contain') {
  const decArgs = decoder ? ['-c:v', decoder] : [];
  const vf = fit === 'cover'
    ? `fps=${fps},scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`
    : `fps=${fps},scale=${w}:${h}:force_original_aspect_ratio=decrease`;
  await new Promise((resolve, reject) => {
    execFile(FFMPEG, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-ss', String(Math.max(0, t)),
      ...decArgs,
      '-i', realPath,
      '-t', String(Math.max(0.2, d)),
      '-vf', vf,
      '-loop', '0',
      '-q:v', '4',
      '-f', 'webp',
      outTmp,
    ], { timeout: 90000 }, (err) => err ? reject(err) : resolve());
  });
}

// Extract a single still frame to a file (helper for slideshow)
async function extractVideoFrame(realPath, ts, w, h, outFile, decoder, fit = 'contain') {
  const decArgs = decoder ? ['-c:v', decoder] : [];
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
  const frames = [];
  try {
    for (let i = 0; i < times.length; i++) {
      const f = `${outTmp}.f${i}`;
      await extractVideoFrame(realPath, times[i], w, h, f, decoder, fit);
      frames.push(f);
    }
    // Concatenate the stills into an animated WebP (each shown 1s)
    const inputs = [];
    const filterParts = [];
    frames.forEach((f, i) => {
      inputs.push('-loop', '1', '-t', '1', '-i', f);
      filterParts.push(`[${i}:v]`);
    });
    await new Promise((resolve, reject) => {
      execFile(FFMPEG, [
        '-y', '-hide_banner', '-loglevel', 'error',
        ...inputs,
        '-filter_complex', `${filterParts.join('')}concat=n=${frames.length}:v=1`,
        '-loop', '0',
        '-q:v', '4',
        '-f', 'webp',
        outTmp,
      ], { timeout: 90000 }, (err) => err ? reject(err) : resolve());
    });
  } finally {
    for (const f of frames) await fsp.unlink(f).catch(() => {});
  }
}

// ---------- Request handler ----------
async function handle(req, res) {
  if (req.method !== 'GET') return send(res, 405, 'method not allowed (only GET)');
  const u = new URL(req.url, 'http://localhost');
  // Health always reachable without auth (Docker healthcheck)
  if (u.pathname === '/health') return send(res, 200, 'ok');
  // Auth
  if (TOKEN) {
    const got = req.headers['x-thumb-token'] || '';
    const a = Buffer.from(got);
    const b = Buffer.from(TOKEN);
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!ok) return send(res, 401, 'unauthorized');
  }
  if (u.pathname !== '/thumb') return send(res, 404, 'not found: use /thumb?path=...&w=...&h=...&t=...');

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
  if (!p) return send(res, 400, 'missing path');

  // Build absolute path (only if already absolute, otherwise relative to first root)
  const abs = path.isAbsolute(p) ? p : path.join(ROOTS[0], p);
  const real = await resolveAllowed(abs);
  if (!real) return send(res, 403, 'path not allowed or not found');

  const stat = await fsp.stat(real).catch(() => null);
  if (!stat || !stat.isFile()) return send(res, 404, 'not a file');
  if (stat.size > MAX_SRC_MB * 1024 * 1024) return send(res, 413, 'source too large');

  const ext = path.extname(real).toLowerCase();
  const isVideo = VIDEO_EXTS.has(ext);
  const isImage = IMAGE_EXTS.has(ext);
  if (!isVideo && !isImage) return send(res, 415, 'unsupported type');

  // Cache (read is skipped when nocache=1, write still happens below)
  // cache key includes the mode + mode params so still/preview/slideshow stay separate
  const cacheVariant = isVideo ? `${mode}|${t}|${d}|${fps}|${count}|${interval}|${fit}` : fit;
  const cp = cachePath(real, w, h, cacheVariant);
  if (!noCache) {
    try {
      const st = await fsp.stat(cp);
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
  const outTmp = cp + '.tmp.' + process.pid;
  await fsp.mkdir(path.dirname(cp), { recursive: true });
  try {
    if (isVideo) {
      const info = await probeVideo(real);
      const v4l2 = await hasV4l2Decoder(V4L2).catch(() => false);
      const decoder = pickDecoder(info ? info.codec : null, v4l2);
      const dur = info ? info.duration : null;
      // clamp seek time for long videos (still/preview only)
      const seek = (dur !== null && t > dur) ? Math.max(0, Math.min(VIDEO_MAX_SEC, dur / 2)) : t;
      const generate = async (dec) => {
        if (mode === 'preview') {
          await makeVideoPreview(real, w, h, seek, d, fps, outTmp, dec, fit);
        } else if (mode === 'slideshow') {
          // build the frame timestamps: interval (every N s) or count (N evenly spaced)
          let times;
          if (!dur) throw new Error('slideshow needs a probeable video duration');
          if (interval > 0) {
            times = [];
            for (let ts = interval; ts < dur && times.length < 60; ts += interval) times.push(ts);
            if (!times.length) times = [Math.max(0.5, dur / 2)];
          } else {
            times = [];
            for (let i = 1; i <= count; i++) times.push(dur * i / (count + 1));
          }
          await makeVideoSlideshow(real, w, h, times, outTmp, dec, fit);
        } else {
          await makeVideoThumb(real, w, h, seek, outTmp, dec, fit);
        }
      };
      try {
        await generate(decoder);
      } catch (hwErr) {
        if (decoder) {
          // HW decode failed (e.g. codec details) → software retry
          log('hw decode failed, fallback to software:', real, hwErr.message);
          await generate(null);
        } else throw hwErr;
      }
    } else {
      await makeImageThumb(real, w, h, outTmp, fit);
    }
    await fsp.rename(outTmp, cp);
  } catch (e) {
    await fsp.unlink(outTmp).catch(() => {});
    log('thumb failed', real, e.message);
    return send(res, 500, 'thumbnail failed: ' + e.message);
  }

  const st = await fsp.stat(cp);
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
  const hw = await hasV4l2Decoder(V4L2).catch(() => false);
  log(`thumbd start port=${PORT} roots=${ROOTS.join(',')} cache=${CACHE_DIR} v4l2_devices=${hw} (HEVC-only on Pi 5; H.264=software)`);
  http.createServer(handle).listen(PORT, '0.0.0.0');
}

// Testability: only start when executed directly; export as module otherwise
if (require.main === module) {
  main().catch(e => { log('fatal:', e); process.exit(1); });
}

module.exports = {
  handle, main, resolveAllowed, cachePath, probeVideo, hasV4l2Decoder, pickDecoder,
  makeImageThumb, makeVideoThumb, makeVideoPreview, makeVideoSlideshow, extractVideoFrame,
  ROOTS, CACHE_DIR, TOKEN, PORT,
};
