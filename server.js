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
// (matches the legacy AnimatedVideoThumbnail: -ss 1 -t 3 -vf fps=10 -loop 0).
// Frames are assembled in Node (buildAnimatedWebP) — ffmpeg's webp muxer (v8) uses
// delta-frames/partial ANMF chunks with merged delays, which is inconsistent.
async function makeVideoPreview(realPath, w, h, t, d, fps, outTmp, decoder, fit = 'contain') {
  const nFrames = Math.max(1, Math.round(fps * d));
  const pFiles = [];
  try {
    for (let i = 0; i < nFrames; i++) {
      const ts = Math.max(0, t + i / fps);
      const f = `${outTmp}.p${i}`;
      await extractVideoFrame(realPath, ts, w, h, f, decoder, fit);
      pFiles.push(f);
    }
    const bufs = [];
    for (const f of pFiles) bufs.push(await fsp.readFile(f));
    const anim = await buildAnimatedWebP(bufs, bufs.map(() => Math.round(1000 / fps)));
    await fsp.writeFile(outTmp, anim);
  } finally {
    for (const f of pFiles) await fsp.unlink(f).catch(() => {});
  }
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
      frames.push(await fsp.readFile(f));
    }
    const anim = await buildAnimatedWebP(frames, frames.map(() => 1000));  // 1s per frame
    await fsp.writeFile(outTmp, anim);
  } finally {
    for (let i = 0; i < frames.length; i++) await fsp.unlink(`${outTmp}.f${i}`).catch(() => {});
  }
}

// Mix: `mode=mix` — animated preview (t..t+d at fps) followed by a slideshow of the
// remaining video (count evenly spaced frames, or one frame every interval seconds).
// Preview frames are shown at 1/fps s each, slideshow frames for 1 s each.
async function makeVideoMix(realPath, w, h, t, d, fps, times, outTmp, decoder, fit = 'contain') {
  const frames = [];   // {buf, dur}
  try {
    // 1) preview frames: fps*d frames from t..t+d, each displayed 1/fps s
    const nPrev = Math.max(1, Math.round(fps * d));
    const pFiles = [];
    for (let i = 0; i < nPrev; i++) {
      const ts = Math.max(0, t + i / fps);
      const f = `${outTmp}.p${i}`;
      await extractVideoFrame(realPath, ts, w, h, f, decoder, fit);
      pFiles.push(f);
    }
    for (const f of pFiles) frames.push({ buf: await fsp.readFile(f), dur: 1000 / fps });
    // 2) slideshow frames of the remaining video, each displayed 1 s
    const sFiles = [];
    for (let i = 0; i < times.length; i++) {
      const f = `${outTmp}.s${i}`;
      await extractVideoFrame(realPath, times[i], w, h, f, decoder, fit);
      sFiles.push(f);
    }
    for (const f of sFiles) frames.push({ buf: await fsp.readFile(f), dur: 1000 });
    // 3) assemble the animated WebP in Node (ffmpeg 8's webp muxer corrupts mixed delays)
    const anim = await buildAnimatedWebP(frames.map(fr => fr.buf), frames.map(fr => fr.dur));
    await fsp.writeFile(outTmp, anim);
  } finally {
    for (let i = 0; i < frames.length; i++) {
      await fsp.unlink(`${outTmp}.p${i}`).catch(() => {});
      await fsp.unlink(`${outTmp}.s${i}`).catch(() => {});
    }
  }
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
  const sharp = require('sharp');
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

// Test hook: tests run with a temp dir instead of /data (ROOTS is otherwise fixed).
function setRoots(roots) { ROOTS = Array.isArray(roots) ? roots : [roots]; }

module.exports = {
  handle, main, resolveAllowed, cachePath, probeVideo, hasV4l2Decoder, pickDecoder,
  makeImageThumb, makeVideoThumb, makeVideoPreview, makeVideoSlideshow, makeVideoMix,
  buildAnimatedWebP, extractVideoFrame,
  setRoots, ROOTS, CACHE_DIR, TOKEN, PORT,
};
