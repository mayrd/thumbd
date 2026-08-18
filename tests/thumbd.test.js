// thumbd test suite — node:test (no framework needed)
// Run: node --test tests/thumbd.test.js
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const sharp = require('sharp');

// Set env BEFORE require (constants are read at module load)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'thumbd-test-'));
const ROOT = path.join(TMP, 'media');
const CACHE = path.join(TMP, 'cache');
fs.mkdirSync(ROOT, { recursive: true });

process.env.THUMBD_CACHE = CACHE;
process.env.THUMBD_TOKEN = 'testtoken123';
process.env.THUMBD_PORT = '0'; // ephemeral

const thumbd = require('../server.js');
thumbd.setRoots([ROOT]); // tests run on a temp dir; production root is always /data

let server;
let baseUrl;
let testImage;   // test image path inside the root
let testVideo;   // test video path inside the root
let shortVideo;  // SHORT video (2s) — regression: mix/preview used to seek past the end → 500

before(async () => {
  // Generate a test image (sharp) — small red PNG
  const sharp = require('sharp');
  testImage = path.join(ROOT, 'test.png');
  await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 30, b: 30 } } })
    .png().toFile(testImage);

  // Generate a test video — 12s color bars, H.264 (software decode, runs everywhere)
  testVideo = path.join(ROOT, 'test.mp4');
  await new Promise((resolve, reject) => {
    const { execFile } = require('node:child_process');
    execFile('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=s=64x48:d=12:r=10',
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
      '-t', '12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      testVideo,
    ], { timeout: 90000 }, (err) => err ? reject(err) : resolve());
  });

  // Short video (2s) — shorter than the default preview window (t=1 + d=3 = 4s).
  // Regression (2026-08-15): mix/preview used to seek past the video end → ffmpeg
  // finds no frame at ts >= duration → HTTP 500. Must clamp to the video end.
  shortVideo = path.join(ROOT, 'short.mp4');
  await new Promise((resolve, reject) => {
    const { execFile } = require('node:child_process');
    execFile('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=s=64x48:d=2:r=10',
      '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      shortVideo,
    ], { timeout: 90000 }, (err) => err ? reject(err) : resolve());
  });

  // Start the server (port 0 = ephemeral)
  await new Promise((resolve) => {
    server = http.createServer(thumbd.handle);
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(() => {
  if (server) server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

function get(p, headers = {}) {
  return new Promise((resolve) => {
    http.get(baseUrl + p, { headers }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', (e) => resolve({ status: 0, error: e.message, body: Buffer.alloc(0) }));
  });
}

function post(p, headers = {}) {
  return new Promise((resolve) => {
    const req = http.request(baseUrl + p, { method: 'POST', headers }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message, body: Buffer.alloc(0) }));
    req.end();
  });
}

// ---------- Unit: pickDecoder ----------
test('withJobLock: serializes concurrent jobs (max 2 parallel)', async () => {
  const { withJobLock } = thumbd;
  let running = 0, maxRunning = 0, done = 0;
  const job = () => withJobLock(async () => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    await new Promise(r => setTimeout(r, 30));
    running--;
    done++;
  });
  await Promise.all([job(), job(), job(), job(), job()]);
  assert.equal(done, 5);
  assert.ok(maxRunning <= 2, `expected max 2 parallel, got ${maxRunning}`);
});

test('pickDecoder: HEVC gets the drm hwaccel (stateless V4L2, Pi 5)', () => {
  // hevc_v4l2m2m (stateful mem2mem) fails on the rpi-hevc-dec; the stateless
  // path uses `-hwaccel drm` (requires the rpt ffmpeg build in the container).
  assert.equal(thumbd.pickDecoder('hevc', true), 'drm');
  assert.equal(thumbd.pickDecoder('h265', true), 'drm');
});

test('pickDecoder: H.264/others software only (Pi 5 has no HW H.264)', () => {
  assert.equal(thumbd.pickDecoder('h264', true), null);
  assert.equal(thumbd.pickDecoder('vp9', true), null);
});

test('pickDecoder: without v4l2 devices always null', () => {
  assert.equal(thumbd.pickDecoder('hevc', false), null);
  assert.equal(thumbd.pickDecoder('hevc', null), null);
});

// ---------- Unit: resolveAllowed ----------
test('resolveAllowed: path inside root is allowed', async () => {
  const r = await thumbd.resolveAllowed(testImage);
  assert.equal(r, testImage);
});

test('resolveAllowed: ..-traversal is rejected', async () => {
  const r = await thumbd.resolveAllowed(path.join(ROOT, '..', '..', 'etc', 'passwd'));
  assert.equal(r, null);
});

test('resolveAllowed: path outside the root is rejected', async () => {
  const r = await thumbd.resolveAllowed('/etc/passwd');
  assert.equal(r, null);
});

test('resolveAllowed: non-existent file -> null', async () => {
  const r = await thumbd.resolveAllowed(path.join(ROOT, 'doesnotexist.png'));
  assert.equal(r, null);
});

// ---------- Integration: health + auth ----------
test('GET /health -> 200 without token', async () => {
  const r = await get('/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.toString(), 'ok');
});

test('GET /thumb without token -> 401', async () => {
  const r = await get('/thumb?path=test.png&w=100&h=100');
  assert.equal(r.status, 401);
});

test('GET /thumb with wrong token -> 401', async () => {
  const r = await get('/thumb?path=test.png&w=100&h=100', { 'X-Thumb-Token': 'wrong' });
  assert.equal(r.status, 401);
});

// ---------- Integration: path security ----------
test('GET /thumb with path outside root -> 403', async () => {
  const r = await get(`/thumb?path=${encodeURIComponent('/etc/passwd')}&w=100&h=100`, { 'X-Thumb-Token': 'testtoken123' });
  assert.equal(r.status, 403);
});

test('GET /thumb with ..-traversal -> 403', async () => {
  const r = await get(`/thumb?path=${encodeURIComponent('../../etc/passwd')}&w=100&h=100`, { 'X-Thumb-Token': 'testtoken123' });
  assert.equal(r.status, 403);
});

test('GET /thumb without path -> 400', async () => {
  const r = await get('/thumb?w=100&h=100', { 'X-Thumb-Token': 'testtoken123' });
  assert.equal(r.status, 400);
});

// ---------- Integration: image thumbnail ----------
test('GET /thumb image -> 200 WebP, generated', async () => {
  const r = await get(`/thumb?path=${encodeURIComponent('test.png')}&w=100&h=100`, { 'X-Thumb-Token': 'testtoken123' });
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'image/webp');
  assert.match(r.headers['x-thumb-source'], /generated|cache/);
  // WebP magic: RIFF....WEBP
  assert.equal(r.body.subarray(0, 4).toString(), 'RIFF');
  assert.equal(r.body.subarray(8, 12).toString(), 'WEBP');
});

test('GET /thumb image second call -> cache', async () => {
  const p = `/thumb?path=${encodeURIComponent('test.png')}&w=100&h=100`;
  await get(p, { 'X-Thumb-Token': 'testtoken123' });
  const r = await get(p, { 'X-Thumb-Token': 'testtoken123' });
  assert.equal(r.status, 200);
  assert.equal(r.headers['x-thumb-source'], 'cache');
});

test('GET /thumb image keeps source aspect ratio (contain, no crop)', async () => {
  // test.png is 64x48 (4:3). Requesting 32x32 must NOT crop to 32x32,
  // it must scale proportionally to 32x24 (like the legacy thumbnailer).
  const r = await get(`/thumb?path=${encodeURIComponent('test.png')}&w=32&h=32`, { 'X-Thumb-Token': 'testtoken123' });
  assert.equal(r.status, 200);
  const meta = await sharp(r.body).metadata();
  assert.equal(meta.width, 32);
  assert.equal(meta.height, 24);
});

test('GET /thumb image does not enlarge small sources', async () => {
  // 64x48 source, requesting 200x200: withoutEnlargement keeps it at 64x48.
  const r = await get(`/thumb?path=${encodeURIComponent('test.png')}&w=200&h=200`, { 'X-Thumb-Token': 'testtoken123' });
  assert.equal(r.status, 200);
  const meta = await sharp(r.body).metadata();
  assert.equal(meta.width, 64);
  assert.equal(meta.height, 48);
});

test('GET /thumb image fit=cover fills the box (crop)', async () => {
  // 64x48 (4:3) source, fit=cover with 32x32 box → exactly 32x32 (cropped).
  const r = await get(`/thumb?path=${encodeURIComponent('test.png')}&w=32&h=32&fit=cover`, { 'X-Thumb-Token': 'testtoken123' });
  assert.equal(r.status, 200);
  const meta = await sharp(r.body).metadata();
  assert.equal(meta.width, 32);
  assert.equal(meta.height, 32);
});

test('GET /thumb BMP -> 200 WebP via ffmpeg fallback', async () => {
  // sharp/libvips in this image is built WITHOUT bmp support ("Input file
  // contains unsupported image format") — the BMP fallback decodes via ffmpeg
  // (which has a BMP decoder). Regression for the 2026-08-16 xplorer error
  // "thumb failed ... r_20260816_23.19.03_70%.bmp".
  const bmpPath = path.join(ROOT, 'test.bmp');
  await new Promise((resolve, reject) => {
    const { execFile } = require('node:child_process');
    execFile('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=red:s=64x48',
      '-frames:v', '1',
      bmpPath,
    ], { timeout: 30000 }, (err) => err ? reject(err) : resolve());
  });
  const r = await get(`/thumb?path=${encodeURIComponent('test.bmp')}&w=100&h=100`, { 'X-Thumb-Token': 'testtoken123' });
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'image/webp');
  assert.equal(r.body.subarray(0, 4).toString(), 'RIFF');
  assert.equal(r.body.subarray(8, 12).toString(), 'WEBP');
  const meta = await sharp(r.body).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(meta.width, 100);  // 64x48 upscaled? No — withoutEnlargement applies in sharp only;
  // the ffmpeg path scales to fit the box (contain): 100x100 box, 64x48 source → 100x75.
  assert.equal(meta.height, 75);
});

