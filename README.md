# thumbd

Fast thumbnails for images and videos as a persistent daemon — a drop-in thumbnail
generator service for your personal media server (e.g. on a Raspberry Pi). Runs as a
Docker container on ARM64 and amd64.

- **Images:** `sharp` (libvips) — 5–20× faster than ImageMagick, ~1/10 the RAM
- **Videos:** `ffmpeg` with hardware decode where available (Pi 5: HEVC via `hevc_v4l2m2m`; H.264 stays software — the Pi 5 has no HW H.264 decoder)
- **Architecture:** the daemon stays warm in memory — no process spawn per request
- **Security:** path whitelist (only configured roots, symlink-safe), optional token, size limits
- **Cache:** disk cache with ETag + `Cache-Control: max-age=604800`

## Quickstart

Prebuilt multi-arch images are published to the GitHub Container Registry:
`ghcr.io/mayrd/thumbd:latest` (linux/amd64 + linux/arm64).

```bash
# Example: docker-compose.yml using the GitHub image — mount your media folder as /data
curl -s -o docker-compose.yml https://raw.githubusercontent.com/mayrd/thumbd/main/docker-compose.yml
docker compose up -d

# Test (adjust the path to one of your media files):
curl -s -o t.webp "http://localhost:8090/thumb?path=/home/USER/Bilder/test.jpg&w=320&h=320"
```

Example `docker-compose.yml` (identical to the one in this repo):

```yaml
services:
  thumbd:
    image: ghcr.io/mayrd/thumbd:latest
    container_name: thumbd
    restart: unless-stopped
    group_add:
      - "44"                       # host group 'video' — v4l2 HW-decoder access on the Pi
    ports:
      - "8090:8090"
    environment:
      THUMBD_ROOTS: "/data"        # comma-separated roots (whitelist)
      THUMBD_TOKEN: "${THUMBD_TOKEN:-}"   # empty = no auth (internal only!)
    volumes:
      - /home/USER:/home/USER      # >>> your media folders <<<
      - thumbd-cache:/cache
    devices:                       # Pi 5 v4l2 devices (video19-35 + media0-2)
      - /dev/video19:/dev/video19
      - /dev/video20:/dev/video20
      - /dev/video21:/dev/video21
      - /dev/video22:/dev/video22
      - /dev/video23:/dev/video23
      - /dev/video24:/dev/video24
      - /dev/video25:/dev/video25
      - /dev/video26:/dev/video26
      - /dev/video27:/dev/video27
      - /dev/video28:/dev/video28
      - /dev/video29:/dev/video29
      - /dev/video30:/dev/video30
      - /dev/video31:/dev/video31
      - /dev/video32:/dev/video32
      - /dev/video33:/dev/video33
      - /dev/video34:/dev/video34
      - /dev/video35:/dev/video35
      - /dev/media0:/dev/media0
      - /dev/media1:/dev/media1
      - /dev/media2:/dev/media2

volumes:
  thumbd-cache:
```

## API

```
GET /thumb?path=<absolute path>&w=320&h=320&t=1
GET /health
```

| Parameter | Meaning |
|---|---|
| `path` | A file inside one of the configured roots (otherwise 403). Absolute, or relative to the first root. |
| `w`, `h` | Target size (max 1024, `cover` crop, no upscaling) |
| `t` | Video timestamp in seconds (default 1; clamped for long videos) |

- Auth: header `X-Thumb-Token` (only when `THUMBD_TOKEN` is set)
- Response: `image/webp`, `Cache-Control: public, max-age=604800`, `ETag`, `X-Thumb-Source: generated|cache`

## Configuration (env)

| Variable | Default | Meaning |
|---|---|---|
| `THUMBD_PORT` | `8090` | HTTP port |
| `THUMBD_ROOTS` | `/data` | Comma-separated root paths (whitelist, symlink-safe) |
| `THUMBD_CACHE` | `/cache` | Disk cache directory |
| `THUMBD_TOKEN` | *(empty)* | Request token; empty = no auth (only use behind nginx) |
| `THUMBD_V4L2` | `h264_v4l2m2m` | HW decoder name for the availability check |
| `THUMBD_MAX_SRC_MB` | `4096` | Max source file size (TV episodes are often 1–2 GB) |
| `THUMBD_VIDEO_MAX_SEC` | `600` | Videos >10 min: still from the first half |

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
- **Map the v4l2 devices in compose** (Pi 5: `/dev/video19`–`35` + `/dev/media*`),
  and add `group_add: ["44"]` = host group `video`.
- **The cache volume initially belongs to root** — the entrypoint chowns `/cache`
  to the container user (root → node, uid 1000) via `su-exec`.
- **`su-exec` only sets uid:gid, no supplementary groups** — that is why the
  entrypoint opens the v4l2 devices with `chmod 666` instead of relying on groups.
- **uid 1000 in the container = your host user** — file permissions on mounted
  media work without chmod actions.
- Alpine's `node:20-alpine` already ships a user with uid 1000 (`node`) — do not
  try `adduser` with uid 1000.
