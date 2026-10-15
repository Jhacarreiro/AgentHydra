# AgentHydra API: box-side deploy

Files here use placeholders only. Nothing in this folder holds a real host, IP, key or password.

## Placeholders

| Placeholder | Meaning |
| --- | --- |
| `api.agenthydra.example.com` | Public hostname, set in `32-agenthydra-api.caddy` before install (owner decides). |
| `__AGENTHYDRA_JWKS_URL__`, `__AGENTHYDRA_JWT_ISSUER__`, `__AGENTHYDRA_JWT_AUDIENCE__` | Token verification settings written into `/etc/agenthydra/api.env` by `bootstrap.sh`; replace by hand. |
| `AGENTHYDRA_DB_*_PASSWORD`, `AGENTHYDRA_MASTER_KEY`, `AGENTHYDRA_AUDIT_SALT` | Generated on the box by `bootstrap.sh` with `openssl rand`, never printed. Keep an offline copy of the master key. |
| `/etc/agenthydra/diskguard.env` (optional) | `AGENTHYDRA_MIN_FREE_GB` (default 15), `AGENTHYDRA_MAX_PG_GB` (default 20), `AGENTHYDRA_FLAG_DIR` (default `/run/agenthydra`; the server returns 503 on writes while `write-block` exists there). |

Also needed on the box: the pinned `bun` at `/opt/agenthydra-api/bin/bun` (root-owned), the release tarball, and `backup.sh` / the export entry point from the release.

## Order (needs the owner's go; plan section 10)

1. Disk first: run the safe docker cleaner (never volumes). Proof: `df -h /` before and after, under 70 %.
2. `sudo ./bootstrap.sh`. Proof: `id agenthydra`; `stat -c '%U %a' /etc/agenthydra` = `root 700`; `stat -c '%U %a' /etc/agenthydra/api.env` = `root 600`; `docker ps --filter name=agenthydra-pg`; `ss -tlnH | grep 5433` shows `127.0.0.1` only.
3. Fill the placeholders in `/etc/agenthydra/api.env`. Proof: `sudo -u prometheus cat /etc/agenthydra/api.env` is permission denied.
4. `sudo ./agenthydra-api-deploy.sh <tarball> <sha256> <version>` (applies migrations as `agenthydra_owner`). Install units first: copy `*.service` and `*.timer` to `/etc/systemd/system/`, `systemctl daemon-reload`, `systemctl enable --now agenthydra-api agenthydra-backup.timer people-export.timer agenthydra-diskguard.timer`. Proof: `docker exec agenthydra-pg psql -U agenthydra_owner -d people -c '\dt'`; `systemctl is-active agenthydra-api`; `curl -s 127.0.0.1:18790/healthz`; `systemd-analyze security agenthydra-api` (target 2.5 or lower); `systemd-analyze verify /etc/systemd/system/people-*.service`.
5. DNS record for the hostname, then copy `32-agenthydra-api.caddy` to `/etc/caddy/sites/`, keep one `.before-agenthydra` copy of the Caddyfile, `caddy validate`, reload. Proof: `curl -sI https://api.agenthydra.example.com/healthz` is 200 with a valid cert; other sites still answer.
6. Synthetic identity test only: write, read, 409 on a stale write, delete-me. Proof: printed statuses; DB count for that scope = 0 afterwards.
7. Backup run and restore test. Proof: `systemctl start agenthydra-backup.service`; counts and sample hash equal; `/healthz` shows a recent backup.
8. Disk guard test: `AGENTHYDRA_MIN_FREE_GB=100000 /opt/agenthydra-api/current/deploy/diskguard.sh` writes the flag, writes get 503, reads work; run it again without the override to clear. Proof: `ls /run/agenthydra`, `journalctl -t agenthydra-diskguard -n 5`.
9. Isolation: `sudo -u kumod ls /var/backups/agenthydra` and `sudo -u prometheus cat /etc/agenthydra/api.env` are denied; the other services stay `active`.

## Rollback

Point `current` back at the previous release (`ln -sfn /opt/agenthydra-api/releases/<old> /opt/agenthydra-api/current.new && mv -T /opt/agenthydra-api/current.new /opt/agenthydra-api/current`) and `systemctl restart agenthydra-api`. `agenthydra-api-deploy.sh` does this by itself when the health check fails. To remove the site, delete `/etc/caddy/sites/32-agenthydra-api.caddy`, `caddy validate`, reload, and delete the DNS record. The `agenthydra-pg` container and its volume stay; rows are never dropped.