test('GET /thumb contain and cover use separate cache entries', async () => {
  const p = (fit) => `/thumb?path=${encodeURIComponent('test.png')}&w=40&h=40${fit ? '&fit=' + fit : ''}`;
  const r1 = await get(p(''), { 'X-Thumb-Token': 'testtoken123' });      // contain (default)
  const r2 = await get(p('cover'), { 'X-Thumb-Token': 'testtoken123' }); // cover
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(r1.headers['x-thumb-source'], 'generated');
  assert.equal(r2.headers['x-thumb-source'], 'generated');
  const m1 = await sharp(r1.body).metadata();
  const m2 = await sharp(r2.body).metadata();
  assert.notDeepEqual([m1.width, m1.height], [m2.width, m2.height]);
  // cache hits must stay separate too
  const r3 = await get(p('cover'), { 'X-Thumb-Token': 'testtoken123' });
  assert.equal(r3.headers['x-thumb-source'], 'cache');
});

test('GET /thumb nocache=1 skips cache read but still writes', async () => {
  const p = `/thumb?path=${encodeURIComponent('test.png')}&w=50&h=50`;
  // prime the cache
  const r1 = await get(p, { 'X-Thumb-Token': 'testtoken123' });
  assert.equal(r1.headers['x-thumb-source'], 'generated');
  // normal second call -> cache hit
  const r2 = await get(p, { 'X-Thumb-Token': 'testtoken123' });
  assert.equal(r2.headers['x-thumb-source'], 'cache');
  // nocache -> regenerated, even though cache entry exists
  const r3 = await get(p + '&nocache=1', { 'X-Thumb-Token': 'testtoken123' });
  assert.equal(r3.status, 200);
  assert.equal(r3.headers['x-thumb-source'], 'generated');
  // cache entry was refreshed, so the next normal call is a cache hit again
  const r4 = await get(p, { 'X-Thumb-Token': 'testtoken123' });
  assert.equal(r4.headers['x-thumb-source'], 'cache');
});

