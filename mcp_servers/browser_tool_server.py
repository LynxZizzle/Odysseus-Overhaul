#!/usr/bin/env python3
# browser_tool_server.py - Final version with controlled browser opening
import asyncio
import json
import sys
import urllib.request
import urllib.error
import logging
from collections import deque
from datetime import datetime

logging.basicConfig(level=logging.WARNING)

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

app = Server("browser-tool")
ELECTRON_API = "http://127.0.0.1:7002"

# =========================
# Persistent Browser Memory
# =========================
BrowserMemory = {
    "CurrentUrl": None,
    "CurrentTitle": None,
    "CurrentContent": "",
    "NavigationHistory": deque(maxlen=100),
    "KnownPages": {},
    "MediaCache": {},
    "LastScreenshot": None,
    "LastUpdated": None
}

def UpdateMemory(Url, Title="", Content=""):
    BrowserMemory["CurrentUrl"] = Url
    BrowserMemory["CurrentTitle"] = Title
    BrowserMemory["CurrentContent"] = Content[:50000]
    BrowserMemory["LastUpdated"] = datetime.utcnow().isoformat()

    BrowserMemory["NavigationHistory"].append({
        "url": Url,
        "title": Title,
        "time": BrowserMemory["LastUpdated"]
    })
    BrowserMemory["KnownPages"][Url] = {
        "title": Title,
        "content": Content[:50000],
        "updated": BrowserMemory["LastUpdated"]
    }

