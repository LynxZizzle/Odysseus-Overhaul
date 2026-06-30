# Odysseus Desktop — Setup & Build

## Prerequisites
- Node.js installed (https://nodejs.org) — LTS version
- Odysseus already set up at `C:\Users\User\odysseus` with a working venv

---

## One-time setup

1. Copy this entire `odysseus-electron` folder anywhere on your PC.

2. Copy the Odysseus icon into this folder (next to package.json):
   ```
   copy C:\Users\User\odysseus\static\icons\icon-192.png icon.png
   ```

3. Install dependencies:
   ```
   npm install
   ```

---

## Run without building (dev mode)

```
npm start
```

This launches the app immediately. The server starts in the background,
a splash screen shows while it boots, then the main window opens.

---

## Build a proper .exe installer

```
npm run build
```

Output goes to `dist\`:
- `Odysseus Setup 1.0.0.exe` — NSIS installer (installs to Program Files, adds Start Menu + Desktop shortcut)
- `Odysseus 1.0.0.exe` — portable single-file exe (no install needed)

---

## How it works

- Double-clicking the app (or installer shortcut) launches Electron
- Electron spawns `venv\Scripts\python.exe -m uvicorn app:app` in the background
  pointing at your existing `C:\Users\User\odysseus` directory
- A splash screen polls `http://127.0.0.1:7000/api/version` until the server is ready
- The main window then loads Odysseus in a full Chromium window (no browser chrome/tabs)
- Closing the window minimizes to the system tray
- Right-click the tray icon → Quit to fully shut down (kills the server too)
- "Open in browser" in the tray menu opens your real browser at localhost:7000

---

## Changing the Odysseus path

If Odysseus is installed somewhere other than `C:\Users\User\odysseus`,
edit line 5 of `src/main.js`:

```js
const ODYSSEUS_DIR = path.join(__dirname, '..', '..');
```

Change it to an absolute path, e.g.:

```js
const ODYSSEUS_DIR = 'D:\\apps\\odysseus';
```

Then rebuild.

---

## Troubleshooting

**Splash screen hangs / timeout dialog appears**
→ The venv Python couldn't start uvicorn. Run `launch-windows.ps1` manually
  first to confirm the server works, then try the app again.

**"Python not found" error**
→ Make sure `C:\Users\User\odysseus\venv\Scripts\python.exe` exists.
  Run `launch-windows.ps1` to recreate the venv if needed.

**Port 7000 already in use**
→ Kill any existing Odysseus process, or change PORT in `src/main.js`
  and in `launch-windows.ps1` to match.