// ---------- Integration: video thumbnail ----------
test('GET /duration video -> JSON with duration', async () => {
  const r = await get(`/duration?path=${encodeURIComponent('test.mp4')}`, { 'X-Thumb-Token': 'testtoken123' });
  assert.equal(r.status, 200, r.body.toString().slice(0, 200));
  assert.match(r.headers['content-type'], /application\/json/);
  const body = JSON.parse(r.body.toString());
  assert.ok(Math.abs(body.duration - 12) < 1, `expected ~12s, got ${body.duration}`);
  // second call served from cache
  const r2 = await get(`/duration?path=${encodeURIComponent('test.mp4')}`, { 'X-Thumb-Token': 'testtoken123' });
  assert.equal(r2.status, 200);
  assert.equal(JSON.parse(r2.body.toString()).duration, body.duration);
});

test('GET /duration short video -> 200', async () => {
  const r = await get(`/duration?path=${encodeURIComponent('short.mp4')}`, { 'X-Thumb-Token': 'testtoken123' });
  assert.equal(r.status, 200, r.body.toString().slice(0, 200));
  const body = JSON.parse(r.body.toString());
  assert.ok(Math.abs(body.duration - 2) < 0.5, `expected ~2s, got ${body.duration}`);
});

test('GET /duration missing path -> 400, outside root -> 403', async () => {
  const r1 = await get('/duration', { 'X-Thumb-Token': 'testtoken123' });
  assert.equal(r1.status, 400);
  const r2 = await get(`/duration?path=${encodeURIComponent('/etc/passwd')}`, { 'X-Thumb-Token': 'testtoken123' });
  assert.equal(r2.status, 403);
});

