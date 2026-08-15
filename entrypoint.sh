#!/bin/sh
# thumbd entrypoint: ensure cache volume + v4l2 device permissions (as root),
# then start as node (uid 1000). su-exec only sets uid:gid — supplementary groups
# (video/44) are lost, so the devices are opened up here instead.
set -e
mkdir -p /cache /data
chown -R node:node /cache 2>/dev/null || true
# Open up v4l2 HW decoders for the node user (container-local, harmless)
chmod 666 /dev/video* /dev/media* 2>/dev/null || true
exec su-exec node node /app/server.js
