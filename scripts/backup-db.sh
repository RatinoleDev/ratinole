#!/usr/bin/env bash
# Dump the database to a timestamped file and delete dumps older than
# BACKUP_KEEP_DAYS. Run daily from cron. Copy dumps off the server too.
#   ENV_FILE=/srv/rationale/.env scripts/backup-db.sh
set -euo pipefail

ENV_FILE="${ENV_FILE:-$(dirname "$0")/../.env}"
if [ -z "${DATABASE_URL:-}" ] && [ -f "$ENV_FILE" ]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | tail -1 | cut -d= -f2-)"
fi
: "${DATABASE_URL:?DATABASE_URL is not set}"

DIR="${BACKUP_DIR:-/var/backups/rationale}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
mkdir -p "$DIR"
chmod 700 "$DIR"

file="$DIR/rationale-$(date -u +%Y%m%dT%H%M%SZ).dump"
pg_dump --format=custom --no-owner --dbname="$DATABASE_URL" --file="$file.part"
mv "$file.part" "$file"
chmod 600 "$file"
find "$DIR" -name 'rationale-*.dump' -type f -mtime +"$KEEP_DAYS" -delete
echo "$file"
# Restore with: pg_restore --clean --no-owner --dbname="$DATABASE_URL" "$file"
