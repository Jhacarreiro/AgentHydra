# People server: box-side deploy

Files here use placeholders only. Nothing in this folder holds a real host, IP, key or password.

## Placeholders

| Placeholder | Meaning |
| --- | --- |
| `people.example.com` | Public hostname, set in `32-people.caddy` before install (owner decides). |
| `__PEOPLE_JWKS_URL__`, `__PEOPLE_JWT_ISSUER__`, `__PEOPLE_JWT_AUDIENCE__` | Token verification settings written into `/etc/people/people.env` by `bootstrap.sh`; replace by hand. |
| `PEOPLE_DB_*_PASSWORD`, `PEOPLE_MASTER_KEY`, `PEOPLE_AUDIT_SALT` | Generated on the box by `bootstrap.sh` with `openssl rand`, never printed. Keep an offline copy of the master key. |
| `/etc/people/diskguard.env` (optional) | `PEOPLE_MIN_FREE_GB` (default 15), `PEOPLE_MAX_PG_GB` (default 20), `PEOPLE_FLAG_DIR` (default `/run/people`; the server returns 503 on writes while `write-block` exists there). |

Also needed on the box: the pinned `bun` at `/opt/people/bin/bun` (root-owned), the release tarball, and `backup.sh` / the export entry point from the release.

## Order (needs the owner's go; plan section 10)

1. Disk first: run the safe docker cleaner (never volumes). Proof: `df -h /` before and after, under 70 %.
2. `sudo ./bootstrap.sh`. Proof: `id people`; `stat -c '%U %a' /etc/people` = `root 700`; `stat -c '%U %a' /etc/people/people.env` = `root 600`; `docker ps --filter name=people-pg`; `ss -tlnH | grep 5433` shows `127.0.0.1` only.
3. Fill the placeholders in `/etc/people/people.env`. Proof: `sudo -u prometheus cat /etc/people/people.env` is permission denied.
4. `sudo ./people-deploy.sh <tarball> <sha256> <version>` (applies migrations as `people_owner`). Install units first: copy `*.service` and `*.timer` to `/etc/systemd/system/`, `systemctl daemon-reload`, `systemctl enable --now people-server people-backup.timer people-export.timer people-diskguard.timer`. Proof: `docker exec people-pg psql -U people_owner -d people -c '\dt'`; `systemctl is-active people-server`; `curl -s 127.0.0.1:18790/healthz`; `systemd-analyze security people-server` (target 2.5 or lower); `systemd-analyze verify /etc/systemd/system/people-*.service`.
5. DNS record for the hostname, then copy `32-people.caddy` to `/etc/caddy/sites/`, keep one `.before-people` copy of the Caddyfile, `caddy validate`, reload. Proof: `curl -sI https://people.example.com/healthz` is 200 with a valid cert; other sites still answer.
6. Synthetic identity test only: write, read, 409 on a stale write, delete-me. Proof: printed statuses; DB count for that scope = 0 afterwards.
7. Backup run and restore test. Proof: `systemctl start people-backup.service`; counts and sample hash equal; `/healthz` shows a recent backup.
8. Disk guard test: `PEOPLE_MIN_FREE_GB=100000 /opt/people/current/deploy/diskguard.sh` writes the flag, writes get 503, reads work; run it again without the override to clear. Proof: `ls /run/people`, `journalctl -t people-diskguard -n 5`.
9. Isolation: `sudo -u kumod ls /var/backups/people` and `sudo -u prometheus cat /etc/people/people.env` are denied; the other services stay `active`.

## Rollback

Point `current` back at the previous release (`ln -sfn /opt/people/releases/<old> /opt/people/current.new && mv -T /opt/people/current.new /opt/people/current`) and `systemctl restart people-server`. `people-deploy.sh` does this by itself when the health check fails. To remove the site, delete `/etc/caddy/sites/32-people.caddy`, `caddy validate`, reload, and delete the DNS record. The `people-pg` container and its volume stay; rows are never dropped.
