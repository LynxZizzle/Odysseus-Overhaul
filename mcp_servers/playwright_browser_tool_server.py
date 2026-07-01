#!/usr/bin/env python3
# browser_tool_server.py - Playwright-backed version (no Electron dependency)
#
# Requires: pip install playwright && playwright install chromium
import asyncio
import base64
import json
import logging
import os
import re
import sys
from collections import deque
from datetime import datetime

logging.basicConfig(level=logging.WARNING)

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

try:
    from playwright.async_api import async_playwright
except ImportError:
    print(
        "Playwright is not installed. Run:\n"
        "  pip install playwright\n"
        "  playwright install chromium",
        file=sys.stderr,
    )
    raise

app = Server("browser-tool")

SCREENSHOT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "screenshots")

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

# =========================
# Related-tool hints
# =========================
# Appended to results so the model knows what else is available without
# having to re-read the whole tool list every turn.
TOOL_HINTS = {
    "browse_page": "Tip: browse_extract_media pulls images/video URLs from this page, browse_screenshot captures it visually, and browse_search_memory can search everything visited so far.",
    "browse_open": "Tip: once opened, browse_click / browse_fill / browse_evaluate act on this visible window; browse_screenshot works on it too.",
    "browse_screenshot": "Tip: browse_page (capture_as=text/markdown/html) gets the page content as text if you need to read it rather than see it.",
    "browse_click": "Tip: browse_get_state shows the current URL/title after navigation, and browse_screenshot can confirm the click visually.",
    "browse_fill": "Tip: follow up with browse_click if submission needs a separate button, or browse_evaluate to read back form state.",
    "browse_evaluate": "Tip: browse_page can re-scrape the page as text/markdown afterwards if the JS changed the DOM.",
    "browse_extract_media": "Tip: browse_search_memory can find this page again later by keyword without re-scraping.",
    "browse_get_state": "Tip: browse_status returns full memory (history, known pages, media cache) if you need more than the current page.",
}


def _WithHint(Text, Name):
    Hint = TOOL_HINTS.get(Name)
    if Hint:
        return f"{Text}\n\n{Hint}"
    return Text


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


# =========================
# Playwright session state
# =========================
_Playwright = None
_HeadlessBrowser = None
_HeadlessPage = None
_VisibleBrowser = None
_VisiblePage = None
_StateLock = asyncio.Lock()


async def _EnsurePlaywright():
    global _Playwright
    if _Playwright is None:
        _Playwright = await async_playwright().start()
    return _Playwright


async def _GetHeadlessPage():
    global _HeadlessBrowser, _HeadlessPage
    async with _StateLock:
        Playwright = await _EnsurePlaywright()
        if _HeadlessBrowser is None:
            _HeadlessBrowser = await Playwright.chromium.launch(headless=True)
        if _HeadlessPage is None or _HeadlessPage.is_closed():
            _HeadlessPage = await _HeadlessBrowser.new_page()
        return _HeadlessPage


async def _GetVisiblePage():
    global _VisibleBrowser, _VisiblePage
    async with _StateLock:
        Playwright = await _EnsurePlaywright()
        if _VisibleBrowser is None:
            _VisibleBrowser = await Playwright.chromium.launch(headless=False)
        if _VisiblePage is None or _VisiblePage.is_closed():
            _VisiblePage = await _VisibleBrowser.new_page()
        return _VisiblePage


def _ActivePageForInteraction():
    # click/fill/evaluate prefer whichever visible page is already open,
    # falling back to the headless one so evaluate still works pre-open.
    return _VisiblePage if (_VisiblePage is not None and not _VisiblePage.is_closed()) else _HeadlessPage


# =========================
# Content extraction helpers
# =========================
def _HtmlToText(Html):
    NoScripts = re.sub(r'<(script|style)[^>]*>.*?</\1>', ' ', Html, flags=re.DOTALL | re.IGNORECASE)
    NoTags = re.sub(r'<[^>]+>', ' ', NoScripts)
    Collapsed = re.sub(r'\s+', ' ', NoTags)
    return Collapsed.strip()


