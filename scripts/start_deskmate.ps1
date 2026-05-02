$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

if (!(Test-Path "node_modules")) {
  Write-Host "Installing Node dependencies..."
  npm install
}

if (!(Test-Path ".venv\Scripts\python.exe")) {
  Write-Host "Creating local Python virtual environment..."
  python -m venv .venv
}

try {
  & ".\.venv\Scripts\python.exe" -c "import langgraph" | Out-Null
} catch {
  Write-Host "Installing Python backend dependencies..."
  & ".\.venv\Scripts\python.exe" -m pip install -r requirements.txt
}

Write-Host "Starting KOC LangGraph backend, Node gateway, and DeskMate desktop app..."
npm run dev
