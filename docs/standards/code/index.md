# `standards/code/`

**Como o código do eclume é organizado e verificado** — layout do monorepo, toolchain de cada
pilar e os comandos de build, lint e teste que as specs citam no `verify:`.

* [monorepo.md](monorepo.md) — pilares na raiz, workspace uv, npm em `web/`, workspace cargo em `desktop/`, e os comandos de cada um
* [formato-audio-upload.md](formato-audio-upload.md) — o formato Opus mono 16 kHz em Ogg que o navegador produz antes do upload, os motores (WebCodecs/Mediabunny e ffmpeg.wasm) e a API de `web/src/lib/media-convert`
* [desktop-gravacao.md](desktop-gravacao.md) — como o app desktop grava (mic + sistema em Ogg/Opus mono 16 kHz), a fila SQLite de gravações e os traits de sync e detecção
* [server-nucleo.md](server-nucleo.md) — como o server persiste e isola (migrations SQL, RLS sob `eclume_app`), autentica (sessão com CSRF, PAT), recebe uploads (URL de parte assinada pela API) e é testado (serviços reais, conformidade com o OpenAPI)
* [frontend-web.md](frontend-web.md) — o app web: cliente gerado do contrato, origem única com sessão e CSRF, estrutura de pastas, motor de upload multipart e testes (vitest sobre as fixtures e E2E contra o mock)
