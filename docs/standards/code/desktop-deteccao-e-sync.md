---
type: standard
title: Detecção de reuniões e sync no app desktop
description: O app desktop percebe uma reunião pelo mic em uso por outro processo somado a processo e título de janela, aplica a política do app (gravar, perguntar ou ignorar) com debounce e indicação visível, entra no servidor com e-mail e senha ou código de pareamento (primeira execução, mDNS e CA fixada pela impressão digital) e sobe cada gravação com a credencial de dispositivo pelo upload resumível do contrato v1, só apagando o arquivo local depois da confirmação — estes são os sinais, a máquina de estados, a conta, o protocolo, a CA e a retenção.
resource: desktop/crates/detect/**, desktop/crates/sync/**, desktop/src-tauri/src/auto.rs, desktop/src-tauri/src/sync.rs, desktop/src-tauri/src/account.rs, desktop/src-tauri/src/notify.rs, desktop/src-tauri/src/config.rs, desktop/src-tauri/src/tray.rs, desktop/ui/**
tags: [code, desktop, deteccao, sync, upload, dispositivo, mdns, tls, tauri]
timestamp: 2026-09-27
audience: both
authority: current
source: holetz/eclume#13, holetz/eclume#28, holetz/eclume#40
maintainer: holetz
---

# Detecção de reuniões e sync no app desktop

Dois crates, cada um com a parte pura separada da que toca o SO: `eclume-detect`
(`desktop/crates/detect`) e `eclume-sync` (`desktop/crates/sync`). O app
(`desktop/src-tauri`) só liga os dois ao estado, à bandeja e à janela. A gravação em si, a fila e
os traits `Uploader`/`MeetingDetector` estão em [desktop-gravacao.md](desktop-gravacao.md).

## Detecção

```
SignalSource::snapshot() ─▶ classify() ─▶ Debouncer ─▶ MeetingEvent ─▶ AutoRecorder ─▶ Action
  (SO, a cada 1 s)         Option<AppKey>  3 s / 15 s   Started/Ended    políticas       Start/Stop/Ask/Dismiss
```

**Sinais** (`Snapshot { mic_users, mic_busy, processes, window_titles }`, `platform/`):

| SO | Quem usa o mic | Títulos de janela |
|---|---|---|
| Linux | source-outputs do Pulse (ou do PipeWire pela camada Pulse) não corked e que não leem um monitor | não lê (Wayland não deixa) |
| Windows | `HKCU\…\CapabilityAccessManager\ConsentStore\microphone`, apps empacotados e `NonPackaged`, com `LastUsedTimeStop = 0` | `EnumWindows`, só quando um navegador usa o mic |
| macOS | processos Core Audio com entrada ativa (14+); antes disso, `DeviceIsRunningSomewhere` do dispositivo padrão, sem dono, mais a lista de processos | não lê (exige Gravação de Tela) |

O próprio eclume sai da lista pelo pid e pelo nome do executável, senão a gravação se detectaria. O
nome vem só do último componente do id (no Windows, o id é o caminho inteiro): um app numa pasta com
"eclume" no caminho segue visível para a detecção.
`cargo run -p eclume-detect --example sinais -- 10` imprime os retratos e a classificação para
diagnóstico de campo.

**Classificação** (`AppKey`: `teams`, `zoom`, `meet`, `webex`, `slack`, `navegador`, `outro`):

1. Mic livre → nenhuma reunião, com qualquer app aberto.
2. App de reunião nativo usando o mic (binário, nome ou bundle com `teams`, `zoom`, `webex`,
   `slack`...) → esse app.
3. Navegador usando o mic → o título de janela decide (`meet.google.com`/`Meet - ` → `meet`,
   `Microsoft Teams` → `teams`, `Zoom Meeting` → `zoom`); sem título conhecido, `navegador`.
4. Mic ocupado sem dono identificado → processo de reunião em execução (`CptHost` do Zoom,
   Teams) ou `outro`.
5. Qualquer outro usuário do mic → `outro`.

`capture.meeting_app` do contrato recebe `teams`, `meet` ou `zoom`; o resto vai como `other`.

**Debounce**: a reunião começa depois de 3 s contínuos de detecção e termina depois de 15 s
contínuos sem ela. Um `Started` por reunião; falha de leitura dos sinais não conta nem como
presença nem como ausência.

## Políticas e gravação automática

`config.json` → `detection: { enabled, policies: { <app>: auto | ask | ignore } }`. Padrão:
`enabled: true`, `ask` para todos os apps e `ignore` para `outro`. Gravar alguém sem aviso é
decisão do usuário, então `auto` nunca é padrão.

| Evento | Estado | Ação |
|---|---|---|
| `Started` | ocioso, política `auto` | inicia gravação automática |
| `Started` | ocioso, política `ask` | pergunta (fica pendente até resposta ou fim) |
| `Started` | já gravando, detecção desligada ou `ignore` | nada |
| `Ended` | gravação automática | para |
| `Ended` | pergunta pendente | tira a pergunta |
| resposta "Gravar" | ocioso | inicia gravação automática |
| resposta "Ignorar", parada manual | — | vale até o fim daquela reunião |

- Gravação manual nunca é parada pela detecção, e iniciar uma à mão tira a pergunta pendente.
- **Indicação visível:** a gravação automática só começa com a bandeja de pé; a bandeja troca o
  ícone e a linha ("Gravando · Microsoft Teams (automático)") e sai uma notificação.
- **A pergunta** vai por notificação nativa com as ações Gravar e Ignorar — `notify-rust` (D-Bus)
  no Linux, toast com botões (`tauri-winrt-notification`, AUMID do app instalado ou o do
  PowerShell em dev) no Windows, `mac-notification-sys` no macOS — e fica também no menu da
  bandeja e na janela, porque o SO pode suprimir a notificação.
- Com a detecção desligada, o detector só acompanha até o fim a reunião que já tinha visto.
- **Onde muda:** Configurações · Reuniões tem o `.switch` "Detectar reuniões" e os 7 apps, cada um
  com o `.seg` Gravar, Perguntar e Ignorar e o subtítulo do DS, e "Restaurar padrões" volta a
  `DetectionConfig::default()`. Durante uma gravação automática, a principal mostra o `.seg`
  "Reuniões no <app>", que muda a política daquele app ali mesmo.

## Sync

**Protocolo** (`protocol.rs`), sobre o contrato v1 ([contrato-v1.md](../api/contrato-v1.md)):

1. `POST /api/v1/uploads` com `filename`, `content_type`, `size_bytes`, `sha256` hex,
   `recorded_at`, `recorded_at_source`, `kind`, `duration_ms`, `source`, `markers` (omitido quando
   vazio) e `capture { meeting_app, device_name, client_version }`. Tudo vem da linha da fila
   ([desktop-gravacao.md](desktop-gravacao.md)):

| Gravação | `filename` | `kind` | `source` | `recorded_at_source` | `content_type` |
|---|---|---|---|---|---|
| reunião | `2026-09-24 14-00 Teams.ogg` (hora local) | `meeting` | `desktop` | `capture` | `audio/ogg; codecs=opus` |
| nota | `2026-09-26 10-42 nota.ogg` | `note` | `desktop` | `capture` | `audio/ogg; codecs=opus` |
| importação | `<nome original>.<extensão enviada>` | `meeting` | `upload` | `file_metadata` ou `user` | Ogg/Opus, ou o do arquivo copiado |

   Os marcadores vão com `client_id`, `at_ms` e a nota; o `device_name` do `capture` é o hostname,
   que o servidor copia para cada marcador.
2. `200 deduplicated` → confirmado com o `recording_id` existente, sem transferir nada.
3. `201` → o `upload_id` vai para a fila antes da primeira parte; cada parte que falta sobe por
   `PUT` na `url` recebida, com os `headers` dela, e o `ETag` é guardado. URLs faltantes vêm de
   `part-urls` (até 1000 por pedido).
4. `POST /uploads/{id}/complete` com os ETags → `201` com a gravação: é a confirmação.

- **Retomada:** com `upload_id` guardado, `GET /uploads/{id}` — `in_progress` sobe só o que falta
  em `parts_received`; `completed`/`deduplicated` confirma direto; `404`, `expired` ou `aborted`
  recriam o upload. O `sha256` é calculado uma vez, em blocos, e guardado.
- **Credencial só na mesma origem:** `Authorization` vai nas URLs de parte da própria API e nunca numa
  URL pré-assinada de outra origem (o S3 recusa dois mecanismos de autenticação). Uma URL
  pré-assinada recusada com `403` é renovada por `part-urls` uma vez.
- **Retentativa por requisição:** falha de rede, `408`, `429` e `5xx` tentam de novo até 3 vezes,
  com 1 s, 2 s e 4 s ou o `Retry-After` (teto de 60 s). `401`, `403`, `422` e o resto falham na
  hora, com o `code` e o `detail` do problem na mensagem.
- **Retentativa na fila:** uma falha agenda `next_attempt_at` (30 s dobrando até 1 h);
  "Sincronizar agora" e salvar as configurações devolvem as falhas à fila na hora.
- **Laço** (`src-tauri/src/sync.rs`): a cada 30 s, e quando uma gravação para, as configurações
  mudam, a pessoa entra ou pede, roda `retry_due` → `sync_pending` com o `HttpUploader` →
  retenção. Sem credencial, nada sobe e a janela diz "Entre para enviar 2 gravações". Depois de
  uma falha com a CA fixada, o laço confere se a CA do servidor mudou (abaixo).
- Transporte `ureq` 3 com rustls (ring): sem `reqwest`, que traria `aws-lc-rs` por padrão.

## Conta e credencial

O lado do app do protocolo de [server-mcp-e-dispositivos.md](server-mcp-e-dispositivos.md).

- **Credencial de dispositivo.** A pessoa entra com e-mail e senha (`POST /devices/login`) ou com
  o código de pareamento de 6 caracteres gerado na web (`POST /devices/pair`), mandando
  `device_name` (o hostname, o mesmo do `capture`) e `platform` (`windows`, `macos` ou `linux`).
  O segredo `eclp_` que volta é guardado; no pareamento, o e-mail vem de `GET /me`. As recusas
  viram texto: 401 dá "E-mail ou senha incorretos", `invalid_pairing_code` dá "Código inválido ou
  vencido" e 429 dá "Muitas tentativas; tente em N s" (pelo `Retry-After`). Essas rotas não têm
  retentativa: é uma ação da pessoa.
- **O cofre** é o `PatStore` de sempre, porque a credencial também é `eclp_`: o chaveiro do SO
  pelo `keyring` 4 (serviço `eclume-desktop`, conta `pat`: Secret Service no Linux, Credential
  Manager no Windows, Keychain no macOS). Sem chaveiro (sessão sem Secret Service), vai para `pat`
  no diretório de config com permissão 0600, e a janela avisa; quando o chaveiro volta, o próximo
  salvamento apaga o arquivo. O segredo nunca volta à janela.
- `config.json` ganha `account: {email, token_id, server_name}`. `Config::connection(tem
  credencial)` decide a janela: sem credencial, `first_run`; credencial sem `account`,
  `personal_token`; com as duas, `account`.
- **Quem já usa PAT** (0.1.x): com PAT guardado e sem `account`, o app não mostra a primeira
  execução e segue sincronizando. A aba Servidor diz "Conectado com um token pessoal" e oferece
  "Entrar com e-mail e senha", que troca o PAT pela credencial. Colar PAT saiu da tela;
  `ECLUME_PAT` segue sobrepondo tudo, para dev e testes.
- **Sair** apaga a credencial do cofre e a `account` e volta à primeira execução, sem apagar a
  fila: as gravações esperam o próximo login. A revogação fica na web ("Desvincular"), porque o
  contrato não tem rota para o aparelho se revogar.
- **"Testar conexão"** chama `GET /api/v1/me` com a credencial e mostra "Conectado · último envio
  10:38" (o `synced_at` mais recente da fila).

## Primeira execução, descoberta e CA fixada

- **Servidores conhecidos**, na ordem: o **embutido no instalador** ("Veio com este instalador",
  `config::embedded_server`, [desktop-distribuicao.md](desktop-distribuicao.md)), os **achados na
  rede** ("Encontrado na rede") e, em "Avançado", o **endereço digitado** (só o host basta; o
  `https://` entra sozinho).
- **Descoberta** (`sync/src/discovery.rs`, `mdns-sd`, Rust puro): procura `_eclume._tcp.local.`
  por até 3 s e lê o TXT `url`, `ca`, `v` e `name` que o `eclume-server announce` publica; o
  parser é puro, anúncio sem `url` é ignorado e o mesmo endereço não se repete.
- **CA fixada** (`sync/src/pin.rs`): o app fixa a **raiz** do Caddy, nunca o folha.
  1. baixa `<url>/downloads/eclume-root.crt` por um transporte sem verificação
     (`UreqTransport::insecure`), usado **só** para esse arquivo e sem credencial;
  2. calcula o SHA-256 do DER do primeiro certificado e compara com a impressão digital esperada
     (a do instalador, do TXT ou do QR); divergiu, para antes de entrar;
  3. guarda o PEM em `<config_dir>/servidor-pendente/servidor-ca.pem` e lê `GET /api/v1/server`
     já com verificação: o `ca_sha256` do descritor precisa ser o mesmo;
  4. ao entrar, o PEM passa a `<config_dir>/servidor-ca.pem`, que vira o `ca_path`.
- **Sem impressão digital (TOFU).** Com o endereço digitado ou um anúncio sem `ca`, a tela mostra a
  impressão digital em `.code-block` ("Confira com quem administra o servidor") e só deixa entrar
  depois de "Confiar e continuar".
- Um servidor que não publica CA própria (404 no `eclume-root.crt`, sem impressão digital
  esperada) usa as raízes do sistema; `http://` só vale em desenvolvimento.
- **A CA mudou.** Depois de uma falha no sync com a CA fixada, `account::ca_changed` baixa a raiz
  de novo e compara com a guardada. Se mudou, o sync para com "O certificado do servidor mudou" e
  a janela volta à primeira execução, onde a pessoa escolhe o servidor e entra de novo.
- **Comandos** da janela: `discover_servers`, `prepare_server(url, ca_sha256?)` (devolve `{name,
  url, ca_sha256, trusted_by}`, com `trusted_by` `fingerprint`, `first_use`, `system` ou
  `unencrypted`), `sign_in`, `pair`, `sign_out`, `test_connection`, `open_signup` (abre
  `<url>/cadastro`) e `pick_ca_file`.

## Servidor, CA extra e retenção

| Campo do `config.json` | Padrão | O que faz |
|---|---|---|
| `web_url` | o servidor embutido, ou `https://192.168.15.199:8443` num build sem ele | servidor: o eclume web e, sem `api_url`, a API; entrar grava o servidor escolhido |
| `account` | — | a conta em que o computador entrou |
| `api_url` | — | API em outro endereço (dev); `ECLUME_API_URL` sobrepõe |
| `ca_path` | — | PEM com a CA interna do Caddy: a fixada pela primeira execução ou uma escolhida em Servidor · Avançado ("Escolher…") |
| `retention_days` | `7` | dias que o arquivo local fica depois da confirmação; `0` apaga logo, `null` guarda sempre |

- **TLS:** sem `ca_path`, vale o verificador da plataforma, que enxerga a CA instalada no SO pelo
  runbook do host. Com `ca_path`, as raízes nativas do SO mais os certificados do PEM. Um PEM
  ilegível ou sem certificado é recusado ao salvar.
- **Retenção:** só linhas `synced` com `remote_id` perdem o arquivo, e a linha fica na fila com
  `purged_at`. Nada que o servidor não confirmou sai do disco.

## Testes

- Unidade, sem SO: classificação com sinais mockados, debounce com relógio injetado, máquina de
  gravação automática, protocolo sobre um transporte roteirizado (upload novo, dedup, retomada,
  upload sumido, retentativa e `Retry-After`, `401` sem retentativa, URL pré-assinada renovada),
  login e pareamento com as recusas, CA fixada (impressão digital, TOFU, descritor divergente),
  o parser do TXT do mDNS, a conta no estado sobre uma rede roteirizada (`account::tests`:
  entrar, sair, CA trocada, PAT antigo), PAT com chaveiro falso, retenção e config. A escuta mDNS
  de verdade fica num teste `#[ignore]`.
- Integração com o mock do contrato (`tests/mock.rs`), pulada sem `ECLUME_MOCK_URL`. As URLs de
  parte das fixtures apontam para `127.0.0.1:4010`, então o mock roda na mesma máquina dos
  testes. No host de build, o compose sobe de dentro do diretório sincronizado, porque o bind
  mount de `../contracts` precisa existir no host:

```bash
remote-run . 'docker compose -p eclume-13-mock -f deploy/docker-compose.mock.yml up -d --wait'
remote-run . 'ECLUME_MOCK_URL=http://127.0.0.1:4010 cargo test --manifest-path desktop/Cargo.toml -p eclume-sync'
remote-run . 'docker compose -p eclume-13-mock -f deploy/docker-compose.mock.yml down -v'
```

- Windows e macOS: só `cargo check` pelo workflow manual `desktop-plataformas.yml`; o teste de
  campo (ConsentStore, toasts com botões, Core Audio) é da spec `distribuicao-desktop`.
