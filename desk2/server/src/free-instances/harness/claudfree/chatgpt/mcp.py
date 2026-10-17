"""MCP tools for private HTTP chats with automatic lightweight preparation."""

import json

from ..errors import ClaudeError
from .api import ChatGPTClient


def build_server(client=None):
    try:
        from mcp.server import MCPServer
        from mcp.types import CallToolResult, TextContent, ToolAnnotations
    except ImportError:
        raise ClaudeError(
            "Install MCP support: pip install -e '.[mcp]'", code="missing_dependency"
        ) from None
    client = client or ChatGPTClient()
    server = MCPServer(
        "ClaudFree ChatGPT",
        version="0.8.0",
        log_level="WARNING",
        instructions=f"Call chatgpt_schema for capability limits. Automatic preparation: {client.auto_prepare}. With automatic preparation enabled, call create/resume directly: the saved login is restored in a disposable headless browser context for one ordinary send, then HTTP verifies the reply. Read-only commands never open a browser. chatgpt_prepare is only for explicit legacy sends with auto_prepare=False; it does not prewarm automatic browser sends. No automatic resend after an uncertain result; read chat_id first. Login is a separate manual CLI command.",
    )
    read = ToolAnnotations(
        read_only_hint=True, destructive_hint=False, idempotent_hint=True, open_world_hint=True
    )
    send = ToolAnnotations(
        read_only_hint=False, destructive_hint=False, idempotent_hint=False, open_world_hint=True
    )
    local = ToolAnnotations(
        read_only_hint=False, destructive_hint=False, idempotent_hint=True, open_world_hint=False
    )

    def call(operation, *args, **kwargs):
        try:
            result = operation(*args, **kwargs)
        except ClaudeError as error:
            result = {"ok": False, "schema_version": 1, "error": error.as_dict()}
        except Exception:
            result = {
                "ok": False,
                "schema_version": 1,
                "error": {
                    "code": "operation_failed",
                    "message": "The ChatGPT operation failed; no automatic resend was made.",
                    "retryable": False,
                },
            }
        return CallToolResult(
            content=[TextContent(text=json.dumps(result, ensure_ascii=False))],
            structured_content=result,
            is_error=not result["ok"],
        )

    @server.tool(annotations=read)
    def chatgpt_schema() -> CallToolResult:
        """Offline capabilities, privacy checks, UUID meanings and recovery rules."""
        return call(
            lambda: {
                **client.schema(),
                "configured_auto_prepare": client.auto_prepare,
            }
        )

    @server.tool(annotations=read)
    def chatgpt_auth() -> CallToolResult:
        """Verify the saved ChatGPT login with HTTP; never returns credentials."""
        return call(client.auth)

    @server.tool(annotations=read)
    def chatgpt_preparation_status() -> CallToolResult:
        """Offline count/expiry of unused verification. This is not the account usage allowance."""
        return call(client.preparation_status)

    @server.tool(annotations=send)
    def chatgpt_prepare(count: int = 3) -> CallToolResult:
        """Prepare 1-8 explicit legacy HTTP sends (auto_prepare=False). Automatic browser sends do not use this pool. No message is sent."""
        return call(client.prepare, count)

    @server.tool(annotations=read)
    def chatgpt_list_chats(check: bool = False) -> CallToolResult:
        """List local names/UUIDs offline. check=True verifies availability with HTTP reads."""
        return call(client.list_chats, check=check)

    @server.tool(annotations=read)
    def chatgpt_read_chat(reference: str, full: bool = False) -> CallToolResult:
        """Read private turns, code and links by name/UUID, using the saved login and automatic Temporary routing."""
        return call(client.read, reference, brief=not full)

    @server.tool(annotations=read)
    def chatgpt_usage() -> CallToolResult:
        """Report unsupported counters explicitly as unknown; never sends a message."""
        return call(client.usage)

    @server.tool(annotations=send)
    def chatgpt_create_chat(prompt: str, name: str | None = None) -> CallToolResult:
        """Create a Temporary, unpersonalized chat. Automatic preparation uses the saved login in a headless browser; no automatic resend."""
        return call(client.create, prompt, name=name, brief=True)

    @server.tool(annotations=send)
    def chatgpt_resume_chat(reference: str, prompt: str) -> CallToolResult:
        """Continue a Temporary Chat by name/UUID. Automatic preparation uses the saved login in a headless browser; no automatic resend."""
        return call(client.resume, reference, prompt, brief=True)

    @server.tool(annotations=local)
    def chatgpt_track_chat(reference: str, name: str) -> CallToolResult:
        """Validate a private chat by name/UUID and save its local alias. Requires the saved login."""
        return call(client.track, reference, name)

    @server.resource("claudfree://chatgpt/schema")
    def schema_resource() -> str:
        return json.dumps(client.schema())

    return server
