# `standards/code/`

**Como o código do eclume é organizado e verificado** — layout do monorepo, toolchain de cada
pilar e os comandos de build, lint e teste que as specs citam no `verify:`.

* [monorepo.md](monorepo.md) — pilares na raiz, workspace uv, npm em `web/`, workspace cargo em `desktop/`, e os comandos de cada um
* [formato-audio-upload.md](formato-audio-upload.md) — o formato Opus mono 16 kHz em Ogg que o navegador produz antes do upload, os motores (WebCodecs/Mediabunny e ffmpeg.wasm) e a API de `web/src/lib/media-convert`
