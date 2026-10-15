Bundled ClaudFree 0.8.0 transport source, developed for this project. Desk's adapter uses its HTTP
clients for Claude Incognito and ChatGPT Temporary Chats. Manual login uses zendriver with the
installed Chrome or Edge on a throwaway profile. ChatGPT automatic sends also restore the saved
login in an owned browser for current first-party request preparation; no email login is submitted.
The ordinary browser sends the requested message once, then Python verifies HTTP readback
without resending. This also renews browser-issued cookies. Interactive verification is never
bypassed. At most three owned request browsers run together; each profile is removed afterward.
`desk_entry.py` provides a structured login result and closes its owned window on success.
The shared JavaScript cache is selected with `CLAUDFREE_CACHE_DIR`; each account uses a separate
`CLAUDFREE_STATE_DIR`. The package can still be used through Python, its CLI, or MCP.

Dependencies are installed into Desk's data home. No credentials, runtime caches, virtual environments, diagnostics or recorded chats belong here.
ChatGPT's Node dependencies are local copies: setup rejects links into an external package store so
the restricted preparation process can read its dependencies without broader filesystem permissions.
Desk's ChatGPT sender uses the account's default text model (GPT-5.6 Luna Instant while it is listed, else the
newest `gpt-instant`) unless a new chat asks for a role name (`gpt-instant`, `gpt-thinking`, `gpt-auto`, resolved per
account to the newest listed model in that role), a pinned name or a listed slug; `usage` reports `roles` and
`default_moved`. `usage` verifies Free account access and model
availability over HTTP before reporting unlimited everyday text; tools retain separate limits.

The asset manifest hashes the original HTTPS bytes (LF line endings). Two modules previously cached
with Windows CRLF endings contain identical code; these hashes let a clean installation download and
verify the provider's original bytes directly.
