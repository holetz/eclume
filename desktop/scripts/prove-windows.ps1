# Voice-note proof on a Windows workstation (holetz/eclume#40, docs/project/estacao-windows.md):
#   1. downloads the NSIS installer of the version published under /downloads and installs it silently;
#   2. opens the app with the WebView2 debugging port and captures the first run, which must
#      show the server bundled in the installer ("Veio com este instalador");
#   3. signs in with the test account (ECLUME_PROOF_EMAIL and ECLUME_PROOF_PASSWORD; ECLUME_PROVA_* still works);
#   4. records a note through the global shortcut Ctrl+Alt+N, speaking a text with the Windows voice
#      on the speakers, and waits for it to stop on silence and upload;
#   5. checks through the API (prove_note.py) that the note is in the library with kind=note,
#      eclume-desktop/<version> and transcribed.
# The screenshots and the summary go to .logs/prove-windows/. Exit 0 when everything passes; 2 when
# the note was discarded for lack of voice (muted microphone: the proof needs a person).
#
# Usage: powershell -NoProfile -File desktop/scripts/prove-windows.ps1 [-Server <url>] [-Version <x.y.z>]
# (-Version defaults to the one in tauri.conf.json)
param(
    [string]$Server = "https://192.168.15.199:8443",
    [string]$Version = (Get-Content -Raw (Join-Path $PSScriptRoot "..\src-tauri\tauri.conf.json") | ConvertFrom-Json).version,
    [int]$Port = 9229
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$output = Join-Path $root ".logs\prove-windows"
New-Item -ItemType Directory -Force $output | Out-Null
$cdp = Join-Path $root "desktop\scripts\cdp.mjs"
$data = Join-Path $env:APPDATA "io.github.holetz.eclume"
$exe = Join-Path $env:LOCALAPPDATA "eclume\eclume-desktop.exe"
$env:CDP_PORT = "$Port"

# ECLUME_PROVA_EMAIL/ECLUME_PROVA_SENHA are the deprecated pt-BR names, still read.
$email = if ($env:ECLUME_PROOF_EMAIL) { $env:ECLUME_PROOF_EMAIL } else { $env:ECLUME_PROVA_EMAIL }
$password = if ($env:ECLUME_PROOF_PASSWORD) { $env:ECLUME_PROOF_PASSWORD } else { $env:ECLUME_PROVA_SENHA }
if (-not $email -or -not $password) { throw "set ECLUME_PROOF_EMAIL and ECLUME_PROOF_PASSWORD" }

function Step([string]$text) { Write-Host "== $text" }

# Evaluates in the window through CDP and returns the value already parsed from JSON.
function Window([string]$expression) {
    $text = & node $cdp eval $expression
    if ($LASTEXITCODE -ne 0) { throw "CDP failed on: $expression" }
    return (($text -join "`n") | ConvertFrom-Json)
}

function Capture([string]$name) {
    & node $cdp screenshot (Join-Path $output "$name.png") | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "failed to capture $name" }
}

# Repeats `condition` every second until it returns something truthy, or fails with `description`.
function Wait-For([scriptblock]$condition, [int]$seconds, [string]$description) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $value = & $condition
            if ($value) { return $value }
        } catch {
            Write-Verbose $_
        }
        Start-Sleep -Seconds 1
    }
    throw "timed out: $description"
}

# A text inside a JS expression, in base64: PowerShell 5.1 mangles double quotes in native
# program arguments, so the expression carries none.
function Js([string]$text) {
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text))
    return "new TextDecoder().decode(Uint8Array.from(atob('$b64'), (c) => c.charCodeAt(0)))"
}

Step "1. installer $Version from $Server/downloads"
# instaladores.json and its pt-BR keys are the published download format: they stay.
$listing = (& curl.exe -sk --ssl-no-revoke "$Server/downloads/instaladores.json") -join "`n" | ConvertFrom-Json
if ($listing.versao -ne $Version) { throw "the server publishes $($listing.versao), not $Version" }
$nsis = $listing.instaladores | Where-Object { $_.plataforma -eq "windows" -and $_.tipo -eq "nsis" } | Select-Object -First 1
if (-not $nsis) { throw "instaladores.json without the Windows NSIS installer" }
$installer = Join-Path $output $nsis.arquivo
& curl.exe -sk --ssl-no-revoke -o $installer $nsis.url
if ($LASTEXITCODE -ne 0) { throw "failed to download $($nsis.url)" }
$hash = (Get-FileHash $installer -Algorithm SHA256).Hash.ToLower()
if ($hash -ne $nsis.sha256) { throw "installer SHA-256 does not match" }
Get-Process eclume-desktop -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
Start-Process $installer -ArgumentList "/S" -Wait
$installed = (Get-Item $exe).VersionInfo.ProductVersion
Write-Host "   installed: $exe ($installed)"
Get-Process eclume-desktop -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

