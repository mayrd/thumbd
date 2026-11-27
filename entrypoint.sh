#!/bin/sh
# thumbd entrypoint: ensure cache volume permissions (as root), then run the daemon
# as the configured user. The container starts as root ONLY to chown the cache volume
# (named volumes initially belong to root) and to open up the v4l2 devices; it then
# drops privileges via setpriv (Debian util-linux; the Alpine build used su-exec).
#
# PUID / PGID default to 1000:1000 — set them to your host user's ids so
# file permissions on the mounted media folders just work (no chmod gymnastics).
set -e
UID_NUM="${PUID:-1000}"
GID_NUM="${PGID:-1000}"

mkdir -p /cache /data
chown -R "$UID_NUM:$GID_NUM" /cache 2>/dev/null || true
# Open up v4l2 HW decoders for the runtime user (container-local, harmless).
# Only relevant when v4l2 devices are mapped in the compose (optional, Pi 5 HEVC).
chmod 666 /dev/video* /dev/media* 2>/dev/null || true

# Preload jemalloc when available so sharp/libvips enables multi-threaded resizing
# on glibc-based Linux instead of falling back to sharp.concurrency(1).
if [ -z "${LD_PRELOAD:-}" ]; then
  for lib in /usr/lib/*-linux-gnu/libjemalloc.so.2 /usr/lib/libjemalloc.so.2; do
    if [ -f "$lib" ]; then
      export LD_PRELOAD="$lib"
      break
    fi
  done
fi

echo "thumbd: running as uid=$UID_NUM gid=$GID_NUM"
exec setpriv --reuid="$UID_NUM" --regid="$GID_NUM" --init-groups node /app/server.js
