# thumbd

Fast thumbnails for images and videos as a persistent daemon — a thumbnail generator
service for your personal media server (e.g. on a Raspberry Pi). Runs as a Docker
container on ARM64 and amd64.

- **Images:** `sharp` (libvips) — 5–20× faster than ImageMagick, ~1/10 the RAM
- **Videos:** `ffmpeg` — hardware decode where available, software otherwise
- **Architecture:** the daemon stays warm in memory — no process spawn per request
- **Security:** path whitelist (only configured roots, symlink-safe), optional token, size limits
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
      THUMBD_ROOTS: "/data"              # which paths inside the container may be served
      THUMBD_TOKEN: "${THUMBD_TOKEN:-}"  # empty = no auth (internal only!)
      THUMBD_UID: "1000"                 # run as your host user's uid:gid (default 1000:1000)
      THUMBD_GID: "1000"
    volumes:
      - /home/USER:/data:ro              # >>> your media folder <<<
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

### Volume mount vs. THUMBD_ROOTS

These are two different things that must match:

- **The volume mount** (`/home/USER:/data`) makes your folder *visible* inside the container.
- **`THUMBD_ROOTS`** is the *security whitelist*: which paths inside the container the daemon
  is allowed to serve. A file is served only if it is under one of these roots — everything
  else returns `403`.

Keep it simple: mount your folder as `/data` and set `THUMBD_ROOTS: "/data"`. For multiple
folders, add them to both — e.g. `THUMBD_ROOTS: "/data,/mnt/pcloud"` plus
`- /mnt/pcloud:/mnt/pcloud`.

### User and group

The container starts as **root only briefly**: the entrypoint chowns the cache volume
(named volumes initially belong to root) and opens up the v4l2 devices, then drops
privileges via `su-exec` to `THUMBD_UID:THUMBD_GID` (default `1000:1000`).

Set `THUMBD_UID`/`THUMBD_GID` to your **host user's ids** — uid 1000 is the typical first
user on a Raspberry Pi. Because the container user then has the same uid as your host user,
file permissions on the mounted media folders work without chmod gymnastics.

## API

```
GET /thumb?path=<absolute path>&w=320&h=320&t=1
GET /health
```

| Parameter | Meaning |
|---|---|
| `path` | A file inside one of the configured roots (otherwise 403). Absolute, or relative to the first root. |
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
| `THUMBD_ROOTS` | `/data` | Comma-separated root paths (whitelist, symlink-safe) |
| `THUMBD_CACHE` | `/cache` | Disk cache directory |
| `THUMBD_TOKEN` | *(empty)* | Request token; empty = no auth (only use behind nginx) |
| `THUMBD_UID` / `THUMBD_GID` | `1000` / `1000` | User the daemon drops to (set to your host user's ids) |
| `THUMBD_MAX_SRC_MB` | `4096` | Max source file size (TV episodes are often 1–2 GB) |
| `THUMBD_VIDEO_MAX_SEC` | `600` | Videos >10 min: still from the first half |

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
npm test          # node:test, 18 tests (unit + integration)
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
  to the configured user (root → `THUMBD_UID:THUMBD_GID`) via `su-exec`.
- **`su-exec` only sets uid:gid, no supplementary groups** — that is why the entrypoint
  opens the v4l2 devices with `chmod 666` instead of relying on groups.
- **A missing device in `devices:` prevents the container from starting** — only add
  v4l2 devices you actually have, or leave the whole block out.
- Alpine's `node:20-alpine` already ships a user with uid 1000 (`node`) — the entrypoint
  uses numeric `su-exec`, so `THUMBD_UID` can be any value without extra user setup.
