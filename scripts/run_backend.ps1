$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$VenvPython = Join-Path $ProjectRoot ".venv\Scripts\python.exe"

Set-Location $ProjectRoot

if (!(Test-Path $VenvPython)) {
  Write-Host "Creating local Python virtual environment..."
  python -m venv .venv
}

try {
  & $VenvPython -c "import langgraph" | Out-Null
} catch {
  Write-Host "Installing Python backend dependencies..."
  & $VenvPython -m pip install -r requirements.txt
}

& $VenvPython -m koc_backend