test('GET /thumb video (H.264) -> 200 WebP', async () => {
  const r = await get(`/thumb?path=${encodeURIComponent('test.mp4')}&w=100&h=100&t=0`, { 'X-Thumb-Token': 'testtoken123' });
  assert.equal(r.status, 200, r.body.toString().slice(0, 200));
  assert.equal(r.headers['content-type'], 'image/webp');
  assert.equal(r.body.subarray(0, 4).toString(), 'RIFF');
});

test('GET /thumb video mode=preview -> animated WebP', async () => {
  const r = await get(`/thumb?path=${encodeURIComponent('test.mp4')}&w=100&h=100&mode=preview&t=0&d=2&fps=5`, { 'X-Thumb-Token': 'testtoken123' });
  assert.equal(r.status, 200, r.body.toString().slice(0, 200));
  assert.equal(r.headers['content-type'], 'image/webp');
  assert.equal(r.body.subarray(0, 4).toString(), 'RIFF');
  // animated webp: VP8X chunk present (animation flag) or multiple frames
  const meta = await sharp(r.body).metadata();
  assert.ok(meta.pages > 1, `expected animated webp (pages>1), got pages=${meta.pages}`);
});

test('GET /thumb video mode=slideshow count=3 -> animated WebP', async () => {
  const r = await get(`/thumb?path=${encodeURIComponent('test.mp4')}&w=100&h=100&mode=slideshow&count=3`, { 'X-Thumb-Token': 'testtoken123' });
  assert.equal(r.status, 200, r.body.toString().slice(0, 200));
  assert.equal(r.headers['content-type'], 'image/webp');
  const meta = await sharp(r.body).metadata();
  assert.ok(meta.pages > 1, `expected animated webp, got pages=${meta.pages}`);
});

test('GET /thumb video mode=slideshow interval=4 -> animated WebP', async () => {
  const r = await get(`/thumb?path=${encodeURIComponent('test.mp4')}&w=100&h=100&mode=slideshow&interval=4`, { 'X-Thumb-Token': 'testtoken123' });
  assert.equal(r.status, 200, r.body.toString().slice(0, 200));
  assert.equal(r.headers['content-type'], 'image/webp');
  const meta = await sharp(r.body).metadata();
  assert.ok(meta.pages > 1, `expected animated webp, got pages=${meta.pages}`);
});

test('GET /thumb video mode=mix -> animated WebP (preview + slideshow)', async () => {
  // 12s video, defaults t=1 d=3 fps=10 count=3:
  // preview = 30 frames (1s..4s at 10fps), slideshow = 3 frames over the rest (4s..12s)
  const r = await get(`/thumb?path=${encodeURIComponent('test.mp4')}&w=100&h=100&mode=mix`, { 'X-Thumb-Token': 'testtoken123' });
  assert.equal(r.status, 200, r.body.toString().slice(0, 200));
  assert.equal(r.headers['content-type'], 'image/webp');
  const meta = await sharp(r.body).metadata();
  assert.ok(meta.pages > 1, `expected animated webp, got pages=${meta.pages}`);
  // 30 preview + 3 slideshow = 33 frames (allow ffmpeg rounding ±2)
  assert.ok(meta.pages >= 31 && meta.pages <= 35, `expected ~33 frames, got pages=${meta.pages}`);
});

test('GET /thumb video mode=mix custom params -> animated WebP', async () => {
  // custom: preview t=0 d=2 fps=5 (10 frames), slideshow count=2 over the rest
  const r = await get(`/thumb?path=${encodeURIComponent('test.mp4')}&w=100&h=100&mode=mix&t=0&d=2&fps=5&count=2`, { 'X-Thumb-Token': 'testtoken123' });
  assert.equal(r.status, 200, r.body.toString().slice(0, 200));
  const meta = await sharp(r.body).metadata();
  assert.ok(meta.pages >= 11 && meta.pages <= 13, `expected ~12 frames, got pages=${meta.pages}`);
});

test('GET /thumb SHORT video (2s) mode=mix -> 200 (clamped preview window)', async () => {
  // Regression 2026-08-15: videos shorter than the default preview window (t=1+d=3=4s)
  // used to fail with 500 — ffmpeg seeks past the last frame (ts >= duration).
  // The preview window must be clamped to the video end; slideshow falls back to
  // a single frame at the middle when the preview already covers the whole video.
  const r = await get(`/thumb?path=${encodeURIComponent('short.mp4')}&w=100&h=100&mode=mix`, { 'X-Thumb-Token': 'testtoken123' });
  assert.equal(r.status, 200, r.body.toString().slice(0, 200));
  assert.equal(r.headers['content-type'], 'image/webp');
  const meta = await sharp(r.body).metadata();
  assert.ok(meta.pages >= 2, `expected animated webp, got pages=${meta.pages}`);
});