def _HtmlToMarkdown(Html):
    Working = re.sub(r'<(script|style)[^>]*>.*?</\1>', ' ', Html, flags=re.DOTALL | re.IGNORECASE)
    for Level in range(1, 7):
        Working = re.sub(
            rf'<h{Level}[^>]*>(.*?)</h{Level}>',
            lambda Match, L=Level: f"\n{'#' * L} {_HtmlToText(Match.group(1))}\n",
            Working, flags=re.DOTALL | re.IGNORECASE
        )
    Working = re.sub(
        r'<a[^>]+href=["\']([^"\']+)["\'][^>]*>(.*?)</a>',
        lambda Match: f"[{_HtmlToText(Match.group(2))}]({Match.group(1)})",
        Working, flags=re.DOTALL | re.IGNORECASE
    )
    Working = re.sub(r'<li[^>]*>(.*?)</li>', lambda Match: f"\n- {_HtmlToText(Match.group(1))}", Working, flags=re.DOTALL | re.IGNORECASE)
    Working = re.sub(r'<(p|br|div|tr)[^>]*>', '\n', Working, flags=re.IGNORECASE)
    Working = re.sub(r'<[^>]+>', '', Working)
    Working = re.sub(r'\n\s*\n+', '\n\n', Working)
    return Working.strip()


