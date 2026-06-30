const { app, BrowserWindow, session, shell, dialog, ipcMain, screen } = require('electron');
const { spawn } = require('child_process');
const Path = require('path');
const FileSystem = require('fs');
const Http = require('http');

// Bump this on every meaningful change. Check it in the debug log file to
// confirm you're actually running the code you think you're running —
// editor/IDE caching, build steps, or a stale background instance can all
// make it look like changes "aren't taking" when really the old process
// never died. See the single-instance lock below for the most likely culprit.
const MAIN_JS_VERSION = '2026-06-30-navbar-race-fix-v3';

// If a previous launch of this app never fully exited (closed window but the
// process lingered in the background), a second launch would otherwise run
// alongside it. The new instance's Browser Tool server would then fail to
// bind port 7002 (already held by the old one) and every /open request from
// the AI agent would keep hitting the OLD, stale instance — meaning code
// edits appear to do nothing no matter how many times you restart, because
// you're never actually talking to the new process. Hard-quit instead.
if (app.requestSingleInstanceLock() === false) {
    console.log('[BrowserTool] Another instance is already running (port/lock held) — quitting this one immediately.');
    dialog.showErrorBox('Odysseus — Already Running',
        'Another instance of Odysseus is already running in the background.\n\n' +
        'This new launch will close immediately. If you don\'t see the existing window, ' +
        'check Task Manager for a leftover "Odysseus" or "electron.exe" process and end it, ' +
        'then launch again.');
    app.quit();
    return;
}

// Plain-text log file, since a packaged Electron GUI build has no visible
// console even when launched from a terminal. Truncated fresh each run so
// it's always just the current session — open it in Notepad after
// reproducing an issue.
const DebugLogPath = Path.join(app.getPath('temp'), 'odysseus-browser-debug.log');
try { FileSystem.writeFileSync(DebugLogPath, '=== Odysseus Browser Tool debug log — ' + new Date().toISOString() + ' ===\n'); } catch { }

function Log(...Args) {
    const Line = Args.map((A) => (typeof A === 'string' ? A : JSON.stringify(A))).join(' ');
    console.log(...Args);
    try { FileSystem.appendFileSync(DebugLogPath, '[' + new Date().toISOString() + '] ' + Line + '\n'); } catch { }
}

const OdysseusDirectory = Path.dirname(process.execPath);
Log('[BrowserTool] MAIN_JS_VERSION =', MAIN_JS_VERSION, '— if this isn\'t the version you expect, you are not running the file you think you are.');
Log('[BrowserTool] process.pid =', process.pid);
Log('[BrowserTool] DEBUG LOG FILE:', DebugLogPath);
Log('[BrowserTool] process.execPath =', process.execPath);
Log('[BrowserTool] app.getAppPath() =', app.getAppPath());
Log('[BrowserTool] __dirname =', __dirname);
Log('[BrowserTool] OdysseusDirectory =', OdysseusDirectory);
const ApplicationPort = parseInt(process.env.APP_PORT || process.env.ODYSSEUS_PORT || '7000', 10);
const TargetUrl = process.env.ODYSSEUS_ELECTRON_URL || `http://127.0.0.1:${ApplicationPort}`;
const PollIntervalMilliseconds = 1000;
const ReadyTimeoutMilliseconds = 60000;

const BrowserToolPort = 7002;
const BrowserPartition = 'persist:odysseus-browser-tool';

// Drop unpacked Chrome extensions (each in its own folder with a
// manifest.json — e.g. uBlock Origin Lite) into this directory and they'll
// be loaded into the Browser Tool's session automatically on startup.
const ExtensionsDirectory = Path.join(OdysseusDirectory, 'extensions');

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

