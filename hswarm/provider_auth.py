"""Provider-specific API-key headers shared by chat and capability-specific REST operations."""
from __future__ import annotations


def auth_query(spec: dict) -> str | None:
    """The query parameter a provider expects its key in, e.g. Tomorrow.io's `apikey`. A provider that sets
    `auth_query` authenticates in the URL's query string and sends no Authorization header."""
    field = spec.get("auth_query")
    return field if isinstance(field, str) and field else None


def request_headers(spec: dict, key: str) -> dict[str, str]:
    header = spec.get("auth_header", "Authorization")
    prefix = spec.get("auth_prefix", "Bearer ")
    headers = dict(spec.get("headers") or {})
    # A keyless provider's pool holds a placeholder, never a credential: sending it is refused by a host that checks
    # any Authorization it gets (OVHcloud AI Endpoints answers 403), so it sends none.
    if spec.get("keyless"):
        return headers
    # A query-auth provider's key rides the query string (service.py/_check_by_get); never also send it as a header.
    if auth_query(spec):
        return headers
    # Credential always wins over a static attribution header; never place it in a URL/query string.
    headers[header] = prefix + key
    return headers
