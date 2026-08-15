# thumbd — Thumbnail-Daemon (ARM64/Docker)
# Multi-Stage: node:20-alpine Basis (sharp libvips prebuilt), ffmpeg aus Alpine-Repo.

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:20-alpine
LABEL org.opencontainers.image.title="thumbd" \
      org.opencontainers.image.description="Persistenter Thumbnail-Daemon (sharp + ffmpeg HW-Decode)" \
      org.opencontainers.image.source="https://github.com/mayrd/thumbd"

# ffmpeg/ffprobe (Alpine) — fuer Video-Stills. su-exec fuer den Entrypoint (root→node).
# Der node:20-alpine-Basisuser 'node' hat bereits uid 1000 = Host-User daniel → direkt nutzen.
RUN apk add --no-cache ffmpeg su-exec

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY server.js entrypoint.sh ./
RUN chmod +x entrypoint.sh

# Cache + Daten (Volumes; /data ist der gemappte Medien-Ordner)
RUN mkdir -p /cache /data && chown -R node:node /cache /data /app
USER node

EXPOSE 8090
ENV THUMBD_PORT=8090 \
    THUMBD_ROOTS=/data \
    THUMBD_CACHE=/cache \
    THUMBD_V4L2=h264_v4l2m2m

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8090/health >/dev/null 2>&1 || exit 1

# Als root starten (Entrypoint macht chown), dann zu node (uid 1000) wechseln
USER root
ENTRYPOINT ["/app/entrypoint.sh"]
