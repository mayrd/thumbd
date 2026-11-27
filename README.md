# thumbd

Fast thumbnails for images and videos as a persistent daemon — a thumbnail generator
service for your personal media server (e.g. on a Raspberry Pi). Runs as a Docker
container on ARM64 and amd64.

- **Images:** `sharp` (libvips) — 5–20× faster than ImageMagick, ~1/10 the RAM
- **Videos:** `ffmpeg` — hardware decode where available, software otherwise
- **Architecture:** the daemon stays warm in memory — no process spawn per request
- **Security:** path whitelist (always `/data`, symlink-safe), optional token, size limits
- **Cache:** disk cache with ETag + `Cache-Control: max-age=604800`

## Quickstart

Prebuilt multi-arch images are published to the GitHub Container Registry:
`ghcr.io/mayrd/thumbd:latest` (linux/amd64 + linux/arm64).

```yaml
# docker-compose.yml — the minimal example (identical to the one in this repo)
services:
  thumbd:
    image: ghcr.io/mayrd/thumbd:latest
    container_name: thumbd
    restart: unless-stopped
    ports:
      - "8090:8090"
    environment:
      THUMBD_TOKEN: "${THUMBD_TOKEN:-}"  # empty = no auth (internal only!)
      PUID: "1000"                 # run as your host user's uid:gid (default 1000:1000)
      PGID: "1000"
    volumes:
      - /home/USER:/data:ro              # >>> your media folder, always mounted as /data <<<
      - thumbd-cache:/cache

volumes:
  thumbd-cache:
```

```bash
docker compose up -d

# Test (adjust the path to one of your media files):
curl -s -o t.webp "http://localhost:8090/thumb?path=/data/test.jpg&w=320&h=320"
```

## How it works

### The /data root

The media root is **always `/data`** — there is no `THUMBD_ROOTS` configuration.
Whatever you mount at `/data` inside the container is what the daemon serves:

- **The volume mount** (`/home/USER:/data`) makes your folder *visible* inside the container.
- The daemon serves files **only** under `/data` (symlink-safe whitelist) — everything
  else returns `403`.

Mount a single folder as `/data`, or merge several by mounting them into subfolders:

```yaml
    volumes:
      - /home/USER/media:/data            # serves /data/...
      - /mnt/pcloud:/data/pcloud         # also serves /data/pcloud/...
```

### User and group

The container starts as **root only briefly**: the entrypoint chowns the cache volume
(named volumes initially belong to root) and opens up the v4l2 devices, then drops
privileges via `su-exec` to `PUID:PGID` (default `1000:1000`).

Set `PUID`/`PGID` to your **host user's ids** — uid 1000 is the typical first
user on a Raspberry Pi. Because the container user then has the same uid as your host user,
file permissions on the mounted media folders work without chmod gymnastics.

## API

```
GET /thumb?path=<absolute path>&w=320&h=320&t=1
GET /duration?path=<absolute path>     -> {"duration": 12.34}
GET /dimensions?path=<absolute path>   -> {"width": 1080, "height": 1920, "rotation": 90}
GET /health
```

### Metadata endpoints

Both take the same `path` rules and `X-Thumb-Token` auth as `/thumb`, answer JSON and are
cached forever (duration/dimensions of a file never change):

- **`/duration`** — video length in seconds (`0` when not probeable). Lets the app container
  stay slim: thumbd owns ffprobe.
- **`/dimensions`** — **display** dimensions of a video plus its rotation. ffprobe reports the
  raw sensor size, while ffmpeg auto-rotates on playback; phone recordings are stored landscape
  with a 90°/270° display matrix, so the axes are swapped here. That is what a tile layout needs
  to give a portrait video a portrait tile. `0/0` when the file is not probeable (and then
  nothing is cached, so a later retry can still succeed).

