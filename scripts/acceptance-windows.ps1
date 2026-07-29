$ErrorActionPreference = "Stop"
$installer = Get-ChildItem "release/desktop/Worklog-*-Windows-x64.exe" | Select-Object -First 1
if (-not $installer) { throw "Windows installer not found" }

Write-Host "Installing $($installer.Name) silently"
Start-Process -FilePath $installer.FullName -ArgumentList "/S" -Wait
$installDir = Join-Path $env:LOCALAPPDATA "Programs\Worklog"
$executable = Join-Path $installDir "Worklog.exe"
if (-not (Test-Path $executable)) { throw "Installed Worklog.exe not found at $executable" }

$env:WORKLOG_PORT = "4428"
$env:WORKLOG_DATA_DIR = Join-Path $env:RUNNER_TEMP "worklog-installed-smoke"
$env:WORKLOG_DISABLE_BACKGROUND = "1"
$process = Start-Process -FilePath $executable -ArgumentList "--hidden" -PassThru
try {
  $ready = $false
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    try {
      $status = Invoke-RestMethod -Uri "http://127.0.0.1:4428/api/status" -TimeoutSec 2
      if ($status.running -and $status.capabilities.platform -eq "windows") { $ready = $true; break }
    } catch { Start-Sleep -Milliseconds 500 }
  }
  if (-not $ready) { throw "Installed Windows app did not become ready" }
  Write-Host "✓ installed Windows app started and exposed a healthy local API"
} finally {
  Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
}

$uninstaller = Join-Path $installDir "Uninstall Worklog.exe"
if (-not (Test-Path $uninstaller)) { throw "Uninstaller not found" }
Start-Process -FilePath $uninstaller -ArgumentList "/S" -Wait
if (Test-Path $executable) { throw "Silent uninstall left Worklog.exe behind" }
Write-Host "✓ Windows silent install/start/uninstall acceptance"
