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

### code/
| Doc | Covers |
| --- | --- |
| [desktop-gravacao.md](code/desktop-gravacao.md) | O app desktop grava mic e áudio do sistema mixados em Ogg/Opus mono 16 kHz (24 kbps), registra cada gravação numa fila SQLite local com estados recording → pending → syncing → synced ou failed, e expõe os traits Uploader e MeetingDetector para o sync e a detecção — este é o formato, o ciclo de vida e os pontos de extensão. |
| [frontend-web.md](code/frontend-web.md) | O app web do eclume (web/) fala com a API por um cliente gerado do contrato v1, na mesma origem e com sessão por cookie e CSRF double-submit; organiza-se em shell, features e um motor de upload sem React; e é testado com vitest sobre as fixtures do contrato e com um E2E Playwright contra o mock Prism. |
| [formato-audio-upload.md](code/formato-audio-upload.md) | Antes do upload, o navegador converte áudio e vídeo para Opus mono 16 kHz em Ogg (32 kbps) pela biblioteca isolada web/src/lib/media-convert — WebCodecs com Mediabunny, ffmpeg.wasm de fallback — e este é o formato, o porquê e a API que o app consome. |
| [monorepo.md](code/monorepo.md) | Cada pilar do eclume fica na raiz com a própria toolchain — workspace uv (server, worker-gpu, engines), npm em web/ e workspace cargo em desktop/ — e estes são os comandos de build, lint e teste que a CI e as specs usam. |
<!-- END GENERATED -->