Step "2. first run through CDP (port $Port)"
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port"
Start-Process $exe
Wait-For { Window "document.readyState === 'complete' && !!window.__TAURI__" } 60 "the window to open" | Out-Null
$state = Wait-For { Window "window.__TAURI__.core.invoke('status')" } 30 "the app status"
if ($state.connection -ne "first_run") {
    # A PAT from an earlier version keeps the app connected: the proof signs in through the Server tab.
    Write-Host "   current connection: $($state.connection); opening 'Entrar com e-mail e senha'"
    Window "document.querySelector('#open-settings').click(); document.querySelector('[data-tab=server]').click(); document.querySelector('#server-sign-in').click(); true" | Out-Null
}
$server = Wait-For {
    Window "(() => { const c = document.querySelector('#first-run-servers .choice'); const b = document.querySelector('#first-run-sign-in'); return c && !b.disabled ? c.textContent.trim() : null })()"
} 60 "the server to appear and the CA to be pinned"
Capture "1-first-run"
Write-Host "   $server"
if ($server -notmatch "Veio com este instalador") { throw "first run did not show the bundled server: $server" }

Step "3. sign in as $email"
Window "(() => { document.querySelector('#first-run-email').value = $(Js $email); document.querySelector('#first-run-password').value = $(Js $password); document.querySelector('#first-run-sign-in-form').requestSubmit(); return true })()" | Out-Null
$state = Wait-For {
    $s = Window "window.__TAURI__.core.invoke('status')"
    if ($s.connection -eq "account") { $s }
} 60 "signing in to the account"
Write-Host "   connected: $($state.account.email) at $($state.web_url)"
Start-Sleep -Seconds 2
Capture "2-home"

Step "4. voice note through the Ctrl+Alt+N shortcut"
Add-Type -Namespace Eclume -Name Keyboard -MemberDefinition @'
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);
'@
function Shortcut([byte[]]$keys) {
    foreach ($k in $keys) { [Eclume.Keyboard]::keybd_event($k, 0, 0, [System.UIntPtr]::Zero) }
    [array]::Reverse($keys)
    foreach ($k in $keys) { [Eclume.Keyboard]::keybd_event($k, 0, 2, [System.UIntPtr]::Zero) }
}
$before = @(Window "window.__TAURI__.core.invoke('recordings', { limit: 50 })" | ForEach-Object { $_.id })
Shortcut ([byte[]](0x11, 0x12, 0x4E))  # Ctrl, Alt, N
Wait-For {
    $s = Window "window.__TAURI__.core.invoke('status')"
    $s.recording_kind -eq "note"
} 15 "the note to start through the shortcut" | Out-Null
Capture "3-note"
Add-Type -AssemblyName System.Speech
$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
$ptbr = $voice.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq "pt-BR" } | Select-Object -First 1
if ($ptbr) { $voice.SelectVoice($ptbr.VoiceInfo.Name) }
# The spoken text stays pt-BR: it is the content the pt-BR transcription is proved on.
$voice.Speak("Nota de teste do eclume. Lembrar de enviar o orçamento revisado para a Ana até sexta-feira e marcar a reunião de acompanhamento.")
Wait-For {
    $s = Window "window.__TAURI__.core.invoke('status')"
    $s.status -ne "recording"
} 40 "the note to stop on silence" | Out-Null
$note = Window "window.__TAURI__.core.invoke('recordings', { limit: 50 })" |
    Where-Object { $before -notcontains $_.id -and $_.kind -eq "note" } | Select-Object -First 1
if (-not $note) {
    Write-Host "!! the note was discarded: the microphone heard no voice (muted or no input)."
    Write-Host "!! repeat with a person speaking near the microphone after Ctrl+Alt+N."
    exit 2
}
Write-Host "   note $($note.id): $($note.duration_ms) ms"
$note = Wait-For {
    Window "window.__TAURI__.core.invoke('sync_now')" | Out-Null
    Window "window.__TAURI__.core.invoke('recordings', { limit: 50 })" |
        Where-Object { $_.id -eq $note.id -and $_.status -eq "synced" -and $_.remote_id }
} 180 "the note to upload to the server"
Write-Host "   on the server: $($note.remote_id)"
Capture "4-uploaded"

Step "5. the note in the library (API)"
$ca = Join-Path $data "servidor-ca.pem"
$arguments = @("run", "python", (Join-Path $root "desktop\scripts\prove_note.py"), "--server", $Server,
    "--recording", $note.remote_id, "--version", $Version)
if (Test-Path $ca) { $arguments += @("--ca", $ca) }
Push-Location $root
try {
    $summary = & uv @arguments
    $code = $LASTEXITCODE
} finally {
    Pop-Location
}
$summary | Set-Content -Encoding utf8 (Join-Path $output "note.json")
$summary | Write-Host
if ($code -ne 0) { throw "the note did not reach the library ready" }
Write-Host "== voice-note proof: ok ($output)"
