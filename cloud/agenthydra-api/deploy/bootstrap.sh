#!/usr/bin/env bash
# First install, box side. Run as root. Idempotent.
# Does not touch Caddy, other services, ports 25/587 or the runners.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

id agenthydra >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin agenthydra

install -d -m 0755 -o root -g root /opt/agenthydra-api /opt/agenthydra-api/releases /opt/agenthydra-api/bin
install -d -m 0700 -o root -g root /etc/agenthydra /var/backups/agenthydra

gen() { openssl rand -base64 48 | tr -d '\n=+/' | cut -c1-40; }

umask 077
if [ ! -f /etc/agenthydra/pg.env ]; then
  {
    echo "POSTGRES_USER=agenthydra_owner"
    echo "POSTGRES_PASSWORD=$(gen)"
    echo "POSTGRES_DB=agenthydra"
  } > /etc/agenthydra/pg.env
fi

if [ ! -f /etc/agenthydra/api.env ]; then
  owner_pw=$(grep '^POSTGRES_PASSWORD=' /etc/agenthydra/pg.env | cut -d= -f2-)
  app_pw=$(gen)
  backup_pw=$(gen)
  {
    echo "PORT=18790"
    echo "AGENTHYDRA_DB_OWNER_PASSWORD=${owner_pw}"
    echo "AGENTHYDRA_DB_APP_PASSWORD=${app_pw}"
    echo "AGENTHYDRA_DB_BACKUP_PASSWORD=${backup_pw}"
    echo "DATABASE_URL=postgres://agenthydra_app:${app_pw}@127.0.0.1:5433/agenthydra"
    echo "AGENTHYDRA_MASTER_KEY=$(openssl rand -base64 32)"
    echo "AGENTHYDRA_AUDIT_SALT=$(openssl rand -hex 32)"
    echo "AGENTHYDRA_JWKS_URL=__AGENTHYDRA_JWKS_URL__"
    echo "AGENTHYDRA_JWT_ISSUER=__AGENTHYDRA_JWT_ISSUER__"
    echo "AGENTHYDRA_JWT_AUDIENCE=__AGENTHYDRA_JWT_AUDIENCE__"
  } > /etc/agenthydra/api.env
fi
chown root:root /etc/agenthydra/pg.env /etc/agenthydra/api.env
chmod 0600 /etc/agenthydra/pg.env /etc/agenthydra/api.env

install -m 0644 "$HERE/agenthydra-pg.compose.yml" /opt/agenthydra-api/agenthydra-pg.compose.yml
docker compose -f /opt/agenthydra-api/agenthydra-pg.compose.yml up -d

echo "bootstrap done. Replace the __AGENTHYDRA_*__ placeholders in /etc/agenthydra/api.env."
echo "Next: install the units, then run agenthydra-api-deploy.sh."