try {

console.log('[Odysseus Nav] preload running for', location.href);

// ipcRenderer is always available to preload scripts regardless of
// nodeIntegration (only sandbox:true would block it, and we run unsandboxed).
// Used to ask the main process for the loaded extension list and to open an
// extension's real popup.html in its own small window.
var ElectronApi = require('electron');
window._odyIpcRenderer = ElectronApi.ipcRenderer;

// Home + extensions page URLs come in via additionalArguments (set once at
// BrowserWindow creation) instead of being injected post-load — this runs
// synchronously before anything else, so there's no race with page load timing.
(function ParseAdditionalArguments() {
  var HomeArg = process.argv.find(function(Arg) { return Arg.indexOf('--ody-home-url=') === 0; });
  var ExtArg  = process.argv.find(function(Arg) { return Arg.indexOf('--ody-extensions-url=') === 0; });
  window._odyHomeUrl = HomeArg ? decodeURIComponent(HomeArg.slice('--ody-home-url='.length)) : null;
  var ExtRaw = ExtArg ? decodeURIComponent(ExtArg.slice('--ody-extensions-url='.length)) : '';
  window._odyExtensionsUrl = ExtRaw || null;
  console.log('[Odysseus Nav] parsed from argv — homeUrl:', window._odyHomeUrl, 'extensionsUrl:', window._odyExtensionsUrl);
})();

// Visual canary — independent of everything below. If this dot doesn't show
// up in the top-right corner, the preload isn't running at all (wrong file
// being loaded, packaging issue, etc). If the dot shows but the nav bar
// doesn't, the bug is in the nav bar code specifically below.

// ── Constants ─────────────────────────────────────────────────────────────────
const NAV_H = 44; // px — must match CSS below

// ── Inject nav bar CSS + HTML immediately (before page paints) ────────────────
//
// Wrapped in a retry: Chromium fires this preload not just on the real
// destination page but also on the transient "initial empty document" that
// exists for an instant during navigation — at that point document.head and
// document.documentElement can both be null. Rather than crash, defer to the
// next tick until the real document is actually there.
function InjectBar() {
  if (!document.documentElement) {
    setTimeout(InjectBar, 0);
    return;
  }

  var Canary = document.createElement('div');
  Canary.id = '_ody-canary';
  Canary.style.cssText = 'position:fixed;top:4px;right:4px;width:10px;height:10px;' +
    'border-radius:50%;background:#50fa7b;z-index:2147483647;pointer-events:none;';
  document.documentElement.appendChild(Canary);

  const Style = document.createElement('style');
  Style.textContent = \`
  html { padding-top: \${NAV_H}px !important; }
  #_ody-nav {
    position: fixed; top: 0; left: 0; right: 0; height: \${NAV_H}px;
    z-index: 2147483647;
    display: flex; align-items: center; padding: 0 8px; gap: 6px;
    background: #111; border-bottom: 1px solid #355a66;
    font-family: 'Fira Code', 'Courier New', monospace;
    box-sizing: border-box;
    /* block pointer events on the bar background so only buttons/input work */
    -webkit-app-region: drag;
  }
  #_ody-nav * { box-sizing: border-box; -webkit-app-region: no-drag; }
  #_ody-nav button {
    background: none; border: none; color: #6b8a94; cursor: pointer;
    padding: 5px 7px; border-radius: 5px; font-size: 15px; line-height: 1;
    flex-shrink: 0; display: flex; align-items: center; justify-content: center;
    transition: color .12s, background .12s;
  }
  #_ody-nav button:hover:not(:disabled) { color: #9cdef2; background: #1e2228; }
  #_ody-nav button:disabled { opacity: .3; cursor: default; }
  #_ody-url-wrap {
    flex: 1; display: flex; align-items: center;
    background: #1e2228; border: 1px solid #355a66; border-radius: 8px;
    padding: 0 10px; gap: 6px; min-width: 0;
    transition: border-color .15s;
  }
  #_ody-url-wrap:focus-within { border-color: #e06c75; }
  #_ody-lock { font-size: 11px; flex-shrink: 0; opacity: .7; }
  #_ody-url {
    flex: 1; background: none; border: none; color: #9cdef2;
    font-size: 12px; outline: none; min-width: 0; padding: 7px 0;
    font-family: inherit;
  }
  #_ody-go {
    background: none; border: none; color: #e06c75; cursor: pointer;
    font-size: 13px; padding: 2px 4px; border-radius: 3px; flex-shrink: 0;
  }
  #_ody-go:hover { background: #e06c7522; }
  #_ody-ext-icons {
    display: flex; align-items: center; gap: 2px; flex-shrink: 0;
  }
  #_ody-ext-icons button {
    width: 26px; height: 26px; padding: 4px; position: relative;
  }
  #_ody-ext-icons button img {
    width: 100%; height: 100%; object-fit: contain; border-radius: 3px;
  }
  #_ody-ext-icons button.active { background: #1e2228; color: #e06c75; }
\`;
  Style.id = '_ody-nav-style';
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
  <div id="_ody-ext-icons"></div>
  <button id="_ody-extensions" title="Extensions">
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">
      <path d="M5,5 H9.5 A2.5,2.5 0 0 0 14.5,5 H19 V9.5 A2.5,2.5 0 0 1 19,14.5 V19 H5 Z" />
    </svg>
  </button>
  <button id="_ody-home" title="Home">
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4 11.5 12 4l8 7.5" />
      <path d="M6 10v9h12v-9" />
      <path d="M10 19v-6h4v6" />
    </svg>
  </button>
\`;
  // Prepend before body content — document.body may not exist yet so use
  // documentElement and let the browser sort layout
  document.documentElement.prepend(Nav);

  // Wire up listeners IMMEDIATELY after the bar is actually in the DOM —
  // this is the only point that's guaranteed to be after the elements
  // exist. Previously WireNav() was triggered separately via
  // DOMContentLoaded/readyState, which raced against InjectBar's own
  // setTimeout(0) retry path (taken when document.documentElement was still
  // null at preload start): on fast file:// reloads, DOMContentLoaded could
  // fire and run WireNav() before the deferred InjectBar() retry had
  // actually inserted the bar, so every getElementById() came back null,
  // the guard silently aborted, and — because the DOMContentLoaded listener
  // was { once: true } — WireNav() would never run again for that page.
  // The bar would still appear a moment later when the deferred InjectBar
  // retry fired, but with zero listeners attached: visually present,
  // completely inert. Calling WireNav() right here removes the race
  // entirely, since insertion and wiring now happen in the same tick.
  WireNav();

  // ── Watchdog — re-insert the bar if a page script wipes the DOM ───────────────
  //
  // Some pages (SPAs, frameworks that rebuild <html> on hydration, pages that
  // call document.write, etc.) blow away nodes that were already in the DOM
  // before their own JS ran. Since the preload only runs once per real
  // navigation, we keep a standing MutationObserver that puts the bar back the
  // instant it disappears, plus a low-frequency interval as a safety net.

  function EnsureNavPresent() {
    if (!document.getElementById('_ody-nav')) {
      document.documentElement.prepend(Nav);
    }
    if (!document.getElementById('_ody-nav-style')) {
      (document.head || document.documentElement).prepend(Style);
    }
  }

  const RootObserver = new MutationObserver(EnsureNavPresent);
  RootObserver.observe(document.documentElement, { childList: true });

  const WatchdogIntervalId = setInterval(EnsureNavPresent, 1000);

  // Stop the watchdog the instant this document starts unloading. Without
  // this, a still-running interval/observer from the outgoing page could
  // theoretically fire during the transition and prepend its (now-stale)
  // Nav/Style nodes into whatever document happens to exist at that instant
  // — which looks exactly like "the bar is there but nothing works", since
  // those nodes' event handlers are closed over the OLD page's elements.
  window.addEventListener('pagehide', function() {
    clearInterval(WatchdogIntervalId);
    RootObserver.disconnect();
  }, { once: true });
}

InjectBar();

// ── Wire up once DOM is ready ─────────────────────────────────────────────────
function WireNav() {
  const BtnBack   = document.getElementById('_ody-back');
  const BtnFwd    = document.getElementById('_ody-fwd');
  const BtnReload = document.getElementById('_ody-reload');
  const BtnGo     = document.getElementById('_ody-go');
  const BtnHome   = document.getElementById('_ody-home');
  const BtnExtensions = document.getElementById('_ody-extensions');
  const UrlInput  = document.getElementById('_ody-url');
  const LockEl    = document.getElementById('_ody-lock');

  if (!UrlInput) return; // guard — shouldn't happen

  // ── URL normalisation ───────────────────────────────────
  function Normalise(Raw) {
    Raw = (Raw || '').trim();
    if (!Raw) return null;
    var IsUrl = /^https?:\\/\\//.test(Raw) ||
                /^[a-zA-Z0-9-]+\\.[a-zA-Z]{2,}(\\/.*)?$/.test(Raw);
    var Result;
    if (!IsUrl) { Result = 'https://duckduckgo.com/?q=' + encodeURIComponent(Raw); }
    else if (!/^https?:\\/\\//.test(Raw)) { Result = 'https://' + Raw; }
    else { Result = Raw; }
    console.log('[Odysseus Nav] Normalise(', JSON.stringify(Raw), ') ->', Result);
    return Result;
  }

  function GoTo(Url) {
    console.log('[Odysseus Nav] GoTo navigating to', Url, 'from', window.location.href);
    if (window._odyIpcRenderer) {
      window._odyIpcRenderer.invoke('ody-navigate', Url).then(function(Result) {
        console.log('[Odysseus Nav] ody-navigate result:', Result);
        if (!Result || Result.ok !== true) {
          console.warn('[Odysseus Nav] main-process navigate failed, falling back to window.location');
          window.location.href = Url;
        }
      }).catch(function(NavErr) {
        console.error('[Odysseus Nav] ody-navigate IPC failed:', NavErr, '— falling back to window.location');
        window.location.href = Url;
      });
    } else {
      window.location.href = Url;
    }
  }

  // ── Navigate helper — also used by default-browser-page.html ───────────────
  window._odyNavGo = function(Url) {
    var Target = Normalise(Url);
    if (Target) { GoTo(Target); }
    else { console.warn('[Odysseus Nav] _odyNavGo got empty Url:', Url); }
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
      LockEl.textContent = '\\u{1F512}'; LockEl.style.color = '#50fa7b';
      LockEl.title = 'Secure';
    } else if (Href.startsWith('http://')) {
      LockEl.textContent = '\\u26A0'; LockEl.style.color = '#e06c75';
      LockEl.title = 'Not secure';
    } else if (Href.startsWith('file://')) {
      LockEl.textContent = '\\u{1F4C1}'; LockEl.style.color = '#6b8a94';
      LockEl.title = 'Local file';
    } else {
      LockEl.textContent = '\\u{1F512}'; LockEl.style.color = '#50fa7b';
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
    // _odyHomeUrl is parsed from process.argv (additionalArguments) at preload start
    GoTo(window._odyHomeUrl || 'about:blank');
  });
  if (BtnExtensions) {
    BtnExtensions.addEventListener('click', function() {
      // _odyExtensionsUrl is set by main.js the same way as _odyHomeUrl
      if (window._odyExtensionsUrl) {
        GoTo(window._odyExtensionsUrl);
      } else {
        console.warn('[Odysseus Nav] extensions.html not found in static/ — nothing to open');
      }
    });
  }

  // ── Extension toolbar icons ──────────────────────────────
  // Populated from the same IPC call extensions.html uses. Only extensions
  // that declare a default_popup get a clickable icon (matches normal
  // browser behaviour — extensions without a popup, like pure content-script
  // blockers, just run in the background with no toolbar action).
  var ExtIconsContainer = document.getElementById('_ody-ext-icons');
  if (ExtIconsContainer && window._odyIpcRenderer) {
    window._odyIpcRenderer.invoke('ody-list-extensions').then(function(Data) {
      var Extensions = (Data && Data.extensions) || [];
      ExtIconsContainer.innerHTML = '';
      Extensions.forEach(function(Ext) {
        if (!Ext.hasPopup) { return; }

        var IconBtn = document.createElement('button');
        IconBtn.title = Ext.name + (Ext.version ? ' v' + Ext.version : '');
        IconBtn.dataset.extensionId = Ext.id;

        if (Ext.icon) {
          var IconImg = document.createElement('img');
          IconImg.src = Ext.icon;
          IconImg.alt = '';
          IconBtn.appendChild(IconImg);
        } else {
          IconBtn.textContent = (Ext.name || '?').charAt(0).toUpperCase();
        }

        IconBtn.addEventListener('click', function() {
          console.log('[Odysseus Nav] extension icon clicked:', Ext.id, Ext.name);
          window._odyIpcRenderer.invoke('ody-open-extension-popup', Ext.id).then(function(Result) {
            console.log('[Odysseus Nav] ody-open-extension-popup result:', JSON.stringify(Result));
            if (!Result || Result.ok !== true) {
              console.error('[Odysseus Nav] failed to open extension popup:', Result && Result.error);
              return;
            }
            // Toggle a visual "active" state on the clicked icon. Since
            // popups close themselves on blur (handled in main.js), and
            // there's no event back to the renderer when that happens, this
            // is a best-effort highlight rather than a perfectly tracked
            // open/closed state.
            var AllIconButtons = ExtIconsContainer.querySelectorAll('button');
            AllIconButtons.forEach(function(B) { B.classList.remove('active'); });
            if (!Result.toggledClosed) { IconBtn.classList.add('active'); }
          }).catch(function(Err) {
            console.error('[Odysseus Nav] ody-open-extension-popup IPC failed:', Err);
          });
        });

        ExtIconsContainer.appendChild(IconBtn);
      });
    }).catch(function(Err) {
      console.error('[Odysseus Nav] failed to load extension icons:', Err);
    });
  }

  BtnGo.addEventListener('click', function() {
    console.log('[Odysseus Nav] Go button clicked, input value =', JSON.stringify(UrlInput.value));
    var Target = Normalise(UrlInput.value);
    if (Target) { GoTo(Target); }
  });

  UrlInput.addEventListener('keydown', function(E) {
    if (E.key === 'Enter') {
      console.log('[Odysseus Nav] Enter pressed, input value =', JSON.stringify(UrlInput.value));
      var Target = Normalise(UrlInput.value);
      if (Target) { GoTo(Target); }
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

}

// WireNav() is now called directly from InjectBar(), immediately after the
// nav bar is inserted into the DOM — see the comment at that call site.
// This block previously re-triggered WireNav() via DOMContentLoaded /
// readyState, which raced against InjectBar()'s own setTimeout(0) retry
// and was the actual cause of "nav bar visible but buttons dead": on a fast
// file:// reload, DOMContentLoaded could fire and run WireNav() against an
// empty DOM (bar not inserted yet), permanently aborting via the early-exit
// guard since the listener was registered with once: true.
// double-attach every event listener.

} catch (PreloadFatalErr) {
  console.error('[Odysseus Nav] preload crashed:', PreloadFatalErr && PreloadFatalErr.message, PreloadFatalErr);
}
`;

function WriteNavPreload() {
    try {
        FileSystem.writeFileSync(NavPreloadPath, NAV_PRELOAD_SOURCE, 'utf8');
        console.log('[BrowserTool] Nav preload written to', NavPreloadPath, '(', NAV_PRELOAD_SOURCE.length, 'bytes)');
    } catch (WriteErr) {
        console.error('[BrowserTool] Failed to write nav preload:', WriteErr.message);
    }
}

// Defensive re-write, called immediately before every navigation in the
// Browser Tool window. Electron reloads the `preload` script fresh on every
// single navigation (not just once at window creation) — so if something
// external deletes the temp file mid-session (most likely cause: AV/Defender
// quarantining a JS file dynamically written to %TEMP%, a common signature
// for malware droppers), every page after that silently loses the nav bar
// AND window._odyIpcRenderer with no visible error to the user. Re-writing
// right before each navigation means even if the file gets deleted again
// afterwards, it's at least present for the load that matters.
function EnsureNavPreload() {
    try {
        if (FileSystem.existsSync(NavPreloadPath) == false) {
            Log('[BrowserTool] Nav preload missing before navigation — rewriting:', NavPreloadPath);
        }
        FileSystem.writeFileSync(NavPreloadPath, NAV_PRELOAD_SOURCE, 'utf8');
    } catch (WriteErr) {
        Log('[BrowserTool] EnsureNavPreload failed to write:', WriteErr.message);
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

// Local file:// navigations are prone to Chromium reusing the previous
// document/renderer context instead of doing a full navigation — meaning the
// preload (nav bar, watchdog, all of it) never re-runs, leaving a dead copy
// of the old page's bar behind. A unique cache-busting query string forces
// every file:// load to be treated as genuinely new.
function BustFileCache(Url) {
    if (Url == null || Url.indexOf('file://') !== 0) { return Url; }
    const Separator = Url.indexOf('?') === -1 ? '?' : '&';
    return Url + Separator + '_t=' + Date.now();
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
    const StaticPage = ResolveStaticFile('default-browser-page.html');
    if (StaticPage != null) {
        return 'file:///' + StaticPage.replace(/\\/g, '/');
    }
    return 'https://duckduckgo.com';
}

function GetExtensionsPageUrl() {
    const StaticPage = ResolveStaticFile('extensions.html');
    if (StaticPage != null) {
        return 'file:///' + StaticPage.replace(/\\/g, '/');
    }
    return null;
}

// Tries every plausible base directory for the app's own static/ folder and
// returns the first match. process.execPath alone is unreliable: in a
// packaged build it's the app's own .exe (correct), but in `electron .` dev
// mode it's the Electron binary buried in node_modules instead. app.getAppPath()
// and __dirname are the locations Electron itself considers authoritative.
function ResolveStaticFile(FileName) {
    const Candidates = [OdysseusDirectory, app.getAppPath(), __dirname];
    for (const Candidate of Candidates) {
        const FullPath = Path.join(Candidate, 'static', FileName);
        const Exists = FileSystem.existsSync(FullPath);
        Log('[BrowserTool] ResolveStaticFile checking:', FullPath, '-> exists:', Exists);
        if (Exists) { return FullPath; }
    }
    Log('[BrowserTool] ResolveStaticFile: could not find', FileName, 'in any candidate static/ folder');
    return null;
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
        backgroundColor: '#282c34', icon: IconPath || undefined,
        webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    SplashWindow.loadURL(`data:text/html;charset=utf-8,<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;
  background:%23282c34;font-family:'Fira Code','Courier New',monospace;color:%239cdef2;
  user-select:none;-webkit-user-select:none}
.B{display:flex;align-items:center;gap:10px;margin-bottom:22px;color:%239cdef2}
.T{font-size:20px;font-weight:600;letter-spacing:-0.2px}
.S{font-size:12px;color:%236b8a94;margin-bottom:22px;min-height:16px}
.PT{width:240px;height:2px;background:%231e2228;border-radius:1px;overflow:hidden;border:1px solid %23355a66}
.PF{height:100%25;width:0%25;background:%23e06c75;border-radius:1px;transition:width 0.8s cubic-bezier(0.4,0,0.2,1)}
.E{font-size:10px;color:%236b8a94;margin-top:10px;min-height:12px;font-variant-numeric:tabular-nums}
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
        backgroundColor: '#282c34', autoHideMenuBar: true,
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


// ── Browser Tool extensions (ad block, etc.) ────────────────────────────────────
//
// Loads any unpacked Chrome extension found in ExtensionsDirectory into the
// Browser Tool's session/partition. Drop in something like uBlock Origin Lite
// (unpacked, MV3) and it'll be picked up automatically next launch — no code
// changes needed per-extension.

let ExtensionsLoaded = false;
let ExtensionsLoadedPromise = null;

// ── Network-level ad blocker (backstop) ─────────────────────────────────────
//
// uBlock Origin's MV2 background page throws on load under Electron (see
// "Cannot read properties of undefined (reading 'split')" in the debug log)
// because Electron's webRequest/extension support targets MV3's
// declarativeNetRequest, not MV2's blocking webRequest listeners — so its
// filter lists never actually engage even though loadExtension() succeeds.
// This blocks the same ad/tracker domains directly at the request layer on
// BrowserPartition's session, independent of whether the extension itself is
// working, so scraping/screenshot output stays free of ad markup regardless.
const AdBlockDomainPatterns = [
    '*://*.magsrv.com/*',
    '*://*.bkcdn.net/*',
    '*://*.exoclick.com/*',
    '*://*.gamingadult.com/*',
    '*://*.happyleafmotion.com/*',
    '*://*/*adhelper.js*',
];

let NetworkAdBlockerInstalled = false;

function InstallNetworkAdBlocker() {
    if (NetworkAdBlockerInstalled == true) { return; }
    NetworkAdBlockerInstalled = true;

    try {
        const Sess = session.fromPartition(BrowserPartition);
        Sess.webRequest.onBeforeRequest(
            { urls: AdBlockDomainPatterns },
            (Details, Callback) => {
                Log('[BrowserTool] ad-blocked:', Details.url);
                Callback({ cancel: true });
            }
        );
    } catch (BlockerErr) {
        Log('[BrowserTool] InstallNetworkAdBlocker failed:', BlockerErr.message);
    }
}


function LoadBrowserExtensions() {
    if (ExtensionsLoadedPromise != null) { return ExtensionsLoadedPromise; }
    ExtensionsLoaded = true;
    ExtensionsLoadedPromise = (async () => {
        InstallNetworkAdBlocker();

        if (FileSystem.existsSync(ExtensionsDirectory) == false) {
            try { FileSystem.mkdirSync(ExtensionsDirectory, { recursive: true }); } catch { }
            return;
        }

        const Sess = session.fromPartition(BrowserPartition);
        const Loader = Sess.extensions != null ? Sess.extensions : Sess;
        let Entries = [];
        try { Entries = FileSystem.readdirSync(ExtensionsDirectory, { withFileTypes: true }); }
        catch (ReadErr) { console.error('[BrowserTool] Could not read extensions directory:', ReadErr.message); return; }

        for (const Entry of Entries) {
            if (Entry.isDirectory() == false) { continue; }

            const ExtensionPath = Path.join(ExtensionsDirectory, Entry.name);
            const ManifestPath  = Path.join(ExtensionPath, 'manifest.json');
            if (FileSystem.existsSync(ManifestPath) == false) { continue; }

            try {
                const Loaded = await Loader.loadExtension(ExtensionPath, { allowFileAccess: true });
                Log('[BrowserTool] Loaded extension:', Loaded.name, Loaded.version, 'from', Entry.name);
            } catch (LoadErr) {
                Log('[BrowserTool] Failed to load extension', Entry.name, '-', LoadErr.message);
            }
        }
    })();
    return ExtensionsLoadedPromise;
}

// Resolve a usable icon for an extension's manifest (MV3 `action`, MV2
// `browser_action`, or a bare `icons` map) into a base64 data URL. Data URLs
// are used instead of chrome-extension:// src so the icon still renders even
// on pages with a strict img-src CSP.
function GetExtensionIconDataUrl(Extension) {
    try {
        const Manifest  = Extension.manifest || {};
        const ActionDef = Manifest.action || Manifest.browser_action || {};
        const IconRef   = ActionDef.default_icon || Manifest.icons || null;
        if (IconRef == null) { return null; }

        let IconRelPath = null;
        if (typeof IconRef === 'string') {
            IconRelPath = IconRef;
        } else {
            const Sizes = Object.keys(IconRef).map(Number).filter((N) => isNaN(N) == false).sort((A, B) => A - B);
            const Preferred = Sizes.find((Size) => Size >= 32) || Sizes[Sizes.length - 1];
            IconRelPath = IconRef[String(Preferred)] || Object.values(IconRef)[0];
        }
        if (IconRelPath == null) { return null; }

        const IconFullPath = Path.join(Extension.path, IconRelPath);
        if (FileSystem.existsSync(IconFullPath) == false) { return null; }

        const IconBuffer = FileSystem.readFileSync(IconFullPath);
        const Extname = Path.extname(IconFullPath).toLowerCase();
        const Mime = Extname === '.svg' ? 'image/svg+xml' : (Extname === '.jpg' || Extname === '.jpeg' ? 'image/jpeg' : 'image/png');
        return `data:${Mime};base64,${IconBuffer.toString('base64')}`;
    } catch (IconErr) {
        return null;
    }
}

ipcMain.handle('ody-navigate', (Event, Url) => {
    console.log('[BrowserTool] ody-navigate requested:', Url);
    try {
        if (BrowserToolWindow == null || BrowserToolWindow.isDestroyed()) {
            console.error('[BrowserTool] ody-navigate failed: Browser Tool window is not open.');
            return { ok: false, error: 'Browser window is not open.' };
        }

        const FinalUrl = BustFileCache(Url);
        Log('[BrowserTool] ody-navigate:', Url, '->', FinalUrl);
        EnsureNavPreload();
        BrowserToolWindow.webContents.loadURL(FinalUrl);
        return { ok: true };
    } catch (NavErr) {
        console.error('[BrowserTool] ody-navigate failed:', NavErr.message);
        return { ok: false, error: NavErr.message };
    }
});

ipcMain.handle('ody-list-extensions', async () => {
    try {
        await LoadBrowserExtensions();
        const Sess = session.fromPartition(BrowserPartition);
        const All = Sess.extensions != null
            ? Sess.extensions.getAllExtensions()
            : (typeof Sess.getAllExtensions === 'function' ? Sess.getAllExtensions() : []);
        Log('[BrowserTool] ody-list-extensions ->', All.length, 'extension(s) found');

        const Extensions = All.map((Extension) => {
            const Manifest  = Extension.manifest || {};
            const ActionDef = Manifest.action || Manifest.browser_action || {};
            return {
                id: Extension.id,
                name: Manifest.name || Extension.id,
                version: Manifest.version || '',
                description: Manifest.description || '',
                manifestVersion: Manifest.manifest_version || null,
                icon: GetExtensionIconDataUrl(Extension),
                path: Extension.path,
                hasPopup: !!ActionDef.default_popup,
            };
        });

        return { folder: ExtensionsDirectory, extensions: Extensions };
    } catch (ListErr) {
        Log('[BrowserTool] Failed to list extensions:', ListErr.message);
        return { folder: ExtensionsDirectory, extensions: [] };
    }
});

// Opens an extension's default_popup as a real chrome-extension:// window in
// the same partition/session the extension was loaded into — this is what
// gives the popup actual access to chrome.* APIs (chrome.runtime,
// chrome.storage, chrome.tabs, etc.), unlike just loading popup.html as a
// plain file:// page. One popup window at a time; reuses/refocuses if
// already open for the same extension, closes any other extension's popup
// first (mimics normal browser behaviour of one open popup at a time).
let ExtensionPopupWindow = null;
let ExtensionPopupExtensionId = null;

ipcMain.handle('ody-open-extension-popup', async (Event, ExtensionId) => {
    try {
        await LoadBrowserExtensions();
        const Sess = session.fromPartition(BrowserPartition);
        const All = Sess.extensions != null
            ? Sess.extensions.getAllExtensions()
            : (typeof Sess.getAllExtensions === 'function' ? Sess.getAllExtensions() : []);
        const Extension = All.find((Ext) => Ext.id === ExtensionId);
        if (Extension == null) {
            Log('[BrowserTool] ody-open-extension-popup: extension not found:', ExtensionId);
            return { ok: false, error: 'Extension not found: ' + ExtensionId };
        }

        const Manifest  = Extension.manifest || {};
        const ActionDef = Manifest.action || Manifest.browser_action || {};
        const PopupPath = ActionDef.default_popup;
        Log('[BrowserTool] ody-open-extension-popup:', ExtensionId, '(' + (Manifest.name || '?') + ')',
            'manifest_version:', Manifest.manifest_version, 'default_popup:', PopupPath);
        if (!PopupPath) {
            Log('[BrowserTool] ody-open-extension-popup: no default_popup declared for', ExtensionId);
            return { ok: false, error: 'Extension has no default_popup: ' + ExtensionId };
        }

        if (ExtensionPopupWindow != null && !ExtensionPopupWindow.isDestroyed()) {
            const WasSameExtension = ExtensionPopupExtensionId === ExtensionId;
            ExtensionPopupWindow.close();
            ExtensionPopupWindow = null;
            ExtensionPopupExtensionId = null;
            if (WasSameExtension) {
                // Clicking the same extension's icon again while its popup is
                // already open just closes it — standard toggle behaviour.
                Log('[BrowserTool] ody-open-extension-popup: toggled closed for', ExtensionId);
                return { ok: true, toggledClosed: true };
            }
        }

        const PopupUrl = 'chrome-extension://' + ExtensionId + '/' + PopupPath.replace(/^\//, '');

        const PopupWin = new BrowserWindow({
            width: 420, height: 700, resizable: true, frame: true, show: false,
            title: Manifest.name || ExtensionId, autoHideMenuBar: true,
            webPreferences: {
                nodeIntegration: false, contextIsolation: true, sandbox: false,
                partition: BrowserPartition,
            },
        });

        // Persistent logging for this popup's own load lifecycle — without
        // this, a popup that opens but fails to actually render its content
        // (bad chrome-extension:// resolution, a script error inside the
        // popup, MV2 API gaps, etc.) looks identical from the renderer side
        // to one that opened successfully, since the IPC call itself still
        // resolves { ok: true }.
        PopupWin.webContents.on('did-finish-load', () => {
            Log('[BrowserTool] popup did-finish-load:', PopupUrl);
        });
        PopupWin.webContents.on('did-fail-load', (Event2, ErrorCode, ErrorDescription, ValidatedUrl) => {
            Log('[BrowserTool] popup did-fail-load:', ValidatedUrl, 'code:', ErrorCode, ErrorDescription);
        });
        PopupWin.webContents.on('console-message', (Event2, Level, Message, Line, SourceId) => {
            Log('[BrowserTool] popup console (' + ExtensionId + '):', Message, '(' + SourceId + ':' + Line + ')');
        });
        PopupWin.webContents.on('render-process-gone', (Event2, Details) => {
            Log('[BrowserTool] popup render-process-gone (' + ExtensionId + '):', Details.reason);
        });

        Log('[BrowserTool] opening popup window:', PopupUrl);
        PopupWin.loadURL(PopupUrl);
        PopupWin.once('ready-to-show', () => { PopupWin.show(); });
        // Stays open until the user closes it manually (normal window
        // behaviour) — previously this closed on blur to mimic a real
        // browser's transient popup, but that made it impossible to even
        // see whether the popup rendered correctly before it vanished.
        PopupWin.on('closed', () => {
            if (ExtensionPopupWindow === PopupWin) {
                ExtensionPopupWindow = null;
                ExtensionPopupExtensionId = null;
            }
        });

        ExtensionPopupWindow = PopupWin;
        ExtensionPopupExtensionId = ExtensionId;

        return { ok: true };
    } catch (PopupErr) {
        Log('[BrowserTool] ody-open-extension-popup failed:', PopupErr.message);
        return { ok: false, error: PopupErr.message };
    }
});


// ── Browser Tool window ───────────────────────────────────────────────────────

function CreateBrowserToolWindow(StartUrl) {
    if (BrowserToolWindow != null && !BrowserToolWindow.isDestroyed()) {
        BrowserToolWindow.focus();
        if (StartUrl) {
            const Url = NormaliseUrl(StartUrl);
            if (Url) { EnsureNavPreload(); BrowserToolWindow.webContents.loadURL(Url); }
        }
        return BrowserToolWindow;
    }

    const IconPath = FindIcon();
    const HomeUrl  = GetHomePageUrl();
    const LoadUrl  = StartUrl ? (NormaliseUrl(StartUrl) || HomeUrl) : HomeUrl;

    console.log('[BrowserTool] Creating window with preload:', NavPreloadPath,
        '(exists on disk:', FileSystem.existsSync(NavPreloadPath), ')');

    const Win = new BrowserWindow({
        width: 1200, height: 840, minWidth: 600, minHeight: 400,
        title: 'Odysseus Browser Tool', icon: IconPath || undefined,
        backgroundColor: '#282c34', autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: false,   // preload needs to expose globals to page JS
            sandbox: false,
            partition: BrowserPartition,
            webSecurity: false,        // allow mixed/cross-origin content
            preload: NavPreloadPath,   // nav bar injected before any page code runs
            // Passed once at window creation, read synchronously by the preload
            // via process.argv — avoids racing a separate executeJavaScript
            // injection against the page's own load timing on every navigation.
            additionalArguments: [
                '--ody-home-url=' + encodeURIComponent(HomeUrl),
                '--ody-extensions-url=' + encodeURIComponent(GetExtensionsPageUrl() || ''),
            ],
        },
    });

    // Electron's own signal for "the preload script failed to load or threw".
    // This fires for failures our in-script try/catch can't see (file missing,
    // parse errors, etc) — if the nav bar is missing, this is the first place
    // to look in the terminal/log output.
    //
    // Self-healing: a missing preload file usually means something external
    // (most likely AV/Defender quarantining a dynamically-written .js file in
    // %TEMP%) deleted it between writes. Rather than leave the page silently
    // broken (no nav bar, no _odyIpcRenderer bridge) until the next manual
    // navigation, rewrite the file immediately and reload the current page
    // once so the preload actually attaches this time.
    let LastPreloadRecoveryAt = 0;
    Win.webContents.on('preload-error', (Event, PreloadPath, LoadError) => {
        console.error('[BrowserTool] PRELOAD FAILED TO LOAD:', PreloadPath, '-', LoadError.message);
        const Now = Date.now();
        if (Now - LastPreloadRecoveryAt < 5000) {
            // Avoid a reload loop if the file keeps disappearing immediately
            // (e.g. an AV product re-quarantining it on every write).
            Log('[BrowserTool] preload-error recovery skipped (recovered too recently) — check AV/quarantine.');
            return;
        }
        LastPreloadRecoveryAt = Now;
        Log('[BrowserTool] Attempting preload recovery: rewriting file and reloading.');
        EnsureNavPreload();
        if (!Win.isDestroyed()) { Win.webContents.reloadIgnoringCache(); }
    });

    EnsureNavPreload();
    Win.loadURL(BustFileCache(LoadUrl));

    // Update window title
    Win.webContents.on('page-title-updated', (Event, Title) => {
        if (!Win.isDestroyed()) {
            Win.setTitle(Title ? `${Title} \u2014 Odysseus Browser` : 'Odysseus Browser Tool');
        }
    });

    // Strict popup blocking: deny every window.open()/target=_blank attempt
    // outright. We deliberately do NOT fall back to loadURL(url) here — that
    // previous behaviour redirected the current page to whatever a popup
    // tried to open, which is exactly the ad/popunder hijack pattern this is
    // meant to stop. Legitimate same-tab navigation still works via normal
    // <a href> clicks and will-navigate; only new-window/new-tab requests are
    // intercepted here.
    Win.webContents.setWindowOpenHandler(({ url, disposition }) => {
        Log('[BrowserTool] blocked popup:', url, '(disposition:', disposition + ')');
        return { action: 'deny' };
    });

    Win.on('closed', () => { BrowserToolWindow = null; });

    BrowserToolWindow = Win;

    // Kept permanently (not temporary debug noise) — these only fire on
    // actual failures, so they're cheap and useful if navigation ever
    // breaks again without re-adding a debugging pass.
    Win.webContents.on('did-fail-load', (Event, ErrorCode, ErrorDescription, ValidatedUrl) => {
        Log('[BrowserTool] did-fail-load:', ValidatedUrl, 'code:', ErrorCode, ErrorDescription);
    });
    Win.webContents.on('render-process-gone', (Event, Details) => {
        Log('[BrowserTool] render-process-gone! reason:', Details.reason);
    });

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

        // Scraping benefits from extensions (ad blocking) being ready
        // before capture, unlike /open which needs to respond immediately.
        // Capped at 3s so a slow extension load can't stall scraping.
        await Promise.race([
            LoadBrowserExtensions(),
            new Promise((Resolve) => setTimeout(Resolve, 3000)),
        ]);

        const Win = new BrowserWindow({
            width: 1280, height: 900, show: false,
            webPreferences: { nodeIntegration: false, contextIsolation: true,
                sandbox: false, partition: BrowserPartition, webSecurity: false },
        });

        // Deny popups during scraping. Without this, an ad/popunder script on
        // the target page can open a second BrowserWindow that is never
        // tracked or destroyed (a leak), and can steal focus/load time away
        // from the page we actually want to capture.
        Win.webContents.setWindowOpenHandler(({ url, disposition }) => {
            Log('[BrowserTool] /scrape blocked popup:', url, '(disposition:', disposition + ')');
            return { action: 'deny' };
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

        await Promise.race([
            LoadBrowserExtensions(),
            new Promise((Resolve) => setTimeout(Resolve, 3000)),
        ]);

        const Win = new BrowserWindow({
            width: 1280, height: 900, show: false,
            webPreferences: { nodeIntegration: false, contextIsolation: true,
                sandbox: false, partition: BrowserPartition, webSecurity: false },
        });

        Win.webContents.setWindowOpenHandler(({ url, disposition }) => {
            Log('[BrowserTool] /search blocked popup:', url, '(disposition:', disposition + ')');
            return { action: 'deny' };
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

            // Block until extensions (uBlock Origin Lite, etc.) are loaded into
            // BrowserPartition's session before any endpoint below creates or
            // navigates a window. Without this, a request that arrives in the
            // brief window between app startup and LoadBrowserExtensions()
            // finishing would load its page with no ad/content blocking active
            // at all — the extension installs after the page already rendered.
            // LoadBrowserExtensions() caches its promise, so this is a no-op
            // await on every request after the first.
            // Kick off extension loading in the background — do NOT block
            // on it here. /open needs to respond immediately for the MCP
            // tool caller; waiting here (even with a timeout) delays every
            // request including /open, which is why /open calls appeared to
            // fail/hang after this was previously awaited unconditionally.
            // LoadBrowserExtensions() caches its promise, so this is cheap
            // to call on every request, and /scrape and /search explicitly
            // await it themselves below since those benefit from extensions
            // being ready before an automated capture is taken.
            LoadBrowserExtensions();

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
                    EnsureNavPreload();
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
                    EnsureNavPreload();
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
                    EnsureNavPreload();
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
                    EnsureNavPreload();
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
    LoadBrowserExtensions().catch((Err) => { console.error('[BrowserTool] Extension load failed:', Err.message); });
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