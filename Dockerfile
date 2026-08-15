# thumbd — thumbnail daemon (ARM64/Docker)
# Multi-stage: node:20-slim base (sharp libvips prebuilt), ffmpeg from Debian repo.

FROM node:20-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:20-slim
LABEL org.opencontainers.image.title="thumbd" \
      org.opencontainers.image.description="Persistent thumbnail daemon (sharp + ffmpeg HW decode)" \
      org.opencontainers.image.source="https://github.com/mayrd/thumbd"

# ffmpeg/ffprobe (Debian) — for video stills. No su-exec needed: setpriv (util-linux)
# is always present on Debian. The node:20-slim base user 'node' already has
# uid 1000 = host user (e.g. daniel on the Pi), so file permissions on mounted
# media match without chmod gymnastics.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY server.js entrypoint.sh ./
RUN chmod +x entrypoint.sh

# Cache + data (volumes; /data is the mounted media folder)
RUN mkdir -p /cache /data && chown -R node:node /cache /data /app
USER node

EXPOSE 8090
ENV THUMBD_PORT=8090 \
    THUMBD_CACHE=/cache \
    THUMBD_V4L2=h264_v4l2m2m

# Node 20 ships fetch — no wget/curl needed in the image
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8090/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Start as root (entrypoint chowns the cache volume), then drop to node (uid 1000)
USER root
ENTRYPOINT ["/app/entrypoint.sh"]
