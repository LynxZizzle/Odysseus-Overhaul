const { app, BrowserWindow, session, shell, dialog } = require('electron');
const { spawn } = require('child_process');
const Path = require('path');
const FileSystem = require('fs');
const Http = require('http');

const OdysseusDirectory = Path.dirname(process.execPath);
const ApplicationPort = parseInt(process.env.APP_PORT || process.env.ODYSSEUS_PORT || '7000', 10);
const TargetUrl = process.env.ODYSSEUS_ELECTRON_URL || `http://127.0.0.1:${ApplicationPort}`;
const PollIntervalMilliseconds = 1000;
const ReadyTimeoutMilliseconds = 60000;

const BrowserToolPort = 7002;
const BrowserPartition = 'persist:odysseus-browser-tool';

// The nav bar preload is written to a temp file on startup so we don't need
// an extra file bundled with the app.
const NavPreloadPath = Path.join(app.getPath('temp'), 'ody-nav-preload.js');

let MainWindow = null;
let SplashWindow = null;
let BrowserToolWindow = null;
let BrowserToolServer = null;
let ServerProcess = null;
let IsQuitting = false;
let ElapsedSeconds = 0;


// ── Nav bar preload script ────────────────────────────────────────────────────
//
// Written to a temp file and used as the `preload` for the browser tool window.
// Runs in the renderer BEFORE any page JS, so the nav bar is always present
// immediately — no flicker, no injection delay, no double-bar on any page.
//
// It injects a fixed <div> nav bar into document.documentElement as the very
// first thing, then wires it up once DOMContentLoaded fires.

