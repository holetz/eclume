# `standards/` — contratos atuais do eclume

O **padrão/contrato** atual — "como deve ser e por quê", a fonte da verdade compartilhada. Um
padrão por arquivo; subpastas por **assunto**. Cada doc tem `type: standard` e um `resource:`
derivado (o escopo do repositório que ele governa).

**Fronteira:** `standards/` = "como **NÓS** fazemos (atual)". Direção vive em
[vision/](../vision/index.md). Uma regra **acordada mas não provada** fica aqui como
`authority: background` e passa a `current` quando provada.

## Subtopics

* [agents/](agents/index.md) — o idioma declarado e o contrato de conduta dos agentes
* [api/](api/index.md) — o contrato de API v1, suas convenções e a regra de evolução só aditiva
* [code/](code/index.md) — layout do monorepo, toolchains e comandos de cada pilar

## Current docs

<!-- BEGIN GENERATED: rebuilt from disk by `quenching-align`/`quenching-insert` — DO NOT edit by hand.
     Scans standards/**/*.md, reads title/description/timestamp/type, grouped by subject subfolder. -->
### agents/
| Doc | Covers |
| --- | --- |
| [communication.md](agents/communication.md) | The language a repo declares for the prose its agents author — one BCP-47 tag on the root harness line, governing artifact and conversation alike — and the conduct contract that holds in every repo whether or not a language is declared |

### api/
| Doc | Covers |
| --- | --- |
| [contrato-v1.md](api/contrato-v1.md) | As convenções da API v1 do eclume — autenticação por sessão e PAT com escopos, erros RFC 9457, paginação por cursor, upload multipart S3 com dedup por hash, transcrição em JSON Schema — e a regra de que a v1 só evolui de forma aditiva. |
| [jobs-transcricao.md](api/jobs-transcricao.md) | As duas filas arq (`eclume:gpu` e `eclume:default`), o job `transcribe` que o server enfileira (com a configuração do admin e o token do HF cifrado nas options), os artefatos e os jobs `ingest_transcript`/`transcription_failed` que o worker GPU devolve, o progresso e o heartbeat no Redis e a idempotência por `(recording_id, revision)`. |

### code/
| Doc | Covers |
| --- | --- |
| [desktop-deteccao-e-sync.md](code/desktop-deteccao-e-sync.md) | O app desktop percebe uma reunião pelo mic em uso por outro processo somado a processo e título de janela, aplica a política do app (gravar, perguntar ou ignorar) com debounce e indicação visível, e sobe cada gravação por PAT pelo upload resumível do contrato v1, só apagando o arquivo local depois da confirmação — estes são os sinais, a máquina de estados, o protocolo, o PAT, a CA extra e a retenção. |
| [desktop-distribuicao.md](code/desktop-distribuicao.md) | Como o app desktop do eclume vira instaladores e se atualiza — versão no tauri.conf.json, tag desktop-v<versão>, workflow desktop-release com matriz Windows/Linux/macOS universal, pacotes do updater assinados com a chave minisign própria, latest.json e instaladores.json com URLs do servidor eclume e publicação em /srv/eclume/downloads pelo deploy/publicar-desktop.sh. |
| [desktop-gravacao.md](code/desktop-gravacao.md) | O app desktop grava mic e áudio do sistema mixados em Ogg/Opus mono 16 kHz (24 kbps), registra cada gravação numa fila SQLite local (v2) com estados recording → pending → syncing → synced ou failed, retomada, backoff e retenção, e expõe os traits Uploader e MeetingDetector que o sync e a detecção implementam — este é o formato, o ciclo de vida e os pontos de extensão. |
| [formato-audio-upload.md](code/formato-audio-upload.md) | Antes do upload, o navegador converte áudio e vídeo para Opus mono 16 kHz em Ogg (32 kbps) pela biblioteca isolada web/src/lib/media-convert — WebCodecs com Mediabunny, ffmpeg.wasm de fallback — e este é o formato, o porquê e a API que o app consome. |
| [frontend-web.md](code/frontend-web.md) | O app web do eclume (web/) fala com a API por um cliente gerado do contrato v1, na mesma origem e com sessão por cookie e CSRF double-submit; organiza-se em shell, features (biblioteca, gravação, pessoas, busca, coleções) e um motor de upload sem React; e é testado com vitest sobre as fixtures do contrato e com um E2E Playwright contra o mock Prism. |
| [monorepo.md](code/monorepo.md) | Cada pilar do eclume fica na raiz com a própria toolchain — workspace uv (server, worker-gpu, engines), npm em web/ e workspace cargo em desktop/ — e estes são os comandos de build, lint e teste que a CI e as specs usam. |
| [server-admin.md](code/server-admin.md) | Como o server atende o painel de administração — configuração em runtime da organização (merge por campo, validação e entrega ao worker pelas options do transcribe), segredos cifrados só de escrita (o token do HF vai cifrado ao worker GPU), convites por link com expiração, a RLS de users por comando e a saúde montada das filas arq, do heartbeat do worker GPU e dos jobs da organização. |
| [server-agentes.md](code/server-agentes.md) | Como o server gera resumos de transcrições — quatro providers atrás de uma interface (claude -p do servidor sem ferramentas, API da Anthropic, OpenAI-compatível e Ollama só com a fila da GPU vazia), chaves de API cifradas, templates pessoais e padrões da organização, resumos versionados no job summarize do worker CPU com erros tipados e retentativas, map-reduce para transcrições longas e o resumo automático após a ingestão. |
| [server-nucleo.md](code/server-nucleo.md) | Como o pacote eclume_server guarda e isola os dados (migrations SQL, RLS por organização e dono sob o papel eclume_app), autentica (sessão com CSRF, PAT com escopos), recebe uploads (URL de parte assinada pela própria API, dedup e retomada por hash), organiza (pessoas da organização, coleções do usuário, edição da transcrição pelo dono), busca (full-text eclume_pt sob a RLS) e é testado (serviços reais, conformidade com o OpenAPI bundled). |
<!-- END GENERATED -->