async def _CaptureContent(Page, CaptureAs):
    if CaptureAs == "html":
        return await Page.content()
    if CaptureAs == "links":
        Links = await Page.eval_on_selector_all(
            "a[href]",
            "els => els.map(el => ({text: el.innerText.trim(), href: el.href}))"
        )
        return json.dumps(Links, ensure_ascii=False)
    if CaptureAs == "markdown":
        Html = await Page.content()
        return _HtmlToMarkdown(Html)
    Html = await Page.content()
    return _HtmlToText(Html)


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
            CaptureAs = Arguments.get("capture_as", "text")
            WaitMs = Arguments.get("wait_ms", 800)
            if not Url:
                return [TextContent(type="text", text="Error: url is required")]

            Page = await _GetHeadlessPage()
            try:
                await Page.goto(Url, wait_until="domcontentloaded", timeout=45000)
                await Page.wait_for_timeout(WaitMs)
                Content = await _CaptureContent(Page, CaptureAs)
                Title = await Page.title()
                PageUrl = Page.url
            except Exception as PageError:
                return [TextContent(type="text", text=f"Error: {str(PageError)}")]

            UpdateMemory(PageUrl, Title, str(Content))
            Text = f"URL: {PageUrl}\nTitle: {Title}\n\n{str(Content)[:20000]}"
            return [TextContent(type="text", text=_WithHint(Text, Name))]

        elif Name == "browse_open":
            Url = Arguments.get("url", "").strip()
            try:
                Page = await _GetVisiblePage()
                if Url:
                    await Page.goto(Url, wait_until="domcontentloaded", timeout=45000)
                    UpdateMemory(Page.url, await Page.title(), "")
            except Exception as OpenError:
                return [TextContent(type="text", text=f"Error opening browser: {str(OpenError)}")]

            Text = "Visible browser opened" + (f" at {Url}" if Url else "") + "."
            return [TextContent(type="text", text=_WithHint(Text, Name))]

        elif Name == "browse_screenshot":
            Url = Arguments.get("url") or BrowserMemory["CurrentUrl"]
            Page = _ActivePageForInteraction() or await _GetHeadlessPage()
            try:
                if Url and Page.url != Url:
                    await Page.goto(Url, wait_until="domcontentloaded", timeout=45000)
                os.makedirs(SCREENSHOT_DIR, exist_ok=True)
                Filename = f"screenshot_{datetime.utcnow().strftime('%Y%m%d_%H%M%S_%f')}.png"
                Filepath = os.path.join(SCREENSHOT_DIR, Filename)
                await Page.screenshot(path=Filepath, full_page=True)
                with open(Filepath, "rb") as ImageFile:
                    ImageBytes = ImageFile.read()
                BrowserMemory["LastScreenshot"] = base64.b64encode(ImageBytes)[:500].decode()
            except Exception as ShotError:
                return [TextContent(type="text", text=f"Screenshot failed: {str(ShotError)}")]

            Text = f"Screenshot captured for {Page.url}\nSaved to: {Filepath}"
            return [TextContent(type="text", text=_WithHint(Text, Name))]

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

            Page = _ActivePageForInteraction() or await _GetVisiblePage()
            try:
                if Url:
                    await Page.goto(Url, wait_until="domcontentloaded", timeout=45000)
                Tag = await Page.eval_on_selector(Selector, "el => el.tagName.toLowerCase()")
                await Page.click(Selector, timeout=10000)
                await Page.wait_for_timeout(500)
            except Exception as ClickError:
                return [TextContent(type="text", text=f"Error clicking '{Selector}': {str(ClickError)}")]

            UpdateMemory(Page.url, BrowserMemory.get("CurrentTitle", ""), BrowserMemory.get("CurrentContent", ""))
            Text = f"Clicked '{Selector}' ({Tag})."
            return [TextContent(type="text", text=_WithHint(Text, Name))]

        elif Name == "browse_fill":
            Selector = Arguments.get("selector", "").strip()
            Value = Arguments.get("value", "")
            Submit = bool(Arguments.get("submit", False))
            Url = Arguments.get("url", "").strip()
            if not Selector:
                return [TextContent(type="text", text="Error: selector is required")]

            Page = _ActivePageForInteraction() or await _GetVisiblePage()
            try:
                if Url:
                    await Page.goto(Url, wait_until="domcontentloaded", timeout=45000)
                await Page.fill(Selector, Value, timeout=10000)
                if Submit == True:
                    await Page.press(Selector, "Enter")
            except Exception as FillError:
                return [TextContent(type="text", text=f"Error filling '{Selector}': {str(FillError)}")]

            Text = f"Filled '{Selector}'" + (" and submitted." if Submit == True else ".")
            return [TextContent(type="text", text=_WithHint(Text, Name))]

        elif Name == "browse_evaluate":
            Expression = Arguments.get("expression", "").strip()
            Url = Arguments.get("url", "").strip()
            if not Expression:
                return [TextContent(type="text", text="Error: expression is required")]

            Page = _ActivePageForInteraction() or await _GetHeadlessPage()
            try:
                if Url:
                    await Page.goto(Url, wait_until="domcontentloaded", timeout=45000)
                Result = await Page.evaluate(Expression)
            except Exception as EvalError:
                return [TextContent(type="text", text=f"Error evaluating expression: {str(EvalError)}")]

            Text = f"Result: {json.dumps(Result, ensure_ascii=False, default=str)[:5000]}"
            return [TextContent(type="text", text=_WithHint(Text, Name))]

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
            Text = json.dumps({
                "current_url": BrowserMemory["CurrentUrl"],
                "current_title": BrowserMemory["CurrentTitle"],
                "known_pages": len(BrowserMemory["KnownPages"])
            }, indent=2)
            return [TextContent(type="text", text=_WithHint(Text, Name))]

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
        return [TextContent(type="text", text=f"Error in {Name}: {str(e)}")]


async def _extract_media(Url):
    Page = await _GetHeadlessPage()
    try:
        if Page.url != Url:
            await Page.goto(Url, wait_until="domcontentloaded", timeout=45000)
        await Page.wait_for_timeout(2000)
        Html = await Page.content()
    except Exception as ScrapeError:
        return [TextContent(type="text", text=f"Scrape failed: {str(ScrapeError)}")]

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

    Text = f"Found {len(MediaList)} media items from {Url}:\n{json.dumps(MediaList, indent=2)}"
    return [TextContent(type="text", text=_WithHint(Text, "browse_extract_media"))]


async def _Shutdown():
    global _Playwright, _HeadlessBrowser, _VisibleBrowser
    try:
        if _HeadlessBrowser is not None:
            await _HeadlessBrowser.close()
    except Exception:
        pass
    try:
        if _VisibleBrowser is not None:
            await _VisibleBrowser.close()
    except Exception:
        pass
    try:
        if _Playwright is not None:
            await _Playwright.stop()
    except Exception:
        pass


async def main():
    try:
        async with stdio_server() as (ReadStream, WriteStream):
            await app.run(ReadStream, WriteStream, app.create_initialization_options())
    finally:
        await _Shutdown()


if __name__ == "__main__":
    asyncio.run(main())