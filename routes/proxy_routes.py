# routes/proxy_routes.py
# Universal media proxy -- fetches any external image/gif/video server-side.
# Bypasses hotlink protection (403s) by spoofing Referer to match the origin host.
# Supports Range requests for video seeking. Streams chunks for fast playback start.

import logging
import urllib.parse

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

_Logger = logging.getLogger(__name__)

_Router = APIRouter()

_BlockedHosts = {"localhost", "127.0.0.1", "0.0.0.0", "::1"}

_Timeout = httpx.Timeout(60.0)


def _BuildSpoofedReferer(ParsedUrl) -> str:
    return f"{ParsedUrl.scheme}://{ParsedUrl.netloc}/"


@_Router.get("/api/proxy/media")
async def ProxyMedia(Request: Request, url: str):
    ParsedUrl = urllib.parse.urlparse(url)
    Host = ParsedUrl.hostname or ""

    if ParsedUrl.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="Only http/https URLs are supported")

    if (
        Host in _BlockedHosts
        or Host.startswith("192.168.")
        or Host.startswith("10.")
        or Host.startswith("172.")
    ):
        raise HTTPException(status_code=403, detail="Private/loopback hosts are not allowed")

    FetchHeaders = {
        "Referer": _BuildSpoofedReferer(ParsedUrl),
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/125.0.0.0 Safari/537.36"
        ),
        "Accept": "*/*",
        "Accept-Encoding": "identity",
    }

    # Forward Range header so browser can seek video without re-downloading
    RangeHeader = Request.headers.get("range")
    if RangeHeader:
        FetchHeaders["Range"] = RangeHeader

    try:
        Client = httpx.AsyncClient(timeout=_Timeout, follow_redirects=True)
        Response = await Client.send(
            Client.build_request("GET", url, headers=FetchHeaders),
            stream=True,
        )

        if Response.status_code >= 400:
            await Response.aclose()
            await Client.aclose()
            raise HTTPException(
                status_code=502,
                detail=f"Upstream returned {Response.status_code} for {url}",
            )

        ContentType = Response.headers.get("content-type", "application/octet-stream")

        OutHeaders = {
            # Cache for 7 days -- videos don't change, eliminates re-fetch on repeat views.
            "Cache-Control": "public, max-age=604800, immutable",
            "Accept-Ranges": "bytes",
        }

        # Forward Content-Length so browser can show progress bar and seek accurately
        if "content-length" in Response.headers:
            OutHeaders["Content-Length"] = Response.headers["content-length"]

        # Pass through Content-Range for partial responses (seeking)
        if "content-range" in Response.headers:
            OutHeaders["Content-Range"] = Response.headers["content-range"]

        OutStatus = 206 if Response.status_code == 206 else 200

        async def _Stream():
            try:
                # 64 KB chunks: small enough to start playback fast,
                # large enough to keep throughput high.
                async for Chunk in Response.aiter_bytes(chunk_size=65536):
                    yield Chunk
            finally:
                await Response.aclose()
                await Client.aclose()

        return StreamingResponse(
            _Stream(),
            status_code=OutStatus,
            media_type=ContentType,
            headers=OutHeaders,
        )

    except httpx.RequestError as Exception:
        _Logger.warning(f"[proxy_routes] fetch failed for {url}: {Exception}")
        raise HTTPException(status_code=502, detail=f"Proxy fetch failed: {Exception}")


def setup_proxy_routes() -> APIRouter:
    return _Router