test('GET /thumb SHORT video (2s) mode=preview -> 200 (clamped preview window)', async () => {
  const r = await get(`/thumb?path=${encodeURIComponent('short.mp4')}&w=100&h=100&mode=preview&t=1&d=3&fps=10`, { 'X-Thumb-Token': 'testtoken123' });
  assert.equal(r.status, 200, r.body.toString().slice(0, 200));
  assert.equal(r.headers['content-type'], 'image/webp');
  const meta = await sharp(r.body).metadata();
  assert.ok(meta.pages >= 2, `expected animated webp, got pages=${meta.pages}`);
});

test('GET /thumb SHORT video (2s) mode=slideshow count=3 -> 200', async () => {
  const r = await get(`/thumb?path=${encodeURIComponent('short.mp4')}&w=100&h=100&mode=slideshow&count=3`, { 'X-Thumb-Token': 'testtoken123' });
  assert.equal(r.status, 200, r.body.toString().slice(0, 200));
  assert.equal(r.headers['content-type'], 'image/webp');
  const meta = await sharp(r.body).metadata();
  assert.ok(meta.pages >= 2, `expected animated webp, got pages=${meta.pages}`);
});

test('mix animation frame delays are correct (webp ANMF chunks)', async () => {
  // Regression for ffmpeg-8 webp muxer bug (mixed/short delays corrupted).
  // mix t=0 d=1 fps=4 count=1: preview = 4 frames @250ms, slideshow = 1 frame @1000ms
  const r = await get(`/thumb?path=${encodeURIComponent('test.mp4')}&w=100&h=100&mode=mix&t=0&d=1&fps=4&count=1`, { 'X-Thumb-Token': 'testtoken123' });
  assert.equal(r.status, 200, r.body.toString().slice(0, 200));
  const delays = parseWebpDelays(r.body);
  assert.equal(delays.length, 5, `expected 5 frames, got ${delays.length}: ${delays}`);
  assert.deepEqual(delays, [250, 250, 250, 250, 1000], `unexpected delays: ${delays}`);
});

// Parse the per-frame durations (ms) out of an animated WebP (ANMF chunks)
function parseWebpDelays(buf) {
  if (buf.toString('latin1', 0, 4) !== 'RIFF') return [];
  const out = [];
  let i = 12;
  while (i + 8 <= buf.length) {
    const tag = buf.toString('latin1', i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    if (tag === 'ANMF') {
      // payload: x(3) y(3) w(3) h(3) duration(3 LE) flags(1)
      out.push(buf.readUIntLE(i + 8 + 12, 3));
    }
    i += 8 + size + (size % 2);
  }
  return out;
}

test('GET /thumb video modes have separate cache entries', async () => {
  const p = (extra) => `/thumb?path=${encodeURIComponent('test.mp4')}&w=60&h=60${extra}`;
  const r1 = await get(p(''), { 'X-Thumb-Token': 'testtoken123' });                                  // still
  const r2 = await get(p('&mode=preview&t=0&d=1&fps=2'), { 'X-Thumb-Token': 'testtoken123' });       // preview
  const r3 = await get(p('&mode=slideshow&count=2'), { 'X-Thumb-Token': 'testtoken123' });          // slideshow
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(r3.status, 200);
  // all three should be generated (different cache keys)
  assert.equal(r1.headers['x-thumb-source'], 'generated');
  assert.equal(r2.headers['x-thumb-source'], 'generated');
  assert.equal(r3.headers['x-thumb-source'], 'generated');
});

// ---------- Integration: unsupported ----------
test('GET /thumb with text file -> 415', async () => {
  fs.writeFileSync(path.join(ROOT, 'test.txt'), 'hello');
  const r = await get(`/thumb?path=${encodeURIComponent('test.txt')}&w=100&h=100`, { 'X-Thumb-Token': 'testtoken123' });
  assert.equal(r.status, 415);
});

// ---------- Integration: POST rejected ----------
test('POST /thumb -> 405 (GET only)', async () => {
  const r = await post('/thumb?path=test.png&w=100&h=100', { 'X-Thumb-Token': 'testtoken123' });
  assert.equal(r.status, 405);
});
