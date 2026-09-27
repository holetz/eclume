# `standards/code/`

**Como o código do eclume é organizado e verificado** — layout do monorepo, toolchain de cada
pilar e os comandos de build, lint e teste que as specs citam no `verify:`.

* [monorepo.md](monorepo.md) — pilares na raiz, workspace uv, npm em `web/`, workspace cargo em `desktop/`, e os comandos de cada um
* [formato-audio-upload.md](formato-audio-upload.md) — o formato Opus mono 16 kHz em Ogg que o navegador produz antes do upload, os motores (WebCodecs/Mediabunny e ffmpeg.wasm) e a API de `web/src/lib/media-convert`
* [desktop-gravacao.md](desktop-gravacao.md) — como o app desktop grava (mic + sistema em Ogg/Opus mono 16 kHz), a fila SQLite de gravações e os traits de sync e detecção
* [desktop-distribuicao.md](desktop-distribuicao.md) — como o app desktop vira instaladores (tag `desktop-v*`, workflow `desktop-release`), se atualiza pelo updater com chave minisign própria e é publicado em `/srv/eclume/downloads`
* [server-nucleo.md](server-nucleo.md) — como o server persiste e isola (migrations SQL, RLS sob `eclume_app`), autentica (sessão com CSRF, PAT), recebe uploads (URL de parte assinada pela API) e é testado (serviços reais, conformidade com o OpenAPI)
* [server-agentes.md](server-agentes.md) — como o server gera resumos: providers (`claude -p` sem ferramentas, Anthropic, OpenAI-compatível, Ollama só com a GPU livre), chaves cifradas, templates pessoais e da organização, o job `summarize` e o map-reduce
* [frontend-web.md](frontend-web.md) — o app web: cliente gerado do contrato, origem única com sessão e CSRF, estrutura de pastas, navegação agrupada, gaveta de ajuda, motor de upload multipart e testes (vitest sobre as fixtures e E2E contra o mock)
* [web-design-system.md](web-design-system.md) — o Design System do eclume no web: `eclume.css` fiel ao `eclume-design`, `app.css` de produto, fontes locais, ícones Lucide, tema por `data-theme`, o sync e o mapa dos tokens antigos
* [desktop-deteccao-e-sync.md](desktop-deteccao-e-sync.md) — como o app desktop detecta reuniões (mic, processo e janela, com debounce e políticas por app) e sobe as gravações por PAT pelo upload resumível, com CA extra e retenção
* [server-admin.md](server-admin.md) — o painel admin no server: configuração em runtime entregue ao worker pelas `options`, segredos cifrados só de escrita, convites por link, RLS de `users` por comando e a saúde com o heartbeat do worker GPU
* [identificacao-por-voz.md](identificacao-por-voz.md) — a sugestão de pessoas pela voz: impressão como amostras de locutores confirmados, centroide e limiar calibrado no ingest, retranscrição que preserva vínculos, e o regime LGPD (opt-in, consentimento versionado, exclusão, exportação e auditoria)