const NAV_PRELOAD_SOURCE = `
'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
const NAV_H = 44; // px — must match CSS below

// ── Inject nav bar CSS + HTML immediately (before page paints) ────────────────
const Style = document.createElement('style');
Style.textContent = \`
  html { padding-top: \${NAV_H}px !important; }
  #_ody-nav {
    position: fixed; top: 0; left: 0; right: 0; height: \${NAV_H}px;
    z-index: 2147483647;
    display: flex; align-items: center; padding: 0 8px; gap: 6px;
    background: #0d1117; border-bottom: 1px solid #21262d;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    box-sizing: border-box;
    /* block pointer events on the bar background so only buttons/input work */
    -webkit-app-region: drag;
  }
  #_ody-nav * { box-sizing: border-box; -webkit-app-region: no-drag; }
  #_ody-nav button {
    background: none; border: none; color: #6e7681; cursor: pointer;
    padding: 5px 7px; border-radius: 5px; font-size: 15px; line-height: 1;
    flex-shrink: 0; display: flex; align-items: center; justify-content: center;
    transition: color .12s, background .12s;
  }
  #_ody-nav button:hover:not(:disabled) { color: #c9d1d9; background: #21262d; }
  #_ody-nav button:disabled { opacity: .3; cursor: default; }
  #_ody-url-wrap {
    flex: 1; display: flex; align-items: center;
    background: #161b22; border: 1px solid #30363d; border-radius: 7px;
    padding: 0 10px; gap: 6px; min-width: 0;
    transition: border-color .15s;
  }
  #_ody-url-wrap:focus-within { border-color: #58a6ff; }
  #_ody-lock { font-size: 11px; flex-shrink: 0; opacity: .7; }
  #_ody-url {
    flex: 1; background: none; border: none; color: #c9d1d9;
    font-size: 12px; outline: none; min-width: 0; padding: 7px 0;
    font-family: inherit;
  }
  #_ody-go {
    background: none; border: none; color: #58a6ff; cursor: pointer;
    font-size: 13px; padding: 2px 4px; border-radius: 3px; flex-shrink: 0;
  }
  #_ody-go:hover { background: #388bfd22; }
\`;
// Insert into <head> if it exists, else <html>
(document.head || document.documentElement).prepend(Style);

// Build the nav bar node
const Nav = document.createElement('div');
Nav.id = '_ody-nav';
Nav.innerHTML = \`
  <button id="_ody-back"   title="Back (Alt+Left)"    disabled>&#8592;</button>
  <button id="_ody-fwd"    title="Forward (Alt+Right)" disabled>&#8594;</button>
  <button id="_ody-reload" title="Reload (F5)">&#8635;</button>
  <div id="_ody-url-wrap">
    <span id="_ody-lock">&#128274;</span>
    <input id="_ody-url" type="text" placeholder="Search or enter URL..."
           autocomplete="off" spellcheck="false" />
    <button id="_ody-go">&#10148;</button>
  </div>
  <button id="_ody-home" title="Home">&#8962;</button>
\`;
// Prepend before body content — document.body may not exist yet so use
// documentElement and let the browser sort layout
document.documentElement.prepend(Nav);

// ── Wire up once DOM is ready ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function WireNav() {
  const BtnBack   = document.getElementById('_ody-back');
  const BtnFwd    = document.getElementById('_ody-fwd');
  const BtnReload = document.getElementById('_ody-reload');
  const BtnGo     = document.getElementById('_ody-go');
  const BtnHome   = document.getElementById('_ody-home');
  const UrlInput  = document.getElementById('_ody-url');
  const LockEl    = document.getElementById('_ody-lock');

  if (!UrlInput) return; // guard — shouldn't happen

  // ── URL normalisation ───────────────────────────────────
  function Normalise(Raw) {
    Raw = (Raw || '').trim();
    if (!Raw) return null;
    var IsUrl = /^https?:\\/\\//.test(Raw) ||
                /^[a-zA-Z0-9-]+\\.[a-zA-Z]{2,}(\\/.*)?$/.test(Raw);
    if (!IsUrl) return 'https://duckduckgo.com/?q=' + encodeURIComponent(Raw);
    if (!/^https?:\\/\\//.test(Raw)) return 'https://' + Raw;
    return Raw;
  }

  // ── Navigate helper — also used by default-browser-page.html ───────────────
  window._odyNavGo = function(Url) {
    var Target = Normalise(Url);
    if (Target) window.location.href = Target;
  };
  window._odyNavSearch = function(Q) { window._odyNavGo(Q); };

  // ── Sync URL bar and lock icon ──────────────────────────
  function SyncBar() {
    var Href = window.location.href;
    // Don't overwrite what the user is typing
    if (document.activeElement !== UrlInput) {
      var IsHome = Href.includes('default-browser-page') || Href === 'about:blank';
      UrlInput.value = IsHome ? '' : Href;
      UrlInput.placeholder = IsHome ? 'Search or enter URL...' : 'Search or enter URL...';
    }
    // Lock icon
    if (Href.startsWith('https://')) {
      LockEl.textContent = '\\u{1F512}'; LockEl.style.color = '#3fb950';
      LockEl.title = 'Secure';
    } else if (Href.startsWith('http://')) {
      LockEl.textContent = '\\u26A0'; LockEl.style.color = '#f85149';
      LockEl.title = 'Not secure';
    } else if (Href.startsWith('file://')) {
      LockEl.textContent = '\\u{1F4C1}'; LockEl.style.color = '#8b949e';
      LockEl.title = 'Local file';
    } else {
      LockEl.textContent = '\\u{1F512}'; LockEl.style.color = '#3fb950';
      LockEl.title = '';
    }
    // Back / forward buttons
    if (BtnBack)  BtnBack.disabled  = !history.length || history.state === null;
    // We can't reliably know canGoForward from renderer — leave fwd always enabled
  }

  // Initial sync
  SyncBar();

  // Re-sync on every navigation (popstate + our own navigations)
  window.addEventListener('popstate', SyncBar);
  // MutationObserver to catch title changes (title changes = navigation happened)
  var TitleObs = new MutationObserver(SyncBar);
  var TitleEl  = document.querySelector('title');
  if (TitleEl) TitleObs.observe(TitleEl, { childList: true });

  // ── Button handlers ─────────────────────────────────────
  BtnBack.addEventListener('click',   function() { history.back(); });
  BtnFwd.addEventListener('click',    function() { history.forward(); });
  BtnReload.addEventListener('click', function() { window.location.reload(); });
  BtnHome.addEventListener('click',   function() {
    // _odyHomeUrl is set by main.js via executeJavaScript right after window creation
    window.location.href = window._odyHomeUrl || 'about:blank';
  });
  BtnGo.addEventListener('click', function() {
    var Target = Normalise(UrlInput.value);
    if (Target) window.location.href = Target;
  });

  UrlInput.addEventListener('keydown', function(E) {
    if (E.key === 'Enter') {
      var Target = Normalise(UrlInput.value);
      if (Target) window.location.href = Target;
    }
    if (E.key === 'Escape') { SyncBar(); UrlInput.blur(); }
  });
  UrlInput.addEventListener('focus', function() { UrlInput.select(); });

  // ── Keyboard shortcuts ──────────────────────────────────
  document.addEventListener('keydown', function(E) {
    if (E.key === 'F5') { window.location.reload(); E.preventDefault(); }
    if ((E.ctrlKey || E.metaKey) && E.key === 'l') {
      UrlInput.focus(); UrlInput.select(); E.preventDefault();
    }
    if (E.altKey && E.key === 'ArrowLeft')  { history.back();    E.preventDefault(); }
    if (E.altKey && E.key === 'ArrowRight') { history.forward(); E.preventDefault(); }
  });

}, { once: true });
`;