| Parameter | Meaning |
|---|---|
| `path` | A file inside `/data` (otherwise 403). Absolute (`/data/...`), or relative to `/data`. |
| `w`, `h` | Target size (max 1024, no upscaling) |
| `t` | Video timestamp in seconds for `still` (default 1) and `preview` start (default 1) |
| `fit` | `contain` (default — scale to fit the box, keep the source aspect ratio, no crop) or `cover` (fill the box exactly, cropping overflow). Passed through to sharp/ffmpeg. |
| `mode` | Video mode: `still` (default, single frame at `t`), `preview` (animated WebP from `t` for `d` seconds at `fps`, like the legacy thumbnailer's first-seconds preview), `slideshow` (animated WebP of evenly spaced frames), `mix` (animated preview of the first `d` seconds followed by a slideshow of the remaining video) |
| `d` | `preview` duration in seconds (default 3) |
| `fps` | `preview` animation rate (default 10, max 30) |
| `count` | `slideshow`: number of frames, evenly spaced over the whole video (default 3, max 60) |
| `interval` | `slideshow`: alternative to `count` — one frame every N seconds (max 60 frames) |
| `nocache` | `1` or `true` — skip the cache *read* (always regenerate), but still write the result to the cache. Useful when debugging changes. |

- Auth: header `X-Thumb-Token` (only when `THUMBD_TOKEN` is set)
- Response: `image/webp`, `Cache-Control: public, max-age=604800`, `ETag`, `X-Thumb-Source: generated|cache`

## Configuration (env)

| Variable | Default | Meaning |
|---|---|---|
| `THUMBD_PORT` | `8090` | HTTP port |
| `THUMBD_CACHE` | `/cache` | Disk cache directory |
| `THUMBD_TOKEN` | *(empty)* | Request token; empty = no auth (only use behind nginx) |
| `PUID` / `PGID` | `1000` / `1000` | User the daemon drops to (set to your host user's ids) |
| `THUMBD_MAX_SRC_MB` | `4096` | Max source file size (TV episodes are often 1–2 GB) |
| `THUMBD_VIDEO_MAX_SEC` | `600` | Videos >10 min: still from the first half |
| `THUMBD_MAX_JOBS` | CPU count (max `8`) | Max concurrent heavy video jobs (`preview`/`slideshow`/`mix`); `still` & images bypass this queue |
| `THUMBD_MAX_IMG_JOBS` | CPU count (max `8`) | Max concurrent image resize jobs (`sharp`) |
| `THUMBD_SHARP_CONCURRENCY` | *(auto)* | Threads per `sharp` job (default auto: uses all cores in Docker with `libjemalloc2`) |
| `UV_THREADPOOL_SIZE` | `16` *(Docker)* | Node libuv worker pool size for `sharp` + async filesystem I/O |
| `THUMBD_LOG_LEVEL` | `info` | Log verbosity: `off` (`0`), `error` (`1`), `warn` (`2`), `info` (`3`), `debug`/`all` (`4`) |
| `THUMBD_STATS_INTERVAL_SEC` | `30` | Interval in seconds for periodic `stats` summary lines (`0` disables; silent when idle) |

### Logging & concurrency tuning

At `THUMBD_LOG_LEVEL=info` (default), `thumbd` logs every generated thumbnail (`thumb status=200 src=generated ...`), every metadata probe miss (`probe ep=/dimensions ...`), queue waits (`thumb queued ...`), client aborts (`client_aborted ...`), and a periodic `stats` line whenever traffic occurred:

```
2026-11-26T18:30:30.000Z INFO stats window=30s reqs=48 thumb_hit=20 thumb_gen=28(img=18,still=6,anim=4) probe_hit=0 probe_miss=0 err=0 aborted=0 peak_inflight=9 peak_img=5 peak_still=3 peak_jobs=2/2 peak_queue=4 peak_probes=0 avg_gen_ms=420 max_gen_ms=3150 max_wait_ms=1800 load1m=1.42 rss_mb=95 heap_mb=24
```

- Set `THUMBD_LOG_LEVEL=debug` to also log every `/thumb`, `/dimensions`, and `/duration` disk-cache hit and `/health` check.
- The Docker image installs `libjemalloc2` (preloaded via `LD_PRELOAD` in `entrypoint.sh`) and sets `UV_THREADPOOL_SIZE=16`, allowing `sharp` (libvips) to use multi-threaded image processing across all CPU cores without glibc fragmentation.
- Use `peak_jobs`, `peak_queue`, `max_wait_ms`, `peak_still`, `peak_img`, and `load1m` to tune `THUMBD_MAX_JOBS` (default: CPU count, max `8`), `THUMBD_MAX_IMG_JOBS`, and client concurrency (`xplorer`'s `thumb-progressive.js` `MAX_CONCURRENT`):
  - If `peak_queue > 0` and `max_wait_ms` is high while `load1m` is low (< CPU count), increasing `THUMBD_MAX_JOBS` can improve throughput.
  - If `aborted > 0` or `load1m` exceeds CPU count and `max_gen_ms` spikes, lower `THUMBD_MAX_JOBS` or client concurrency.

## Hardware video decode (optional, Pi 5 / HEVC)

The daemon decodes videos in **software by default** — that works everywhere. If you decode
**HEVC** content on a Raspberry Pi 5, you can use the hardware decoder:

```yaml
    group_add:
      - "44"                        # host group 'video'
    devices:
      - /dev/video19:/dev/video19  # rpi-hevc-dec (HEVC decoder)
      - /dev/media0:/dev/media0    # media controller for the decoder
```

Notes:
- The Pi 5 has **no HW H.264 decoder** — H.264 is always software, the extra devices do not help.
- The decoder is picked automatically per video (HEVC → `hevc_v4l2m2m`, otherwise software),
  with an automatic software retry if the hardware path fails.
- If a device in the `devices` list does not exist on your host, the container will not start —
  only add lines for devices you actually have (`ls /dev/video*`).

## Development

```bash
npm install
npm test          # node:test, 30 tests (unit + integration)
npm start         # run the daemon locally
```

The tests cover: path whitelist / `..` traversal, auth (401/403), WebP output,
cache behavior, video thumbnails (generates a test video with ffmpeg), GET-only.

## nginx integration

```nginx
location /thumb/ {
    proxy_pass http://thumbd:8090/thumb/;
    proxy_set_header X-Thumb-Token $thumbd_token;   # from env/map
}
```

Never expose the service publicly without `THUMBD_TOKEN` — run it behind nginx
`auth_request` instead (this also closes the LFI hole of an unprotected
PHP-style thumbnailer).

## Pitfalls

- **Pi 5 has no HW H.264 decoder** — only HEVC (`rpi-hevc-dec`, `/dev/video19`).
  thumbd picks the decoder via ffprobe: HEVC → `hevc_v4l2m2m`, otherwise software,
  with an automatic software retry if the HW path fails.
- **The cache volume initially belongs to root** — the entrypoint chowns `/cache`
  to the configured user (root → `PUID:PGID`) via `su-exec`.
- **`su-exec` only sets uid:gid, no supplementary groups** — that is why the entrypoint
  opens the v4l2 devices with `chmod 666` instead of relying on groups.
- **A missing device in `devices:` prevents the container from starting** — only add
  v4l2 devices you actually have, or leave the whole block out.
- Alpine's `node:20-alpine` already ships a user with uid 1000 (`node`) — the entrypoint
  uses numeric `su-exec`, so `PUID` can be any value without extra user setup.
