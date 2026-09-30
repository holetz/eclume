# Prova da nota por voz numa estação Windows (holetz/eclume#40, docs/project/estacao-windows.md):
#   1. baixa o NSIS da versão publicada em /downloads e instala em silêncio;
#   2. abre o app com a porta de depuração do WebView2 e captura a primeira execução, que precisa
#      mostrar o servidor embutido no instalador ("Veio com este instalador");
#   3. entra com a conta de teste (ECLUME_PROVA_EMAIL e ECLUME_PROVA_SENHA);
#   4. grava uma nota pelo atalho global Ctrl+Alt+N, falando um texto pela voz do Windows nos
#      alto-falantes, e espera ela parar no silêncio e subir;
#   5. confere pela API (prova_nota.py) que a nota está na biblioteca com kind=note,
#      eclume-desktop/<versão> e transcribed.
# As capturas e o resumo ficam em .logs/prova-windows/. Saída 0 quando tudo passa; 2 quando a nota
# foi descartada por falta de voz (microfone mudo: a prova precisa de uma pessoa).
#
# Uso: powershell -NoProfile -File desktop/scripts/prova-windows.ps1 [-Servidor <url>] [-Versao <x.y.z>]
# (-Versao, por padrão, é a do tauri.conf.json)
param(
    [string]$Servidor = "https://192.168.15.199:8443",
    [string]$Versao = (Get-Content -Raw (Join-Path $PSScriptRoot "..\src-tauri\tauri.conf.json") | ConvertFrom-Json).version,
    [int]$Porta = 9229
)

$ErrorActionPreference = "Stop"
$raiz = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$saida = Join-Path $raiz ".logs\prova-windows"
New-Item -ItemType Directory -Force $saida | Out-Null
$cdp = Join-Path $raiz "desktop\scripts\cdp.mjs"
$dados = Join-Path $env:APPDATA "io.github.holetz.eclume"
$exe = Join-Path $env:LOCALAPPDATA "eclume\eclume-desktop.exe"
$env:CDP_PORT = "$Porta"

$email = $env:ECLUME_PROVA_EMAIL
$senha = $env:ECLUME_PROVA_SENHA
if (-not $email -or -not $senha) { throw "defina ECLUME_PROVA_EMAIL e ECLUME_PROVA_SENHA" }

function Passo([string]$texto) { Write-Host "== $texto" }

# Avalia na janela pelo CDP e devolve o valor já convertido de JSON.
function Janela([string]$expressao) {
    $texto = & node $cdp eval $expressao
    if ($LASTEXITCODE -ne 0) { throw "CDP falhou em: $expressao" }
    return (($texto -join "`n") | ConvertFrom-Json)
}

function Capturar([string]$nome) {
    & node $cdp screenshot (Join-Path $saida "$nome.png") | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "falha ao capturar $nome" }
}

# Repete `condicao` a cada segundo até ela devolver algo verdadeiro, ou falha com `descricao`.
function Esperar([scriptblock]$condicao, [int]$segundos, [string]$descricao) {
    $prazo = (Get-Date).AddSeconds($segundos)
    while ((Get-Date) -lt $prazo) {
        try {
            $valor = & $condicao
            if ($valor) { return $valor }
        } catch {
            Write-Verbose $_
        }
        Start-Sleep -Seconds 1
    }
    throw "tempo esgotado: $descricao"
}

# Um texto dentro de uma expressão JS, em base64: o PowerShell 5.1 estraga aspas duplas nos
# argumentos de programas nativos, então a expressão não leva nenhuma.
function Js([string]$texto) {
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($texto))
    return "new TextDecoder().decode(Uint8Array.from(atob('$b64'), (c) => c.charCodeAt(0)))"
}

Passo "1. instalador $Versao de $Servidor/downloads"
$lista = (& curl.exe -sk --ssl-no-revoke "$Servidor/downloads/instaladores.json") -join "`n" | ConvertFrom-Json
if ($lista.versao -ne $Versao) { throw "o servidor publica a $($lista.versao), não a $Versao" }
$nsis = $lista.instaladores | Where-Object { $_.plataforma -eq "windows" -and $_.tipo -eq "nsis" } | Select-Object -First 1
if (-not $nsis) { throw "instaladores.json sem o NSIS do Windows" }
$instalador = Join-Path $saida $nsis.arquivo
& curl.exe -sk --ssl-no-revoke -o $instalador $nsis.url
if ($LASTEXITCODE -ne 0) { throw "falha ao baixar $($nsis.url)" }
$hash = (Get-FileHash $instalador -Algorithm SHA256).Hash.ToLower()
if ($hash -ne $nsis.sha256) { throw "SHA-256 do instalador não confere" }
Get-Process eclume-desktop -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
Start-Process $instalador -ArgumentList "/S" -Wait
$instalada = (Get-Item $exe).VersionInfo.ProductVersion
Write-Host "   instalado: $exe ($instalada)"
Get-Process eclume-desktop -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

