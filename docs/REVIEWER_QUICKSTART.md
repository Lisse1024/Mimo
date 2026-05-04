# Mimo Reviewer Quickstart

This guide is for reviewers who download the GitHub Release package and want to run Mimo locally on Windows.

## What Is in the Release ZIP

The reviewer ZIP contains:

```text
Mimo_0.1.0_x64-setup.exe          Windows desktop installer
Mimo-v0.1.0-source.zip            Source package for the local backend and gateway
.env                              Reviewer environment file
README.md                         Project overview
KOC_AGENT_PRODUCT_DESCRIPTION.docx Product description document
START_MIMO_REVIEW.ps1             One-click local runtime launcher
```

## Required Runtime

Install these before running the demo:

- Windows 10 or Windows 11
- Python 3.10+
- Node.js 20+

Rust is only needed if you want to rebuild the desktop installer. It is not required for normal review usage.

## Start the Demo

1. Extract the release ZIP.
2. Run `Mimo_0.1.0_x64-setup.exe` and install Mimo.
3. Right-click `START_MIMO_REVIEW.ps1` and choose **Run with PowerShell**.
4. The script will:
   - extract `Mimo-v0.1.0-source.zip` into `Mimo-source`;
   - copy `.env` into the source directory;
   - create a Python virtual environment if needed;
   - install Python and Node dependencies if needed;
   - start the Python KOC backend on `127.0.0.1:8010`;
   - start the Node gateway on `127.0.0.1:8787`;
   - try to open the installed Mimo desktop app.

Keep the backend and gateway PowerShell windows open while reviewing the app.

## Manual Commands

If the launcher script is blocked by Windows policy, run these commands in PowerShell from the extracted release folder:

```powershell
Expand-Archive .\Mimo-v0.1.0-source.zip .\Mimo-source -Force
Copy-Item .\.env .\Mimo-source\.env -Force
Set-Location .\Mimo-source
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
npm install
npm run dev:koc
```

Open a second PowerShell window in `Mimo-source`:

```powershell
npm run dev:server
```

Then launch Mimo from the Start Menu.

## Review Flow

Recommended review scenario:

1. Open a short-video homepage or a current video page in the browser.
2. Launch Mimo.
3. Use the screenshot or recording action in the desktop app.
4. Ask for either:
   - current video analysis; or
   - homepage diagnosis.
5. Check that the response:
   - cites visible evidence;
   - distinguishes evidence from inference;
   - avoids unsupported claims;
   - proposes a measurable next action;
   - keeps evidence boundaries visible.

## Troubleshooting

If the desktop app opens but cannot analyze content, confirm that:

- the Python backend is running at `http://127.0.0.1:8010`;
- the Node gateway is running at `http://127.0.0.1:8787`;
- `.env` exists inside `Mimo-source`;
- the reviewer model key in `.env` is valid;
- Windows Firewall did not block local Node or Python processes.

If dependency installation fails, run PowerShell as Administrator and retry `START_MIMO_REVIEW.ps1`.
