#!/bin/sh
# thumbd entrypoint: Cache-Volume- und v4l2-Device-Rechte sicherstellen (als root),
# dann als node (uid 1000) starten. su-exec setzt nur uid:gid — die supplementary
# groups (video/44) gehen dabei verloren, daher werden die Devices hier offen gelegt.
set -e
mkdir -p /cache /data
chown -R node:node /cache 2>/dev/null || true
# v4l2-Hardware-Decoder fuer den node-User oeffnen (Container-lokal unkritisch)
chmod 666 /dev/video* /dev/media* 2>/dev/null || true
exec su-exec node node /app/server.js
