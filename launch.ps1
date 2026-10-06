# ClaudeDesk launcher: start the local server if needed, then open an app-mode browser window.
# Run through launch.vbs so no console window flashes.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 17860
$url = "http://127.0.0.1:$port/"

function Test-Server {
    try {
        $r = Invoke-RestMethod -Uri "${url}api/health" -TimeoutSec 2
        return $r.app -eq 'claudedesk'
    } catch { return $false }
}

if (-not (Test-Server)) {
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) { $node = "$env:ProgramFiles\nodejs\node.exe" }
    if (-not (Test-Path $node)) {
        Add-Type -AssemblyName PresentationFramework
        [System.Windows.MessageBox]::Show('Node.js not found. Install it from https://nodejs.org first.', 'ClaudeDesk') | Out-Null
        exit 1
    }
    $log = Join-Path $root 'data\server.log'
    New-Item -ItemType Directory -Force (Join-Path $root 'data') | Out-Null
    Start-Process -FilePath $node -ArgumentList "`"$(Join-Path $root 'server.js')`"" -WorkingDirectory $root `
        -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError "$log.err"
    $ok = $false
    for ($i = 0; $i -lt 50; $i++) {
        Start-Sleep -Milliseconds 200
        if (Test-Server) { $ok = $true; break }
    }
    if (-not $ok) {
        Add-Type -AssemblyName PresentationFramework
        $err = if (Test-Path "$log.err") { Get-Content "$log.err" -Raw } else { '' }
        [System.Windows.MessageBox]::Show("ClaudeDesk server did not start.`n$err", 'ClaudeDesk') | Out-Null
        exit 1
    }
}

$browsers = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$browser = $browsers | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($browser) {
    # Separate profile so the window gets its own taskbar entry and storage
    $profileDir = Join-Path $root 'data\browser'
    Start-Process -FilePath $browser -ArgumentList @("--app=$url", "--user-data-dir=`"$profileDir`"", '--no-first-run', '--no-default-browser-check', '--window-size=1280,860')
} else {
    Start-Process $url
}