Passo "2. primeira execução pelo CDP (porta $Porta)"
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Porta"
Start-Process $exe
Esperar { Janela "document.readyState === 'complete' && !!window.__TAURI__" } 60 "a janela abrir" | Out-Null
$estado = Esperar { Janela "window.__TAURI__.core.invoke('status')" } 30 "o status do app"
if ($estado.connection -ne "first_run") {
    # Um PAT de uma versão anterior mantém o app conectado: a prova entra pela aba Servidor.
    Write-Host "   conexão atual: $($estado.connection); abrindo 'Entrar com e-mail e senha'"
    Janela "document.querySelector('#abrir-configuracoes').click(); document.querySelector('[data-aba=servidor]').click(); document.querySelector('#servidor-entrar').click(); true" | Out-Null
}
$servidor = Esperar {
    Janela "(() => { const c = document.querySelector('#bv-servidores .choice'); const b = document.querySelector('#bv-entrar'); return c && !b.disabled ? c.textContent.trim() : null })()"
} 60 "o servidor aparecer e a CA ser fixada"
Capturar "1-primeira-execucao"
Write-Host "   $servidor"
if ($servidor -notmatch "Veio com este instalador") { throw "a primeira execução não mostrou o servidor embutido: $servidor" }

Passo "3. entrar como $email"
Janela "(() => { document.querySelector('#bv-email').value = $(Js $email); document.querySelector('#bv-senha').value = $(Js $senha); document.querySelector('#bv-entrar-form').requestSubmit(); return true })()" | Out-Null
$estado = Esperar {
    $s = Janela "window.__TAURI__.core.invoke('status')"
    if ($s.connection -eq "account") { $s }
} 60 "entrar na conta"
Write-Host "   conectado: $($estado.account.email) em $($estado.web_url)"
Start-Sleep -Seconds 2
Capturar "2-principal"

Passo "4. nota por voz pelo atalho Ctrl+Alt+N"
Add-Type -Namespace Eclume -Name Teclado -MemberDefinition @'
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);
'@
function Atalho([byte[]]$teclas) {
    foreach ($t in $teclas) { [Eclume.Teclado]::keybd_event($t, 0, 0, [System.UIntPtr]::Zero) }
    [array]::Reverse($teclas)
    foreach ($t in $teclas) { [Eclume.Teclado]::keybd_event($t, 0, 2, [System.UIntPtr]::Zero) }
}
$antes = @(Janela "window.__TAURI__.core.invoke('recordings', { limit: 50 })" | ForEach-Object { $_.id })
Atalho ([byte[]](0x11, 0x12, 0x4E))  # Ctrl, Alt, N
Esperar {
    $s = Janela "window.__TAURI__.core.invoke('status')"
    $s.recording_kind -eq "note"
} 15 "a nota começar pelo atalho" | Out-Null
Capturar "3-nota"
Add-Type -AssemblyName System.Speech
$voz = New-Object System.Speech.Synthesis.SpeechSynthesizer
$ptbr = $voz.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq "pt-BR" } | Select-Object -First 1
if ($ptbr) { $voz.SelectVoice($ptbr.VoiceInfo.Name) }
$voz.Speak("Nota de teste do eclume. Lembrar de enviar o orçamento revisado para a Ana até sexta-feira e marcar a reunião de acompanhamento.")
Esperar {
    $s = Janela "window.__TAURI__.core.invoke('status')"
    $s.status -ne "recording"
} 40 "a nota parar no silêncio" | Out-Null
$nota = Janela "window.__TAURI__.core.invoke('recordings', { limit: 50 })" |
    Where-Object { $antes -notcontains $_.id -and $_.kind -eq "note" } | Select-Object -First 1
if (-not $nota) {
    Write-Host "!! a nota foi descartada: o microfone não ouviu voz (mudo ou sem entrada)."
    Write-Host "!! repita com uma pessoa falando perto do microfone depois do Ctrl+Alt+N."
    exit 2
}
Write-Host "   nota $($nota.id): $($nota.duration_ms) ms"
$nota = Esperar {
    Janela "window.__TAURI__.core.invoke('sync_now')" | Out-Null
    Janela "window.__TAURI__.core.invoke('recordings', { limit: 50 })" |
        Where-Object { $_.id -eq $nota.id -and $_.status -eq "synced" -and $_.remote_id }
} 180 "a nota subir ao servidor"
Write-Host "   no servidor: $($nota.remote_id)"
Capturar "4-enviada"

Passo "5. a nota na biblioteca (API)"
$ca = Join-Path $dados "servidor-ca.pem"
$argumentos = @("run", "python", (Join-Path $raiz "desktop\scripts\prova_nota.py"), "--servidor", $Servidor,
    "--gravacao", $nota.remote_id, "--versao", $Versao)
if (Test-Path $ca) { $argumentos += @("--ca", $ca) }
Push-Location $raiz
try {
    $resumo = & uv @argumentos
    $codigo = $LASTEXITCODE
} finally {
    Pop-Location
}
$resumo | Set-Content -Encoding utf8 (Join-Path $saida "nota.json")
$resumo | Write-Host
if ($codigo -ne 0) { throw "a nota não chegou pronta à biblioteca" }
Write-Host "== prova da nota por voz: ok ($saida)"
