# `standards/code/`

**Como o código do eclume é organizado e verificado** — layout do monorepo, toolchain de cada
pilar e os comandos de build, lint e teste que as specs citam no `verify:`.

* [monorepo.md](monorepo.md) — pilares na raiz, workspace uv, npm em `web/`, workspace cargo em `desktop/`, e os comandos de cada um
* [formato-audio-upload.md](formato-audio-upload.md) — o formato Opus mono 16 kHz em Ogg que o navegador produz antes do upload, os motores (WebCodecs/Mediabunny e ffmpeg.wasm) e a API de `web/src/lib/media-convert`
* [desktop-gravacao.md](desktop-gravacao.md) — como o app desktop grava (mic + sistema em Ogg/Opus mono 16 kHz), a fila SQLite de gravações e os traits de sync e detecção
* [desktop-distribuicao.md](desktop-distribuicao.md) — como o app desktop vira instaladores (tag `desktop-v*`, workflow `desktop-release`), se atualiza pelo updater com chave minisign própria e é publicado em `/srv/eclume/downloads`
* [server-nucleo.md](server-nucleo.md) — como o server persiste e isola (migrations SQL, RLS sob `eclume_app`), autentica (sessão com CSRF, PAT), recebe uploads (URL de parte assinada pela API) e é testado (serviços reais, conformidade com o OpenAPI)
* [server-agentes.md](server-agentes.md) — como o server gera resumos: providers (`claude -p` sem ferramentas, Anthropic, OpenAI-compatível, Ollama só com a GPU livre), chaves cifradas, providers da plataforma, templates do usuário semeados no cadastro, o job `summarize` e o map-reduce
* [frontend-web.md](frontend-web.md) — o app web: cliente gerado do contrato, origem única com sessão e CSRF, estrutura de pastas, motor de upload multipart e testes (vitest sobre as fixtures e E2E contra o mock)
* [desktop-deteccao-e-sync.md](desktop-deteccao-e-sync.md) — como o app desktop detecta reuniões (mic, processo e janela, com debounce e políticas por app) e sobe as gravações por PAT pelo upload resumível, com CA extra e retenção
* [server-admin.md](server-admin.md) — o painel admin no server: conta e sessão de admin separadas, configuração da plataforma entregue ao worker pelas `options`, segredos cifrados só de escrita, usuários com ativar e desativar, a saúde com o heartbeat do worker GPU e o CLI de contas de admin
* [identificacao-por-voz.md](identificacao-por-voz.md) — a sugestão de pessoas pela voz: impressão como amostras de locutores confirmados, centroide e limiar calibrado no ingest, retranscrição que preserva vínculos, só entre pessoas do dono, e o regime LGPD (liga-desliga da plataforma, aceite do aviso no cadastro no lugar do consentimento por pessoa, esquecer a voz)