function WriteNavPreload() {
    try {
        FileSystem.writeFileSync(NavPreloadPath, NAV_PRELOAD_SOURCE, 'utf8');
    } catch (WriteErr) {
        console.error('[BrowserTool] Failed to write nav preload:', WriteErr.message);
    }
}


// ── Helpers ───────────────────────────────────────────────────────────────────

function FindIcon() {
    const Candidates = [
        Path.join(OdysseusDirectory, 'static', 'icons', 'icon.ico'),
        Path.join(OdysseusDirectory, 'static', 'icons', 'icon-192.png'),
    ];
    for (const Candidate of Candidates) {
        if (FileSystem.existsSync(Candidate)) { return Candidate; }
    }
    return null;
}

function FindPython() {
    const Candidates = [
        Path.join(OdysseusDirectory, 'venv', 'Scripts', 'pythonw.exe'),
        Path.join(OdysseusDirectory, 'venv', 'Scripts', 'python.exe'),
        Path.join(OdysseusDirectory, 'venv', 'Scripts', 'python3.exe'),
    ];
    for (const Candidate of Candidates) {
        if (FileSystem.existsSync(Candidate)) { return Candidate; }
    }
    return null;
}

function ReadRequestBody(Req) {
    return new Promise((Resolve) => {
        let Raw = '';
        Req.on('data', (Chunk) => { Raw += Chunk; });
        Req.on('end', () => { try { Resolve(JSON.parse(Raw || '{}')); } catch { Resolve({}); } });
        Req.on('error', () => { Resolve({}); });
    });
}

function SendJson(Res, StatusCode, Body) {
    Res.writeHead(StatusCode, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    });
    Res.end(JSON.stringify(Body));
}

