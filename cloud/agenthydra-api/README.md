# AgentHydra API

AgentHydra's own API, run on our server. People (the managers and authority you set up in AgentHydra) are its first module. It is the cloud home for your people: AgentHydra on each of your PCs signs in with Connections and keeps its people folders in step with it.

**TL;DR**

- You sign in with Connections. Connections only proves who you are; your data is stored here, encrypted.
- Routes are `GET /healthz` plus `/v1/people/docs` and `/v1/me/...`. Everything but `/healthz` needs a bearer token.
- Limits: 600 KB per request, 512 KB per document, 200 documents and 8 MB per user.
- A weekly export covers only users whose `trainingUse` preference is on, under a pseudonym, with portraits left out. A user can turn it off, and it is on until they do.
- Local dev: `bun install`, then `bun test`. Tests use PGlite, so no Docker.
- `deploy/build-release.sh` makes the release tarball. The box setup is in [deploy/README.md](deploy/README.md).

<details>
<summary>Routes</summary>

| Route | What it does |
| --- | --- |
| `GET /healthz` | No sign-in. `ok`, `db`, `jwks`, `writeBlocked` and `lastBackupAgeSeconds`. 200 when the database and the key set are reachable, else 503. |
| `GET /v1/people/docs` | Lists your documents, 100 per page; `?cursor=<id>` for the next page. |
| `GET /v1/people/docs/<id>` | One document and its version. 404 when missing. |
| `POST /v1/people/docs/<id>` | Body `{ doc, baseVersion }`. A stale `baseVersion` gets 409 with `currentVersion`. |
| `DELETE /v1/people/docs/<id>` | Deletes one document. |
| `GET /v1/me/preferences`, `PUT /v1/me/preferences` | Reads or sets `{ trainingUse, termsVersion }`. |
| `GET /v1/me/export` | A zip of everything stored for you. |
| `DELETE /v1/me` | Erases everything stored for you. |

A document id is 1 to 128 of `A-Z a-z 0-9 . _ -`. Errors are `{ error, hint }`. Responses are never cached.

</details>

<details>
<summary>Sign-in</summary>

The client sends `Authorization: Bearer <token>`. The token is a Sign in with Connections JWT. The API checks its RS256 signature against the issuer's public key set (JWKS), plus the issuer, the audience, `sub` and `exp`, with 30 seconds of clock skew. The `sub` is your account; every read and write is scoped to it. Ten failed sign-ins a minute from one address are refused with 429.

</details>

<details>
<summary>Settings</summary>

Each name is read as `AGENTHYDRA_API_<NAME>`, then `AGENTHYDRA_<NAME>`. `DATABASE_URL` and `PORT` may also be bare.

| Name | Meaning |
| --- | --- |
| `DATABASE_URL` | Required. Postgres connection string. |
| `JWKS_URL`, `JWT_ISSUER`, `JWT_AUDIENCE` | Required. Where tokens are verified. The audience is the issuer's site URL, not a client id. |
| `MASTER_KEY` or `MASTER_KEYS` | Required. The key that encrypts documents. `MASTER_KEYS` is a list of `<id>:<key>` for key rotation. |
| `AUDIT_SALT` | Required. Salt for the pseudonyms in logs and exports. |
| `PORT` | Default 18790. |
| `WRITE_BLOCK_FILE` | Default `/run/agenthydra/write-block`. While it exists, writes get 503 and reads still work. |
| `BACKUP_STAMP_FILE` | Default `/var/backups/agenthydra/last-backup`. Read by `/healthz`. |
| `TRUST_PROXY` | `0` stops trusting the proxy's client-address header. |
| `AGENTHYDRA_EXPORT_DIR` | Where the weekly export writes (default `/var/lib/agenthydra/people-export`). |

AgentHydra on your PC finds the API through `AGENTHYDRA_API_URL`. The public address is written `api.agenthydra.example.com` in this repo.

</details>

<details>
<summary>Limits</summary>

- Requests: 600 KB body, 120 per minute per address, 60 reads and 20 writes a minute per user. Over a limit is 429 (413 for a big body).
- Storage: 512 KB per document, 200 documents and 8 MB per user.
- Documents are encrypted before they reach the database.

</details>

<details>
<summary>Training export</summary>

The `trainingUse` preference is on by default (a user can turn it off with `PUT /v1/me/preferences`). Once a week (Sunday 04:30 UTC) a job writes `people.jsonl` for the users whose preference is on:

- Each user appears only under a pseudonym (an HMAC of their account with the audit salt), never by account.
- A document is left out when its id contains "portrait" or it has a top-level `portrait` key. When unsure, it is dropped.
- Files are owner-only and a snapshot is removed after 30 days.
- The job reads from a database view limited to opted-in users, with its own read-only role.

</details>

<details>
<summary>Local dev, tests and release</summary>

```sh
cd cloud/agenthydra-api
bun install
bun test
```

Tests run against PGlite (Postgres in-process), so Docker is not needed.

`deploy/build-release.sh [out-dir]` builds the server, migration and export bundles plus `migrations/` and the deploy scripts into `agenthydra-api-<UTC time>.tar.gz` (default folder `dist/`). It prints the tarball path, then its sha256. Setting up a box, backups and rollback are in [deploy/README.md](deploy/README.md).

</details>
