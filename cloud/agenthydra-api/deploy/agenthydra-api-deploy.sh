#!/usr/bin/env bash
# Usage (root): agenthydra-api-deploy.sh <tarball> <expected-sha256> <version>
# Verifies the tarball, unpacks to /opt/agenthydra-api/releases/<version>, runs migrations
# as agenthydra_owner, flips /opt/agenthydra-api/current, restarts, health-checks, and rolls the
# symlink back on failure. Never drops data.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
[ "$#" -eq 3 ] || { echo "usage: $0 <tarball> <sha256> <version>" >&2; exit 2; }

TARBALL="$1"; SHA="$2"; VER="$3"
case "$VER" in *[!A-Za-z0-9._-]*|"") echo "bad version" >&2; exit 2 ;; esac
ROOT=/opt/agenthydra-api
REL="$ROOT/releases/$VER"
CUR="$ROOT/current"
HEALTH="http://127.0.0.1:18790/healthz"

actual=$(sha256sum "$TARBALL" | awk '{print $1}')
[ "$actual" = "$SHA" ] || { echo "sha256 mismatch" >&2; exit 1; }

[ ! -e "$REL" ] || { echo "release $VER already exists" >&2; exit 1; }
mkdir -p "$REL"
tar -xzf "$TARBALL" -C "$REL"
chown -R root:root "$REL"
chmod -R go-w "$REL"

prev=""
if [ -L "$CUR" ]; then prev=$(readlink -f "$CUR"); fi

# Migrations as agenthydra_owner; the password comes from the env file and is not printed.
(
  set -a
  # shellcheck disable=SC1091
  . /etc/agenthydra/api.env
  set +a
  export DATABASE_URL="postgres://agenthydra_owner:${AGENTHYDRA_DB_OWNER_PASSWORD}@127.0.0.1:5433/agenthydra"
  cd "$REL"
  /opt/agenthydra-api/bin/bun "$REL/migrate.js"
)

ln -sfn "$REL" "$CUR.new"
mv -T "$CUR.new" "$CUR"

systemctl restart agenthydra-api

ok=0
for _ in $(seq 1 20); do
  if curl -fsS --max-time 3 "$HEALTH" >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done

if [ "$ok" -ne 1 ]; then
  echo "health check failed; rolling back" >&2
  if [ -n "$prev" ]; then
    ln -sfn "$prev" "$CUR.new"
    mv -T "$CUR.new" "$CUR"
    systemctl restart agenthydra-api || true
  else
    systemctl stop agenthydra-api || true
  fi
  exit 1
fi
echo "deployed $VER"