function NormaliseUrl(Input) {
    Input = (Input || '').trim();
    if (!Input) return null;
    const IsUrl = /^https?:\/\//.test(Input) || /^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(\/.*)?$/.test(Input);
    if (!IsUrl) return 'https://duckduckgo.com/?q=' + encodeURIComponent(Input);
    if (!/^https?:\/\//.test(Input)) return 'https://' + Input;
    return Input;
}

function GetHomePageUrl() {
    const StaticPage = Path.join(OdysseusDirectory, 'static', 'default-browser-page.html');
    if (FileSystem.existsSync(StaticPage)) {
        return 'file:///' + StaticPage.replace(/\\/g, '/');
    }
    return 'https://duckduckgo.com';
}


// ── Odysseus server process ───────────────────────────────────────────────────

function StartServer() {
    const PythonPath = FindPython();
    if (PythonPath == null) {
        ServerProcess = spawn('powershell.exe',
            ['-ExecutionPolicy', 'Bypass', '-File', Path.join(OdysseusDirectory, 'launch-windows.ps1')],
            { cwd: OdysseusDirectory, windowsHide: true, detached: true, stdio: 'ignore', env: { ...process.env } });
        ServerProcess.unref();
        return;
    }
    ServerProcess = spawn(PythonPath,
        ['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', String(ApplicationPort)],
        { cwd: OdysseusDirectory, windowsHide: true, detached: true, stdio: 'ignore', env: { ...process.env }, shell: false });
    ServerProcess.unref();
}

function StopServer() {
    if (ServerProcess == null) { return; }
    ServerProcess.kill();
    ServerProcess = null;
}


// ── Splash ────────────────────────────────────────────────────────────────────

function PollUntilReady(OnReady) {
    const StartTime = Date.now();
    function Attempt() {
        let IsDone = false;
        const Req = Http.get(`${TargetUrl}/api/version`, (Res) => {
            if (IsDone) { return; } IsDone = true;
            if (Res.statusCode === 200) { OnReady(); } else { Retry(); }
        });
        Req.on('error', () => { if (IsDone) { return; } IsDone = true; Retry(); });
        Req.setTimeout(500, () => { if (IsDone) { return; } IsDone = true; Req.destroy(); Retry(); });
    }
    function Retry() {
        if (Date.now() - StartTime > ReadyTimeoutMilliseconds) {
            dialog.showErrorBox('Odysseus \u2014 Startup timeout',
                `Server did not become ready within ${ReadyTimeoutMilliseconds / 1000}s.\nCheck that the venv is set up correctly.`);
            app.quit(); return;
        }
        setTimeout(Attempt, PollIntervalMilliseconds);
    }
    Attempt();
}

function UpdateSplash(StatusText, ProgressPercent) {
    if (SplashWindow == null || SplashWindow.isDestroyed()) { return; }
    const ElapsedLabel = ElapsedSeconds > 0 ? `${ElapsedSeconds}s` : '';
    SplashWindow.webContents.executeJavaScript(`
        document.getElementById('S').textContent = ${JSON.stringify(StatusText)};
        document.getElementById('P').style.width  = '${ProgressPercent}%';
        document.getElementById('E').textContent = ${JSON.stringify(ElapsedLabel)};
    `).catch(() => {});
}

function CreateSplash() {
    const IconPath = FindIcon();
    SplashWindow = new BrowserWindow({
        width: 400, height: 260, frame: false, resizable: false, center: true,
        backgroundColor: '#0f1117', icon: IconPath || undefined,
        webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    SplashWindow.loadURL(`data:text/html;charset=utf-8,<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;
  background:%230f1117;font-family:'Fira Code','Courier New',monospace;color:%23c9d1d9;
  user-select:none;-webkit-user-select:none}
.B{display:flex;align-items:center;gap:10px;margin-bottom:22px;color:%23e6edf3}
.T{font-size:20px;font-weight:600;letter-spacing:-0.2px}
.S{font-size:12px;color:%238b949e;margin-bottom:22px;min-height:16px}
.PT{width:240px;height:2px;background:%2321262d;border-radius:1px;overflow:hidden;border:1px solid %2330363d}
.PF{height:100%25;width:0%25;background:%23388bfd;border-radius:1px;transition:width 0.8s cubic-bezier(0.4,0,0.2,1)}
.E{font-size:10px;color:%23484f58;margin-top:10px;min-height:12px;font-variant-numeric:tabular-nums}
</style></head><body>
<div class="B"><svg viewBox="0 0 32 32" width="28" height="28" fill="currentColor">
  <path d="M16 4L16 22L6 22Z"/><path d="M16 8L16 22L24 22Z" opacity="0.6"/>
  <path d="M4 24Q10 20 16 24Q22 28 28 24" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round"/>
</svg><span class="T">Odysseus</span></div>
<div class="S" id="S">Starting server...</div>
<div class="PT"><div class="PF" id="P"></div></div>
<div class="E" id="E"></div>
</body></html>`);
}


// ── Main window ───────────────────────────────────────────────────────────────

function CreateWindow() {
    const IconPath = FindIcon();
    MainWindow = new BrowserWindow({
        width: 1280, height: 860, minWidth: 800, minHeight: 600,
        title: 'Odysseus', icon: IconPath || undefined,
        backgroundColor: '#0f1117', autoHideMenuBar: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
        show: false,
    });

    MainWindow.loadURL(TargetUrl);
    MainWindow.once('ready-to-show', () => { MainWindow.show(); });

    // Rewrite CSP headers from the Odysseus server to allow fetch() to port 7002.
    // IMPORTANT: this must only touch the main document request, never API
    // calls (fetch/XHR to /api/...). Filtering by resourceType === 'mainFrame'
    // avoids mutating headers on compressed/chunked API responses, which was
    // causing intermittent ERR_CONTENT_LENGTH_MISMATCH on MCP reconnect/toggle
    // requests when this listener matched every 127.0.0.1 request.
    MainWindow.webContents.session.webRequest.onHeadersReceived(
        { urls: ['http://127.0.0.1:*/*', 'http://localhost:*/*'] },
        (Details, Callback) => {
            if (Details.resourceType !== 'mainFrame') {
                Callback({ responseHeaders: Details.responseHeaders });
                return;
            }
            const Headers = { ...Details.responseHeaders };
            const CspKey = Object.keys(Headers).find((K) => K.toLowerCase() === 'content-security-policy');
            if (CspKey) {
                let Csp = Headers[CspKey][0] || '';
                if (!Csp.includes('127.0.0.1:7002')) {
                    if (/connect-src/.test(Csp)) {
                        Csp = Csp.replace(/connect-src([^;]*)/, 'connect-src$1 http://127.0.0.1:7002');
                    } else {
                        Csp = Csp.trimEnd().replace(/;?$/, ';') + " connect-src 'self' http://127.0.0.1:7002;";
                    }
                    Headers[CspKey] = [Csp];
                }
            }
            Callback({ responseHeaders: Headers });
        }
    );

    MainWindow.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
    MainWindow.webContents.on('will-navigate', (Event, NavUrl) => {
        const AppOrigin  = new URL(TargetUrl).origin;
        const DestOrigin = new URL(NavUrl).origin;
        if (DestOrigin !== AppOrigin) { Event.preventDefault(); shell.openExternal(NavUrl); }
    });
    MainWindow.on('close',  () => { IsQuitting = true; app.quit(); });
    MainWindow.on('closed', () => { MainWindow = null; });
}


// ── Browser Tool window ───────────────────────────────────────────────────────

function CreateBrowserToolWindow(StartUrl) {
    if (BrowserToolWindow != null && !BrowserToolWindow.isDestroyed()) {
        BrowserToolWindow.focus();
        if (StartUrl) {
            const Url = NormaliseUrl(StartUrl);
            if (Url) { BrowserToolWindow.webContents.loadURL(Url); }
        }
        return BrowserToolWindow;
    }

    const IconPath = FindIcon();
    const HomeUrl  = GetHomePageUrl();
    const LoadUrl  = StartUrl ? (NormaliseUrl(StartUrl) || HomeUrl) : HomeUrl;

    const Win = new BrowserWindow({
        width: 1200, height: 840, minWidth: 600, minHeight: 400,
        title: 'Odysseus Browser Tool', icon: IconPath || undefined,
        backgroundColor: '#0d1117', autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: false,   // preload needs to expose globals to page JS
            sandbox: false,
            partition: BrowserPartition,
            webSecurity: false,        // allow mixed/cross-origin content
            preload: NavPreloadPath,   // nav bar injected before any page code runs
        },
    });

    Win.loadURL(LoadUrl);

    // Expose the home URL to the preload so the Home button works
    Win.webContents.on('did-start-loading', () => {
        Win.webContents.executeJavaScript(
            `window._odyHomeUrl = ${JSON.stringify(HomeUrl)};`
        ).catch(() => {});
    });

    // Update window title
    Win.webContents.on('page-title-updated', (Event, Title) => {
        if (!Win.isDestroyed()) {
            Win.setTitle(Title ? `${Title} \u2014 Odysseus Browser` : 'Odysseus Browser Tool');
        }
    });

    // Keep all navigation inside this window
    Win.webContents.setWindowOpenHandler(({ url }) => {
        Win.webContents.loadURL(url);
        return { action: 'deny' };
    });

    Win.on('closed', () => { BrowserToolWindow = null; });

    BrowserToolWindow = Win;
    return Win;
}


// ── Browser Tool HTTP server (port 7002) ──────────────────────────────────────

async function HandleScrape(Req, Res) {
    try {
        const Body      = await ReadRequestBody(Req);
        const Url       = (Body.url || '').trim();
        const CaptureAs = Body.capture_as || 'text';
        const WaitMs    = Math.min(parseInt(Body.wait_ms || 0, 10), 10000);
        if (!Url) { SendJson(Res, 400, { ok: false, error: 'url is required' }); return; }

        const Win = new BrowserWindow({
            width: 1280, height: 900, show: false,
            webPreferences: { nodeIntegration: false, contextIsolation: true,
                sandbox: false, partition: BrowserPartition, webSecurity: false },
        });

        await new Promise((Resolve) => {
            let Done = false;
            const Finish = () => { if (!Done) { Done = true; setTimeout(Resolve, WaitMs); } };
            Win.webContents.once('did-finish-load', Finish);
            Win.webContents.once('did-fail-load',   Finish);
            setTimeout(Finish, 15000);
            Win.loadURL(Url);
        });

        const FinalUrl  = Win.webContents.getURL();
        const PageTitle = Win.webContents.getTitle();
        let Content = '';

        if (CaptureAs === 'html') {
            Content = await Win.webContents.executeJavaScript('document.documentElement.outerHTML');
        } else if (CaptureAs === 'links') {
            Content = await Win.webContents.executeJavaScript(`
                JSON.stringify(Array.from(document.querySelectorAll('a[href]'))
                  .map(A => ({ text: A.innerText.trim().slice(0,200), href: A.href }))
                  .filter(L => L.href && !L.href.startsWith('javascript:'))
                  .slice(0,200))
            `);
        } else if (CaptureAs === 'markdown') {
            Content = await Win.webContents.executeJavaScript(`
                (function(){
                  function W(N){
                    if(N.nodeType===3) return N.textContent;
                    if(N.nodeType!==1) return '';
                    var T=N.tagName.toLowerCase();
                    if(['script','style','noscript','svg','head','nav','footer','aside','form'].includes(T)) return '';
                    var C=Array.from(N.childNodes).map(W).join('');
                    if(/^h[1-6]$/.test(T)) return '\\n'+'#'.repeat(+T[1])+' '+C.trim()+'\\n';
                    if(T==='p') return '\\n'+C.trim()+'\\n';
                    if(T==='br') return '\\n';
                    if(T==='li') return '\\n- '+C.trim();
                    if(T==='a') return '['+C.trim()+']('+N.href+')';
                    if(T==='strong'||T==='b') return '**'+C.trim()+'**';
                    if(T==='em'||T==='i') return '_'+C.trim()+'_';
                    if(T==='code') return '\`'+C.trim()+'\`';
                    if(T==='pre') return '\\n\`\`\`\\n'+C.trim()+'\\n\`\`\`\\n';
                    return C;
                  }
                  return W(document.body||document.documentElement).replace(/\\n{3,}/g,'\\n\\n').trim();
                })()
            `);
        } else {
            Content = await Win.webContents.executeJavaScript(`
                (function(){
                  var C=document.body.cloneNode(true);
                  ['script','style','noscript','svg','nav','footer','aside'].forEach(function(T){
                    C.querySelectorAll(T).forEach(function(El){El.remove();});
                  });
                  return (C.innerText||C.textContent||'').replace(/\\s{3,}/g,'\\n\\n').trim();
                })()
            `);
        }

        Win.destroy();
        SendJson(Res, 200, { ok: true, url: FinalUrl, title: PageTitle, content: Content });
    } catch (Err) {
        SendJson(Res, 500, { ok: false, error: Err.message });
    }
}

async function HandleSearch(Req, Res) {
    try {
        const Body  = await ReadRequestBody(Req);
        const Query = (Body.query || '').trim();
        const Max   = Math.min(parseInt(Body.max || 10, 10), 30);
        if (!Query) { SendJson(Res, 400, { ok: false, error: 'query is required' }); return; }

        const Win = new BrowserWindow({
            width: 1280, height: 900, show: false,
            webPreferences: { nodeIntegration: false, contextIsolation: true,
                sandbox: false, partition: BrowserPartition, webSecurity: false },
        });

        await new Promise((Resolve) => {
            let Done = false;
            const Finish = () => { if (!Done) { Done = true; Resolve(); } };
            Win.webContents.once('did-finish-load', Finish);
            Win.webContents.once('did-fail-load',  Finish);
            setTimeout(Finish, 10000);
            Win.loadURL('https://duckduckgo.com/html/?q=' + encodeURIComponent(Query));
        });

        const Raw = await Win.webContents.executeJavaScript(`
            JSON.stringify(Array.from(document.querySelectorAll('.result')).slice(0,${Max}).map(function(El){
              return {
                title:   (El.querySelector('.result__title')  ||{}).innerText||'',
                url:     (El.querySelector('.result__url')    ||{}).innerText||'',
                snippet: (El.querySelector('.result__snippet')||{}).innerText||'',
              };
            }).filter(function(R){return R.title||R.url;}))
        `);
        Win.destroy();
        let Results = [];
        try { Results = JSON.parse(Raw); } catch { }
        SendJson(Res, 200, { ok: true, query: Query, results: Results });
    } catch (Err) {
        SendJson(Res, 500, { ok: false, error: Err.message });
    }
}

function StartBrowserToolServer() {
    if (BrowserToolServer != null) { return; }

    BrowserToolServer = Http.createServer(async (Req, Res) => {
        if (Req.method === 'OPTIONS') {
            Res.writeHead(204, { 'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type' });
            Res.end(); return;
        }

        try {
            if (Req.method === 'GET' && Req.url === '/status') {
                SendJson(Res, 200, { ok: true, port: BrowserToolPort,
                    browser_open: BrowserToolWindow != null && !BrowserToolWindow.isDestroyed() });
                return;
            }

            if (Req.url === '/open') {
                const Body = await ReadRequestBody(Req);
                CreateBrowserToolWindow(Body.url || null);
                BrowserToolWindow.focus();
                SendJson(Res, 200, { ok: true }); return;
            }

            if (Req.url === '/scrape') { await HandleScrape(Req, Res); return; }
            if (Req.url === '/search') { await HandleSearch(Req, Res); return; }

            if (Req.url === '/screenshot') {
                const Body = await ReadRequestBody(Req);
                if (!BrowserToolWindow || BrowserToolWindow.isDestroyed()) {
                    SendJson(Res, 400, { ok: false, error: 'No browser window open. Call /open first.' }); return;
                }
                if (Body.url) {
                    await new Promise((Resolve) => {
                        BrowserToolWindow.webContents.once('did-finish-load', Resolve);
                        BrowserToolWindow.webContents.loadURL(NormaliseUrl(Body.url) || Body.url);
                    });
                }
                const Img = await BrowserToolWindow.webContents.capturePage();
                SendJson(Res, 200, { ok: true, image: Img.toPNG().toString('base64'),
                    url: BrowserToolWindow.webContents.getURL() }); return;
            }

            if (Req.url === '/click') {
                const Body = await ReadRequestBody(Req);
                const Sel  = (Body.selector || '').trim();
                if (!Sel) { SendJson(Res, 400, { ok: false, error: 'selector is required' }); return; }
                if (!BrowserToolWindow || BrowserToolWindow.isDestroyed()) {
                    SendJson(Res, 400, { ok: false, error: 'No browser window open. Call /open first.' }); return;
                }
                if (Body.url) {
                    await new Promise((Resolve) => {
                        BrowserToolWindow.webContents.once('did-finish-load', Resolve);
                        BrowserToolWindow.webContents.loadURL(NormaliseUrl(Body.url) || Body.url);
                    });
                }
                const R = await BrowserToolWindow.webContents.executeJavaScript(`
                    (function(){var El=document.querySelector(${JSON.stringify(Sel)});
                    if(!El) return {ok:false,error:'Not found: '+${JSON.stringify(Sel)}};
                    El.click(); return {ok:true,tag:El.tagName,text:(El.innerText||'').slice(0,100)};})()
                `);
                SendJson(Res, 200, { ...R, url: BrowserToolWindow.webContents.getURL() }); return;
            }

            if (Req.url === '/fill') {
                const Body = await ReadRequestBody(Req);
                const Sel  = (Body.selector || '').trim();
                const Val  = Body.value || '';
                const Sub  = !!Body.submit;
                if (!Sel) { SendJson(Res, 400, { ok: false, error: 'selector is required' }); return; }
                if (!BrowserToolWindow || BrowserToolWindow.isDestroyed()) {
                    SendJson(Res, 400, { ok: false, error: 'No browser window open. Call /open first.' }); return;
                }
                if (Body.url) {
                    await new Promise((Resolve) => {
                        BrowserToolWindow.webContents.once('did-finish-load', Resolve);
                        BrowserToolWindow.webContents.loadURL(NormaliseUrl(Body.url) || Body.url);
                    });
                }
                const R = await BrowserToolWindow.webContents.executeJavaScript(`
                    (function(){var El=document.querySelector(${JSON.stringify(Sel)});
                    if(!El) return {ok:false,error:'Not found: '+${JSON.stringify(Sel)}};
                    El.focus(); El.value=${JSON.stringify(Val)};
                    El.dispatchEvent(new Event('input',{bubbles:true}));
                    El.dispatchEvent(new Event('change',{bubbles:true}));
                    ${Sub ? `El.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:13,bubbles:true}));` : ''}
                    return {ok:true,tag:El.tagName};})()
                `);
                SendJson(Res, 200, { ...R, url: BrowserToolWindow.webContents.getURL() }); return;
            }

            if (Req.url === '/evaluate') {
                const Body = await ReadRequestBody(Req);
                const Expr = (Body.expression || '').trim();
                if (!Expr) { SendJson(Res, 400, { ok: false, error: 'expression is required' }); return; }
                if (!BrowserToolWindow || BrowserToolWindow.isDestroyed()) {
                    SendJson(Res, 400, { ok: false, error: 'No browser window open. Call /open first.' }); return;
                }
                if (Body.url) {
                    await new Promise((Resolve) => {
                        BrowserToolWindow.webContents.once('did-finish-load', Resolve);
                        BrowserToolWindow.webContents.loadURL(NormaliseUrl(Body.url) || Body.url);
                    });
                }
                const R = await BrowserToolWindow.webContents.executeJavaScript(Expr);
                SendJson(Res, 200, { ok: true, result: R, url: BrowserToolWindow.webContents.getURL() }); return;
            }

            if (Req.url === '/clear-session') {
                const Sess = session.fromPartition(BrowserPartition);
                await Sess.clearCache();
                await Sess.clearStorageData();
                SendJson(Res, 200, { ok: true }); return;
            }

            SendJson(Res, 404, { ok: false, error: 'Unknown endpoint: ' + Req.url });

        } catch (Err) {
            SendJson(Res, 500, { ok: false, error: Err.message });
        }
    });

    BrowserToolServer.on('error', (Err) => { console.error('[BrowserTool] Server error:', Err.message); });
    BrowserToolServer.listen(BrowserToolPort, '127.0.0.1', () => {
        console.log('[BrowserTool] Listening on port', BrowserToolPort);
    });
}


