param(
  [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"

$releaseRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if ((Split-Path -Leaf $releaseRoot) -eq "scripts") {
  $releaseRoot = Split-Path -Parent $releaseRoot
}

$sourceZip = Join-Path $releaseRoot "Mimo-v0.1.0-source.zip"
$sourceDir = Join-Path $releaseRoot "Mimo-source"
$envFile = Join-Path $releaseRoot ".env"
$repoUrl = "https://github.com/Lisse1024/Mimo.git"

Write-Host "Mimo reviewer launcher" -ForegroundColor Cyan

if (!(Test-Path $sourceDir)) {
  if (Test-Path $sourceZip) {
    Write-Host "Extracting source package..."
    Expand-Archive -Path $sourceZip -DestinationPath $sourceDir -Force
  } else {
    Write-Host "Source package not found. Cloning Mimo from GitHub..."
    git clone $repoUrl $sourceDir
  }
}

if (Test-Path $envFile) {
  Copy-Item $envFile (Join-Path $sourceDir ".env") -Force
  Write-Host "Copied reviewer .env into Mimo-source."
} else {
  Write-Warning "No .env file found next to this script. Live model calls may not work until .env is configured."
}

Push-Location $sourceDir
try {
  if (!(Test-Path ".venv\Scripts\python.exe")) {
    Write-Host "Creating Python virtual environment..."
    python -m venv .venv
  }

  if (!$SkipInstall) {
    Write-Host "Installing Python dependencies..."
    .\.venv\Scripts\python.exe -m pip install -r requirements.txt

    if (!(Test-Path "node_modules")) {
      Write-Host "Installing Node dependencies..."
      npm.cmd install
    }
  }

  Write-Host "Starting Python backend and Node gateway in separate windows..."
  Start-Process powershell -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", "Set-Location '$sourceDir'; npm.cmd run dev:koc"
  Start-Process powershell -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", "Set-Location '$sourceDir'; npm.cmd run dev:server"

  Start-Sleep -Seconds 5

  $candidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\Mimo\Mimo.exe"),
    (Join-Path $env:ProgramFiles "Mimo\Mimo.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Mimo\Mimo.exe")
  )
  $app = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if ($app) {
    Write-Host "Opening installed Mimo app..."
    Start-Process $app
  } else {
    Write-Warning "Mimo.exe was not found in the default install locations. Please install Mimo_0.1.0_x64-setup.exe, then open Mimo from the Start Menu."
  }

  Write-Host ""
  Write-Host "Keep the backend and gateway windows open while reviewing Mimo." -ForegroundColor Green
  Write-Host "Backend: http://127.0.0.1:8010"
  Write-Host "Gateway: http://127.0.0.1:8787"
} finally {
  Pop-Location
}