def _call(Endpoint, Body):
    Data = json.dumps(Body).encode()
    Req = urllib.request.Request(
        ELECTRON_API + Endpoint,
        data=Data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(Req, timeout=45) as Resp:
            return json.loads(Resp.read().decode())
    except Exception as e:
        return {"ok": False, "error": str(e)}

@app.list_tools()
async def list_tools():
    return [
        Tool(
            name="browse_page",
            description="Navigate using headless session (recommended for scraping).",
            inputSchema={
                "type": "object",
                "properties": {
                    "url": {"type": "string"},
                    "capture_as": {"type": "string", "enum": ["text", "markdown", "links", "html"], "default": "text"},
                    "wait_ms": {"type": "integer", "default": 800}
                },
                "required": ["url"]
            },
        ),
        Tool(
            name="browse_open",
            description="Open visible browser window (only when needed for interaction).",
            inputSchema={
                "type": "object",
                "properties": {"url": {"type": "string"}}
            },
        ),
        Tool(
            name="browse_screenshot",
            description="Take screenshot.",
            inputSchema={
                "type": "object",
                "properties": {"url": {"type": "string"}}
            },
        ),
        Tool(
            name="browse_click",
            description="Click element (requires visible window).",
            inputSchema={
                "type": "object",
                "properties": {
                    "selector": {"type": "string"},
                    "url": {"type": "string"}
                },
                "required": ["selector"]
            },
        ),
        Tool(
            name="browse_fill",
            description="Fill form (requires visible window).",
            inputSchema={
                "type": "object",
                "properties": {
                    "selector": {"type": "string"},
                    "value": {"type": "string"},
                    "submit": {"type": "boolean", "default": False}
                },
                "required": ["selector", "value"]
            },
        ),
        Tool(
            name="browse_evaluate",
            description="Run JavaScript (works with visible window).",
            inputSchema={
                "type": "object",
                "properties": {
                    "expression": {"type": "string"},
                    "url": {"type": "string"}
                },
                "required": ["expression"]
            },
        ),
        Tool(
            name="browse_get_state",
            description="Get current browser state.",
            inputSchema={"type": "object", "properties": {}},
        ),
        Tool(
            name="browse_status",
            description="Full memory status.",
            inputSchema={"type": "object", "properties": {}},
        ),
        Tool(
            name="browse_extract_media",
            description="Extract media from current page.",
            inputSchema={
                "type": "object",
                "properties": {"url": {"type": "string"}}
            },
        ),
        Tool(
            name="browse_search_memory",
            description="Search memory.",
            inputSchema={
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"]
            },
        ),
        Tool(
            name="browse_clear_memory",
            description="Clear memory.",
            inputSchema={"type": "object", "properties": {}},
        ),
    ]

@app.call_tool()
async def call_tool(Name, Arguments):
    try:
        if Name == "browse_page":
            Url = Arguments.get("url", "").strip()
            Result = await asyncio.to_thread(_call, "/scrape", {
                "url": Url,
                "capture_as": Arguments.get("capture_as", "text"),
                "wait_ms": Arguments.get("wait_ms", 800)
            })
            if not Result.get("ok"):
                return [TextContent(type="text", text=f"Error: {Result.get('error')}")]

            Content = Result.get("content", "")
            PageUrl = Result.get("url", Url)
            PageTitle = Result.get("title", "")
            UpdateMemory(PageUrl, PageTitle, str(Content))
            return [TextContent(type="text", text=f"URL: {PageUrl}\nTitle: {PageTitle}\n\n{str(Content)[:20000]}")]

        elif Name == "browse_open":
            Url = Arguments.get("url", "").strip()
            Result = await asyncio.to_thread(_call, "/open", {"url": Url} if Url else {})
            if not Result.get("ok"):
                return [TextContent(type="text", text=f"Error opening browser: {Result.get('error', 'Unknown error — is Odysseus running with the browser tool HTTP server on port 7002?')}")]
            if Url:
                UpdateMemory(Url, "Visible Browser Opened", "")
            return [TextContent(type="text", text=f"Visible browser opened" + (f" at {Url}" if Url else "") + ".")]

        elif Name == "browse_screenshot":
            Url = Arguments.get("url") or BrowserMemory["CurrentUrl"]
            Result = await asyncio.to_thread(_call, "/screenshot", {"url": Url} if Url else {})
            if Result.get("ok") and Result.get("image"):
                BrowserMemory["LastScreenshot"] = Result["image"][:500]
                return [TextContent(type="text", text=f"Screenshot captured for {Url}")]
            return [TextContent(type="text", text=f"Screenshot failed: {Result.get('error', 'Unknown error')}")]

        elif Name == "browse_extract_media":
            Url = Arguments.get("url") or BrowserMemory["CurrentUrl"]
            if not Url:
                return [TextContent(type="text", text="No URL available")]
            return await _extract_media(Url)

        elif Name == "browse_click":
            Selector = Arguments.get("selector", "").strip()
            Url = Arguments.get("url", "").strip()
            if not Selector:
                return [TextContent(type="text", text="Error: selector is required")]
            Body = {"selector": Selector}
            if Url:
                Body["url"] = Url
            Result = await asyncio.to_thread(_call, "/click", Body)
            if not Result.get("ok"):
                return [TextContent(type="text", text=f"Error clicking '{Selector}': {Result.get('error', 'Unknown error')}")]
            if Result.get("url"):
                UpdateMemory(Result["url"], BrowserMemory.get("CurrentTitle", ""), BrowserMemory.get("CurrentContent", ""))
            return [TextContent(type="text", text=f"Clicked '{Selector}' ({Result.get('tag', '')}).")]

        elif Name == "browse_fill":
            Selector = Arguments.get("selector", "").strip()
            Value = Arguments.get("value", "")
            Submit = bool(Arguments.get("submit", False))
            Url = Arguments.get("url", "").strip()
            if not Selector:
                return [TextContent(type="text", text="Error: selector is required")]
            Body = {"selector": Selector, "value": Value, "submit": Submit}
            if Url:
                Body["url"] = Url
            Result = await asyncio.to_thread(_call, "/fill", Body)
            if not Result.get("ok"):
                return [TextContent(type="text", text=f"Error filling '{Selector}': {Result.get('error', 'Unknown error')}")]
            return [TextContent(type="text", text=f"Filled '{Selector}'" + (" and submitted." if Submit else "."))]

        elif Name == "browse_evaluate":
            Expression = Arguments.get("expression", "").strip()
            Url = Arguments.get("url", "").strip()
            if not Expression:
                return [TextContent(type="text", text="Error: expression is required")]
            Body = {"expression": Expression}
            if Url:
                Body["url"] = Url
            Result = await asyncio.to_thread(_call, "/evaluate", Body)
            if not Result.get("ok"):
                return [TextContent(type="text", text=f"Error evaluating expression: {Result.get('error', 'Unknown error')}")]
            return [TextContent(type="text", text=f"Result: {json.dumps(Result.get('result', ''), ensure_ascii=False)[:5000]}")]

        elif Name == "browse_search_memory":
            Query = Arguments.get("query", "").strip().lower()
            if not Query:
                return [TextContent(type="text", text="Error: query is required")]
            Matches = []
            for PageUrl, Page in BrowserMemory["KnownPages"].items():
                Title = Page.get("title", "") or ""
                Content = Page.get("content", "") or ""
                if Query in Title.lower() or Query in Content.lower() or Query in PageUrl.lower():
                    Snippet = Content[:300]
                    Matches.append(f"{PageUrl}\nTitle: {Title}\n{Snippet}\n")
            if not Matches:
                return [TextContent(type="text", text=f"No pages in memory match '{Query}'.")]
            return [TextContent(type="text", text=f"Found {len(Matches)} matching page(s):\n\n" + "\n---\n".join(Matches[:10]))]

        elif Name == "browse_get_state":
            return [TextContent(type="text", text=json.dumps({
                "current_url": BrowserMemory["CurrentUrl"],
                "current_title": BrowserMemory["CurrentTitle"],
                "known_pages": len(BrowserMemory["KnownPages"])
            }, indent=2))]

        elif Name == "browse_status":
            return [TextContent(type="text", text=json.dumps(BrowserMemory, indent=2, default=str))]

        elif Name == "browse_clear_memory":
            BrowserMemory["KnownPages"].clear()
            BrowserMemory["MediaCache"].clear()
            BrowserMemory["NavigationHistory"].clear()
            return [TextContent(type="text", text="Memory cleared.")]

        else:
            return [TextContent(type="text", text=f"Unknown tool: {Name}")]

    except Exception as e:
        import traceback
        return [TextContent(type="text", text=f"Error in {Name}: {str(e)}")]

async def _extract_media(Url):
    Result = await asyncio.to_thread(_call, "/scrape", {
        "url": Url,
        "capture_as": "html",
        "wait_ms": 2000
    })

    if not Result or not Result.get("ok"):
        return [TextContent(type="text", text=f"Scrape failed: {Result.get('error') if Result else 'No response from Electron'}")]

    Html = Result.get("content", "")

    import re
    found = set()

    # All media file types including gif/apng/webp/images
    VIDEO_EXTS = r'mp4|webm|mov|m4v|mkv|ogg'
    IMAGE_EXTS = r'gif|apng|webp|png|jpg|jpeg|avif'
    ALL_EXTS   = VIDEO_EXTS + '|' + IMAGE_EXTS

    # General URL scan for any media file extension
    matches = re.findall(
        rf'https?://[^\s"\'<>\\]+\.(?:{ALL_EXTS})(?:\?[^\s"\'<>\\]*)?',
        Html, re.IGNORECASE
    )
    found.update(matches)

    # Rule34 JS object: image = {..., 'img':'filename.gif', 'domain':'https://...', 'dir':1234, ...}
    # Reconstruct the full URL from the JS image object
    domain_match = re.search(r"'domain'\s*:\s*'([^']+)'", Html)
    dir_match    = re.search(r"'dir'\s*:\s*(\d+)", Html)
    img_match    = re.search(r"'img'\s*:\s*'([^']+)'", Html)
    base_dir     = re.search(r"'base_dir'\s*:\s*'([^']+)'", Html)

    if domain_match and dir_match and img_match:
        domain   = domain_match.group(1).rstrip('/')
        dir_id   = dir_match.group(1)
        img_name = img_match.group(1)
        base     = base_dir.group(1) if base_dir else 'images'
        constructed = f"{domain}/{base}/{dir_id}/{img_name}"
        found.add(constructed)

    # data-file_url attributes
    data_attrs = re.findall(r'data-file_url=["\']([^"\']+)["\']', Html)
    found.update(data_attrs)

    # <video>/<source> src attributes
    video_srcs = re.findall(r'<(?:video|source)[^>]+src=["\']([^"\']+)["\']', Html, re.IGNORECASE)
    found.update(video_srcs)

    # <img> src — only wimg/cdn URLs to avoid icons/ads
    img_srcs = re.findall(r'<img[^>]+src=["\']([^"\']+)["\']', Html, re.IGNORECASE)
    found.update(u for u in img_srcs if 'wimg.' in u or '/images/' in u)

    # Iframe embeds
    iframe_srcs = re.findall(r'<iframe[^>]+src=["\']([^"\']+)["\']', Html, re.IGNORECASE)
    found.update(iframe_srcs)

    # Filter out thumbnails — prefer full images over thumbnail_ versions
    full = {u for u in found if 'thumbnail_' not in u}
    MediaList = sorted(full if full else found)

    BrowserMemory["MediaCache"][Url] = MediaList
    UpdateMemory(Url, "Media Extracted", str(MediaList))

    return [TextContent(
        type="text",
        text=f"Found {len(MediaList)} media items from {Url}:\n{json.dumps(MediaList, indent=2)}"
    )]

async def main():
    async with stdio_server() as (ReadStream, WriteStream):
        await app.run(ReadStream, WriteStream, app.create_initialization_options())

if __name__ == "__main__":
    asyncio.run(main())