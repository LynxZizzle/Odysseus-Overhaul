<p align="center">
  <img src="docs/odysseus-wordmark.png" alt="Odysseus" width="238">
</p>

<p align="center">
  A self-hosted AI workspace From pewdiepie<br>
  This Overhaul Adds<br>
  UI Bug Fixes<br>
  Media Embedding Overhaul So You Can Preview Video/Audio/Images When Embedded (CSP Blocks And Hotlink Protection Fixes)<br>
  Tools Overhaul So You Can Properly Disable Built-In MCP Tools As Well As Regular MCP Tools And Properly Disable Web_Fetch And Web_Search<br>
  Electron App + A Browser To Prevent AI Confusion When Using MCP Tools (Like AnythingLLM)
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="docs/setup.md">Setup Guide</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> ·
  <a href="ROADMAP.md">Roadmap</a>
</p>

<p align="center">
  <a href="https://repology.org/project/odysseus-ai/versions"><img src="https://repology.org/badge/vertical-allrepos/odysseus-ai.svg" alt="Packaging status"></a>
</p>

<p align="center">
  <img src="docs/odysseus-browser.jpg" alt="Odysseus interface">
</p>

---

## Quick Start

Follow The Original Odysseus Setup
```bash
git clone https://github.com/LynxZizzle/Odysseus-Overhaul.git
cd Odysseus-Overhaul
powershell -ExecutionPolicy Bypass -File .\launch-windows.ps1
```

Electron Setup
```bash
Go To Windows Settings And Enable Developer Mode
Install Node.JS
cd odysseus\Electron
npm run build
Move All Files From Electron\dist\win-unpacked Into Odysseus
```

---

## License

AGPL-3.0-or-later -- see [LICENSE](LICENSE) and [ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md).
