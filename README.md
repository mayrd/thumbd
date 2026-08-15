# thumbd

Schnelle Thumbnails für Bilder und Videos als persistenter Daemon — Ersatz für
PHP/ImageMagick-Thumbnailer in Web-File-Managern. Läuft als Docker-Container auf
ARM64 (Raspberry Pi 5) und amd64.

- **Bilder:** `sharp` (libvips) — 5–20× schneller als ImageMagick, ~1/10 RAM
- **Videos:** `ffmpeg` mit Hardware-Decode wo verfügbar (Pi 5: HEVC via `hevc_v4l2m2m`; H.264 = Software, der Pi 5 hat keinen HW-H.264-Decoder)
- **Architektur:** Daemon bleibt warm im Speicher — kein Prozess-Spawn pro Request
- **Sicherheit:** Pfad-Whitelist (nur konfigurierte Roots, symlink-sicher), optionales Token, Größenlimits
- **Cache:** Disk-Cache mit ETag + `Cache-Control: max-age=604800`

## Quickstart

```bash
# Docker-Image bauen + starten
docker compose up -d --build

# Medien-Ordner in der docker-compose.yml unter volumes eintragen (z.B. /home/daniel:/home/daniel)
# Test:
curl -s -o t.webp "http://localhost:8090/thumb?path=/home/daniel/Bilder/test.jpg&w=320&h=320"
```

Fertige Images: `ghcr.io/mayrd/thumbd:latest` (multi-arch amd64/arm64).

## API

```
GET /thumb?path=<absoluter Pfad>&w=320&h=320&t=1
GET /health
```

| Parameter | Bedeutung |
|---|---|
| `path` | Datei innerhalb eines konfigurierten Roots (sonst 403). Absolut oder relativ zum ersten Root. |
| `w`, `h` | Zielgröße (max 1024, `cover`-Crop, ohne Vergrößerung) |
| `t` | Video-Zeitpunkt in Sekunden (Default 1; bei langen Videos gedeckelt) |

- Auth: Header `X-Thumb-Token` (nur wenn `THUMBD_TOKEN` gesetzt)
- Antwort: `image/webp`, `Cache-Control: public, max-age=604800`, `ETag`, `X-Thumb-Source: generated|cache`

## Konfiguration (Env)

| Variable | Default | Bedeutung |
|---|---|---|
| `THUMBD_PORT` | `8090` | HTTP-Port |
| `THUMBD_ROOTS` | `/data` | Komma-getrennte Wurzel-Pfade (Whitelist, symlink-sicher) |
| `THUMBD_CACHE` | `/cache` | Disk-Cache-Verzeichnis |
| `THUMBD_TOKEN` | *(leer)* | Request-Token; leer = kein Auth (nur hinter nginx nutzen) |
| `THUMBD_V4L2` | `h264_v4l2m2m` | HW-Decoder-Name für die Verfügbarkeitsprüfung |
| `THUMBD_MAX_SRC_MB` | `4096` | Max. Quelldateigröße (Serien-Episoden sind oft 1–2 GB) |
| `THUMBD_VIDEO_MAX_SEC` | `600` | Videos >10 min: Still aus der ersten Hälfte |

## Entwicklung

```bash
npm install
npm test          # node:test, 18 Tests (Unit + Integration)
npm start         # Daemon lokal starten
```

Tests decken ab: Pfad-Whitelist/`..`-Traversal, Auth (401/403), WebP-Output,
Cache-Verhalten, Video-Thumbnails (erzeugt ein Testvideo mit ffmpeg), GET-only.

## nginx-Anbindung

```nginx
location /thumb/ {
    proxy_pass http://thumbd:8090/thumb/;
    proxy_set_header X-Thumb-Token $thumbd_token;   # aus env/map
}
```

Ohne `THUMBD_TOKEN` nie öffentlich exponieren — den Dienst hinter nginx
`auth_request` betreiben (schließt zugleich das LFI-Loch eines ungeschützten
PHP-Thumbnailers).

## Pitfalls

- **Pi 5 hat keinen HW-H.264-Decoder** — nur HEVC (`rpi-hevc-dec`, `/dev/video19`).
  thumbd wählt den Decoder per ffprobe: HEVC → `hevc_v4l2m2m`, sonst Software,
  mit automatischem Software-Retry bei HW-Fehlern.
- **v4l2-Geräte im Compose mappen** (Pi 5: `/dev/video19`–`35` + `/dev/media*`),
  `group_add: ["44"]` = Host-Gruppe `video`.
- **Cache-Volume gehört anfangs root** — der Entrypoint chownt `/cache` auf den
  Container-User (root → node, uid 1000) via `su-exec`.
- **`su-exec` setzt nur uid:gid, keine supplementary groups** — deshalb legt der
  Entrypoint die v4l2-Devices per `chmod 666` offen statt auf Gruppen zu setzen.
- **uid 1000 im Container = Host-User daniel** — Dateirechte auf gemappten Medien
  stimmen ohne chmod-Aktionen.
- **Kein `docker compose` v2 auf dem Pi-Host** — `docker-compose` (v1) verwenden.
- Alpine-`node:20-alpine` hat bereits einen User mit uid 1000 (`node`) — nicht
  `adduser` mit uid 1000 versuchen.
