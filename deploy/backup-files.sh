#!/usr/bin/env bash
# Nightly tar of the file-side data (artifacts + rrweb event logs) to the same
# S3-compatible bucket Litestream uses. The SQLite db itself is covered by
# Litestream; this covers everything that lives next to it.
#
# Cron (as the integral user):  0 4 * * *  /opt/integral/deploy/backup-files.sh
# Requires rclone configured with a remote named "backup".
set -euo pipefail

DATA_DIR="${INTEGRAL_DATA_DIR:-/opt/integral/data}"
STAMP="$(date +%Y-%m-%d)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

tar -czf "$TMP/integral-files-$STAMP.tar.gz" -C "$DATA_DIR" artifacts events
rclone copy "$TMP/integral-files-$STAMP.tar.gz" backup:YOUR_BUCKET/file-backups/
# Keep 14 nightlies.
rclone delete --min-age 14d backup:YOUR_BUCKET/file-backups/ || true
