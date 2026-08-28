#!/usr/bin/env bash
set -euo pipefail

# Require an explicit Compose project and an encryption recipient outside the database.
: "${COMPOSE_FILE:?COMPOSE_FILE is required}"
: "${AGE_RECIPIENT_FILE:?AGE_RECIPIENT_FILE is required}"
: "${COMPOSE_ENV_FILE:?COMPOSE_ENV_FILE is required}"
: "${BACKUP_DIR:=/var/lib/aialra-model-router/backups}"

# Create one encrypted, timestamped database stream without writing a plaintext dump.
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
recipient="$(<"$AGE_RECIPIENT_FILE")"
umask 077
docker compose --env-file "$COMPOSE_ENV_FILE" --file "$COMPOSE_FILE" exec -T postgres \
  pg_dump --username router --dbname router --format=custom \
  | age --recipient "$recipient" --output "$BACKUP_DIR/router-$timestamp.dump.age"

# Retain fourteen daily artifacts inside the dedicated backup directory.
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'router-*.dump.age' -mtime +14 -delete
