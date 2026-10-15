#!/usr/bin/env bash
# First install, box side. Run as root. Idempotent.
# Does not touch Caddy, other services, ports 25/587 or the runners.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

id people >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin people

install -d -m 0755 -o root -g root /opt/people /opt/people/releases /opt/people/bin
install -d -m 0700 -o root -g root /etc/people /var/backups/people

gen() { openssl rand -base64 48 | tr -d '\n=+/' | cut -c1-40; }

umask 077
if [ ! -f /etc/people/pg.env ]; then
  {
    echo "POSTGRES_USER=people_owner"
    echo "POSTGRES_PASSWORD=$(gen)"
    echo "POSTGRES_DB=people"
  } > /etc/people/pg.env
fi

if [ ! -f /etc/people/people.env ]; then
  owner_pw=$(grep '^POSTGRES_PASSWORD=' /etc/people/pg.env | cut -d= -f2-)
  app_pw=$(gen)
  backup_pw=$(gen)
  {
    echo "PORT=18790"
    echo "PEOPLE_DB_OWNER_PASSWORD=${owner_pw}"
    echo "PEOPLE_DB_APP_PASSWORD=${app_pw}"
    echo "PEOPLE_DB_BACKUP_PASSWORD=${backup_pw}"
    echo "DATABASE_URL=postgres://people_app:${app_pw}@127.0.0.1:5433/people"
    echo "PEOPLE_MASTER_KEY=$(openssl rand -base64 32)"
    echo "PEOPLE_AUDIT_SALT=$(openssl rand -hex 32)"
    echo "PEOPLE_JWKS_URL=__PEOPLE_JWKS_URL__"
    echo "PEOPLE_JWT_ISSUER=__PEOPLE_JWT_ISSUER__"
    echo "PEOPLE_JWT_AUDIENCE=__PEOPLE_JWT_AUDIENCE__"
  } > /etc/people/people.env
fi
chown root:root /etc/people/pg.env /etc/people/people.env
chmod 0600 /etc/people/pg.env /etc/people/people.env

install -m 0644 "$HERE/people-pg.compose.yml" /opt/people/people-pg.compose.yml
docker compose -f /opt/people/people-pg.compose.yml up -d

echo "bootstrap done. Replace the __PEOPLE_*__ placeholders in /etc/people/people.env."
echo "Next: install the units, then run people-deploy.sh."
