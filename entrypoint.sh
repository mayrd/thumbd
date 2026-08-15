#!/bin/sh
# thumbd entrypoint: ensure cache volume permissions (as root), then run the daemon
# as the configured user. The container starts as root ONLY to chown the cache volume
# (named volumes initially belong to root) and to open up the v4l2 devices; it then
# drops privileges via su-exec.
#
# THUMBD_UID / THUMBD_GID default to 1000:1000 — set them to your host user's ids so
# file permissions on the mounted media folders just work (no chmod gymnastics).
set -e
UID_NUM="${THUMBD_UID:-1000}"
GID_NUM="${THUMBD_GID:-1000}"

mkdir -p /cache /data
chown -R "$UID_NUM:$GID_NUM" /cache 2>/dev/null || true
# Open up v4l2 HW decoders for the runtime user (container-local, harmless).
# Only relevant when v4l2 devices are mapped in the compose (optional, Pi 5 HEVC).
chmod 666 /dev/video* /dev/media* 2>/dev/null || true

echo "thumbd: running as uid=$UID_NUM gid=$GID_NUM"
exec su-exec "$UID_NUM:$GID_NUM" node /app/server.js