// ── App lifecycle ─────────────────────────────────────────────────────────────

app.setAppUserModelId('Odysseus');

app.whenReady().then(() => {
    WriteNavPreload();   // write the preload script to temp before any window opens
    StartServer();
    StartBrowserToolServer();
    CreateSplash();

    const StartTime = Date.now();
    const ElapsedTimer = setInterval(() => {
        ElapsedSeconds = Math.floor((Date.now() - StartTime) / 1000);
        const Progress = Math.min(90, ElapsedSeconds * 2.5);
        let StatusText = 'Starting server...';
        if (ElapsedSeconds >= 3)  { StatusText = 'Loading models and services...'; }
        if (ElapsedSeconds >= 10) { StatusText = 'Almost ready...'; }
        if (ElapsedSeconds >= 20) { StatusText = 'Still warming up...'; }
        UpdateSplash(StatusText, Progress);
    }, 1000);

    PollUntilReady(() => {
        clearInterval(ElapsedTimer);
        UpdateSplash('Ready!', 100);
        setTimeout(() => {
            CreateWindow();
            if (SplashWindow != null && !SplashWindow.isDestroyed()) {
                SplashWindow.close();
                SplashWindow = null;
            }
        }, 400);
    });
});

app.on('before-quit', () => {
    IsQuitting = true;
    StopServer();
    if (BrowserToolServer != null) { BrowserToolServer.close(); BrowserToolServer = null; }
    // Clean up temp preload file
    try { FileSystem.unlinkSync(NavPreloadPath); } catch { }
});

app.on('window-all-closed', () => { if (process.platform === 'darwin') { app.quit(); } });
app.on('activate', () => { if (MainWindow != null) { MainWindow.show(); } });