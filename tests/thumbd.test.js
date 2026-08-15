// thumbd test suite — node:test (no framework needed)
// Run: node --test tests/thumbd.test.js
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

// Set env BEFORE require (constants are read at module load)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'thumbd-test-'));
const ROOT = path.join(TMP, 'media');
const CACHE = path.join(TMP, 'cache');
fs.mkdirSync(ROOT, { recursive: true });

process.env.THUMBD_ROOTS = ROOT;
process.env.THUMBD_CACHE = CACHE;
process.env.THUMBD_TOKEN = 'testtoken123';
process.env.THUMBD_PORT = '0'; // ephemeral

const thumbd = require('../server.js');

let server;
let baseUrl;
let testImage;   // test image path inside the root
let testVideo;   // test video path inside the root

before(async () => {
  // Generate a test image (sharp) — small red PNG
  const sharp = require('sharp');
  testImage = path.join(ROOT, 'test.png');
  await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 30, b: 30 } } })
    .png().toFile(testImage);

  // Generate a test video — 1s red frame, H.264 (software decode, runs everywhere)
  testVideo = path.join(ROOT, 'test.mp4');
  await new Promise((resolve, reject) => {
    const { execFile } = require('node:child_process');
    execFile('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=red:s=64x48:d=1',
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
      '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      testVideo,
    ], { timeout: 60000 }, (err) => err ? reject(err) : resolve());
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
test('pickDecoder: HEVC gets the HW decoder', () => {
  assert.equal(thumbd.pickDecoder('hevc', true), 'hevc_v4l2m2m');
  assert.equal(thumbd.pickDecoder('h265', true), 'hevc_v4l2m2m');
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

// ---------- Integration: video thumbnail ----------
test('GET /thumb video (H.264) -> 200 WebP', async () => {
  const r = await get(`/thumb?path=${encodeURIComponent('test.mp4')}&w=100&h=100&t=0`, { 'X-Thumb-Token': 'testtoken123' });
  assert.equal(r.status, 200, r.body.toString().slice(0, 200));
  assert.equal(r.headers['content-type'], 'image/webp');
  assert.equal(r.body.subarray(0, 4).toString(), 'RIFF');
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
