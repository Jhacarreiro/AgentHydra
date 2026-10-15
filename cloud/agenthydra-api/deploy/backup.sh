#!/usr/bin/env bash
# Nightly encrypted backup of the agenthydra database. Runs as root from agenthydra-backup.timer.
# pg_dump is piped straight into the encryptor: no plaintext dump ever touches disk.
set -euo pipefail
umask 077

ENV_FILE=/etc/agenthydra/backup.env
API_ENV=/etc/agenthydra/api.env
CONTAINER=agenthydra-pg
DEST=/var/backups/agenthydra
KEEP=7
STAMP_FILE="$DEST/last-backup"

log() { echo "agenthydra-backup: $*"; }
die() { echo "agenthydra-backup: ERROR: $*" >&2; exit 1; }

[ -r "$ENV_FILE" ] || die "missing $ENV_FILE"
[ -r "$API_ENV" ] || die "missing $API_ENV"
# shellcheck disable=SC1090
. "$ENV_FILE"
: "${AGENTHYDRA_BACKUP_BUCKET:?set in backup.env}"
: "${AGENTHYDRA_BACKUP_REGION:?set in backup.env}"
PREFIX="${AGENTHYDRA_BACKUP_PREFIX:-agenthydra-api}"

PGPW=$(grep '^AGENTHYDRA_DB_BACKUP_PASSWORD=' "$API_ENV" | cut -d= -f2-)
[ -n "$PGPW" ] || die "AGENTHYDRA_DB_BACKUP_PASSWORD not found in api.env"

install -d -m 0700 "$DEST"
ts=$(date -u +%Y%m%dT%H%M%SZ)
tmp="$DEST/.partial-$ts"
GNUPGTMP=""
cleanup() {
  [ -z "$GNUPGTMP" ] || rm -rf "$GNUPGTMP"
  rm -f "$tmp"
}
trap cleanup EXIT

if command -v age >/dev/null 2>&1; then
  : "${AGENTHYDRA_BACKUP_AGE_RECIPIENT:?set in backup.env}"
  ext=dump.age
  encrypt() { age -r "$AGENTHYDRA_BACKUP_AGE_RECIPIENT"; }
elif command -v gpg >/dev/null 2>&1; then
  : "${AGENTHYDRA_BACKUP_GPG_PUBKEY_FILE:?set in backup.env}"
  : "${AGENTHYDRA_BACKUP_GPG_RECIPIENT:?set in backup.env}"
  GNUPGTMP=$(mktemp -d)
  chmod 700 "$GNUPGTMP"
  gpg --homedir "$GNUPGTMP" --batch --quiet --import "$AGENTHYDRA_BACKUP_GPG_PUBKEY_FILE"
  ext=dump.gpg
  encrypt() { gpg --homedir "$GNUPGTMP" --batch --yes --trust-model always --encrypt --recipient "$AGENTHYDRA_BACKUP_GPG_RECIPIENT"; }
else
  die "neither age nor gpg is installed"
fi

out="$DEST/agenthydra-$ts.$ext"

# PGPASSWORD is passed by name so it never appears in the process list or logs.
PGPASSWORD="$PGPW" docker exec -i -e PGPASSWORD "$CONTAINER" \
  pg_dump -Fc -h 127.0.0.1 -U agenthydra_backup -d agenthydra | encrypt >"$tmp"
[ -s "$tmp" ] || die "encrypted dump is empty"
mv "$tmp" "$out"

size=$(stat -c %s "$out")
sha=$(sha256sum "$out" | cut -d' ' -f1)
log "encrypted dump $(basename "$out") bytes=$size sha256=$sha"

key="$PREFIX/$(basename "$out")"
AWS_SHARED_CREDENTIALS_FILE="${AGENTHYDRA_BACKUP_AWS_CREDENTIALS_FILE:-/etc/agenthydra/aws-credentials}" \
AWS_PROFILE="${AGENTHYDRA_BACKUP_AWS_PROFILE:-agenthydra-backup}" \
AWS_DEFAULT_REGION="$AGENTHYDRA_BACKUP_REGION" \
  aws s3 cp "$out" "s3://$AGENTHYDRA_BACKUP_BUCKET/$key" --sse AES256 --only-show-errors
log "uploaded to s3 key $key"

# Keep the newest $KEEP local encrypted dumps.
# shellcheck disable=SC2012
ls -1t "$DEST"/agenthydra-*.dump.* 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f -- "$old"
  log "pruned $(basename "$old")"
done

# Only after dump, encrypt and upload all succeeded: the timestamp /healthz reads.
date -u +%s >"$STAMP_FILE.tmp"
mv "$STAMP_FILE.tmp" "$STAMP_FILE"
log "done"
