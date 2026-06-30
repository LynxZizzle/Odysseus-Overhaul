# src/middleware.py
# Shared middleware, decorators, and request helpers

import os
import secrets

from fastapi import HTTPException, Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response


# Per-process token that lets the in-app tool layer hit admin-gated
# routes via HTTP loopback (the agent's tool calls don't carry the
# admin user's session cookie). Set once at import; tools read the
# same value from this module. Never persisted or exposed externally.
INTERNAL_TOOL_TOKEN = os.environ.get("ODYSSEUS_INTERNAL_TOKEN") or secrets.token_hex(32)
INTERNAL_TOOL_HEADER = "X-Odysseus-Internal-Token"
# Pseudo-username on in-process tool-loopback requests; require_admin trusts it and it is reserved.
INTERNAL_TOOL_USER = "internal-tool"


def is_cors_preflight(method: str, headers) -> bool:
    """True for a genuine CORS preflight: an OPTIONS request carrying the
    Access-Control-Request-Method header. Such requests are credential-less by
    design and must reach CORSMiddleware to be answered -- gating them on auth
    401s the preflight and breaks every cross-origin browser/WebView client.
    Pure so it can be unit-tested without standing up the app."""
    return method == "OPTIONS" and "access-control-request-method" in headers


def require_admin(request: Request):
    """Raise 403 if the current user isn't an admin.
    Allows access when auth is explicitly disabled, or when the request carries
    the in-process internal-tool token used by loopback agent tools.
    """
    # In-process bypass for tool-layer loopback calls. Two paths:
    # (a) header-direct (caller set X-Odysseus-Internal-Token), or
    # (b) the auth middleware already validated the token and stamped
    #     request.state.current_user = "internal-tool".
    try:
        hdr = request.headers.get(INTERNAL_TOOL_HEADER)
        if hdr and secrets.compare_digest(hdr, INTERNAL_TOOL_TOKEN):
            return
        if getattr(request.state, "current_user", None) == INTERNAL_TOOL_USER:
            return
    except Exception:
        pass

    auth_mgr = getattr(request.app.state, "auth_manager", None)
    if os.getenv("AUTH_ENABLED", "true").lower() == "false":
        return
    if not auth_mgr or not auth_mgr.is_configured:
        raise HTTPException(403, "Admin only")
    user = getattr(request.state, "current_user", None)
    if not user or not auth_mgr.is_admin(user):
        raise HTTPException(403, "Admin only")


class SecurityHeadersMiddleware:
    """Add standard security headers to all responses.

    Pure ASGI middleware (not BaseHTTPMiddleware) so it never buffers or
    re-wraps the response body. BaseHTTPMiddleware reads the entire downstream
    response into memory and re-emits it as a new ASGI message sequence; when
    GZipMiddleware is anywhere in the stack, this re-wrapping can desync the
    Content-Length the client receives from the body actually streamed,
    producing a 200 OK with the correct (compressed) Content-Length but a
    truncated or empty body -- regardless of which order the two middlewares
    are added in. Operating at the ASGI message level avoids this entirely:
    headers are injected into the single `http.response.start` message before
    any body bytes flow, so GZipMiddleware (whichever layer it's in) always
    sees and compresses the real, complete body.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "") or ""
        nonce = secrets.token_hex(16)

        # Stash the nonce somewhere route handlers can still read it the way
        # they used to via request.state.csp_nonce. ASGI scope["state"] is the
        # equivalent extension point Starlette/FastAPI request.state reads from.
        scope.setdefault("state", {})["csp_nonce"] = nonce

        is_tool_render = path.startswith("/api/tools/") and path.endswith("/render")
        is_document_pdf_preview = path.startswith("/api/document/") and path.endswith("/render-pdf")
        is_report = path.startswith("/api/research/report/")

        # Scheme/forwarded-proto check needs the request headers, which are
        # available directly off the ASGI scope without needing a Request object.
        raw_headers = scope.get("headers") or []
        header_map = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in raw_headers}
        is_https = (
            scope.get("scheme") == "https"
            or header_map.get("x-forwarded-proto") == "https"
        )

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))

                def set_header(name: str, value: str):
                    name_bytes = name.encode("latin-1")
                    # Remove any existing header with the same name (case-insensitive)
                    # so we don't emit duplicates if something upstream already set it.
                    nonlocal headers
                    name_lower = name.lower()
                    headers = [
                        (k, v) for k, v in headers
                        if k.decode("latin-1").lower() != name_lower
                    ]
                    headers.append((name_bytes, value.encode("latin-1")))

                set_header("X-Content-Type-Options", "nosniff")
                set_header("Referrer-Policy", "no-referrer")
                set_header("Permissions-Policy", "camera=(), microphone=(self), geolocation=()")

                if is_https:
                    set_header("Strict-Transport-Security", "max-age=31536000; includeSubDomains")

                if is_report:
                    set_header(
                        "Content-Security-Policy",
                        "default-src 'self'; "
                        "script-src 'self' 'unsafe-inline'; "
                        "style-src 'self' 'unsafe-inline'; "
                        "font-src 'self'; "
                        "img-src 'self' data: blob: https:; "
                        "connect-src 'self'; "
                        "frame-ancestors 'none'"
                    )
                elif is_tool_render:
                    # Skip framing headers for tools.
                    pass
                elif is_document_pdf_preview:
                    set_header("X-Frame-Options", "SAMEORIGIN")
                    set_header(
                        "Content-Security-Policy",
                        "default-src 'none'; "
                        "frame-ancestors 'self'"
                    )
                else:
                    set_header("X-Frame-Options", "DENY")
                    # NOTE: `style-src 'unsafe-inline'` is intentionally retained.
                    # `static/index.html` and `static/login.html` ship inline <style>
                    # blocks, and several JS modules build runtime `style=""` attrs.
                    # Migrating to nonce-only requires templating the HTML files +
                    # auditing every JS-set style attribute. Since inline styles
                    # don't execute script, the residual risk is visual-only.
                    set_header(
                        "Content-Security-Policy",
                        "default-src 'self'; "
                        f"script-src 'self' 'nonce-{nonce}' https://cdn.jsdelivr.net; "
                        "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
                        "font-src 'self' https://cdn.jsdelivr.net; "
                        "img-src 'self' data: blob:; "
                        "media-src 'self' blob:; "
                        "connect-src 'self'; "
                        "frame-src 'self'; "
                        "frame-ancestors 'none'"
                    )

                message["headers"] = headers

            await send(message)

        await self.app(scope, receive, send_wrapper)
