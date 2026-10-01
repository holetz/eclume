---
type: concept
title: Glossário
description: A busca A–Z única de termos, siglas e vocabulário de domínio do eclume — uma entrada por termo, com link para o doc completo quando ele existe.
resource: docs/**
tags: [glossary, vocabulary, terminology]
timestamp: 2026-10-01
audience: both
authority: current
source: claude-quenching skeleton
maintainer: holetz
---

# Glossário

A **fonte única do que um termo significa aqui**. Uma entrada por termo, na mesma sintaxe de
bullet de todo `index.md`: o termo com link para um doc completo e uma definição de uma frase, ou
o termo em negrito com a definição quando não há doc.

**Resolvendo um termo.** Quando uma palavra, sigla ou jargão do repositório não estiver claro,
**procure aqui primeiro** (`grep -i '<termo>' docs/glossary.md`). Sem entrada, o termo ainda não
foi definido — registre-o com `/quenching:knowledge:define`.

**Este arquivo é a exceção deliberada a "um conceito por arquivo"**: uma lista plana, ordenada
alfabeticamente pelo termo, com uma frase por definição e link para fora em vez de explicação.
Uma entrada **sem link** (termo sem doc próprio) é um estado válido e permanente.

## Terms

- [agente](standards/code/server-agentes.md) — Modelo de linguagem que o server chama por um provider para preencher campos, detectar o tipo de agenda, resumir e conversar (chat de ajuste e Perguntar).
- [Anarlog](project/referencias.md) — App de notas de reunião (Tauri 2, MIT) de onde o desktop do eclume reaproveita crates Rust de detecção e captura de áudio.
- [App móvel](standards/code/mobile-app.md) — O app Android do eclume (Tauri 2, pilar `mobile/`): um microfone portátil que grava com a tela bloqueada, marca instantes e sincroniza no Wi‑Fi do servidor, sem ler transcrições.
- [artigo de ajuda](standards/code/web-central-de-ajuda.md#o-cabeçalho) — Arquivo Markdown em `web/src/features/help/articles/<slug>.md`, com cabeçalho (título, tópico, chaves de página, relacionados, termos, ordem, data), servido em `/ajuda/<slug>`.
- [atalho global](standards/code/desktop-interface.md#atalhos) — Combinação de teclas que o app desktop registra no sistema inteiro para gravar, começar uma nota e marcar, `Ctrl+Alt+R/N/M` no Windows e no Linux e `⌘⇧R/N/K` no macOS, mudada em Configurações · Áudio.
- [atribuição automática](standards/code/identificacao-por-voz.md#atribuição-automática) — Ligação do locutor à pessoa feita pela voz na ingestão, antes do resumo, quando a pontuação passa do limiar que o usuário configura na conta; fica marcada (`auto_score`), pode ser desfeita e só reforça a impressão depois de confirmada.
- [aviso de consentimento](standards/code/server-nucleo.md) — Texto versionado que a pessoa aceita no cadastro ("Sou responsável por pedir o consentimento das pessoas que gravo"), no lugar do consentimento de voz por pessoa; versão nova pede novo aceite no login.
- [biblioteca no tempo](standards/code/frontend-web.md#biblioteca-no-tempo) — A tela inicial do web: as gravações no calendário (semana como agenda, mês e lista), posicionadas pelo início e pela duração.
- [cadastro de tags](standards/code/processamento-automatico.md#cadastro-de-tags) — A lista de tags de cada conta, com a descrição "quando usar" de cada uma: por padrão o agente só escolhe entre elas (tags fixas); no modo autogerenciado, cria poucas novas, com limite por gravação e teto no cadastro.
- [campo](standards/code/processamento-automatico.md) — Dado de uma gravação que o usuário define (texto, lista ou escolha), com uma regra de preenchimento; título e tags são os campos embutidos de toda conta.
- [central de ajuda](standards/code/web-central-de-ajuda.md) — A ajuda do usuário no web (`/ajuda`): artigos em pt-BR que moram no build, seis tópicos, perguntas frequentes e busca local, sem servidor.
- [chat de ajuste](standards/code/server-agentes.md#chat-de-ajuste) — Conversa em que o usuário pede uma mudança no resumo e o agente de chat responde, lendo a transcrição só quando o pedido depende do que foi dito; uma resposta que muda o resumo vira versão `chat`.
- [chave de página (ajuda)](standards/code/web-central-de-ajuda.md#o-cabeçalho) — Nome de uma tela (`pessoas`, `campos`, `mcp`…) que ela declara com `useHelpTopic` e que os artigos listam em `paginas`, para a gaveta mostrar "Nesta página".
- [código de pareamento](standards/code/server-mcp-e-dispositivos.md#credencial-de-dispositivo) — Código de 6 caracteres (`K7Q-4MX`, sem os ambíguos), válido por 10 minutos e de uso único, que a web gera com o link do QR e o app troca por uma credencial de dispositivo em `POST /devices/pair`; o banco guarda só o HMAC.
- [coleção](standards/code/server-nucleo.md) — Agrupamento de gravações de um usuário (por cliente, projeto ou programa); uma gravação pode estar em várias.
- [coleção automática](standards/code/processamento-automatico.md#fill_fields) — Coleção com regra ("Quando incluir") e "Incluir automaticamente" ligado: depois da transcrição, o agente inclui nela as gravações que cumprem a regra, lendo a conversa, o tipo de agenda e os participantes.
- [configuração da plataforma](standards/code/server-admin.md) — A linha única de `platform_settings` que o admin edita (transcrição, locutores, voz, pré-processamento) e que vale para todas as contas.
- [conta de admin](standards/code/server-admin.md) — Conta da tabela `admins`, separada das contas de usuário, com login e sessão próprios (`/admin/auth/login`) que só alcançam `/admin/*`; criada pelo CLI `eclume-server admin create`.
- [contrato de jobs](standards/api/jobs-transcricao.md) — Acordo entre o server e o worker GPU: filas arq `eclume:gpu`/`eclume:default`, job `transcribe`, artefatos no bucket e `ingest_transcript`/`transcription_failed`.
- [contrato v1](standards/api/contrato-v1.md) — OpenAPI e JSON Schema da transcrição em `contracts/`, fonte da verdade entre o eclume e os clientes; só evolui de forma aditiva, com a linha 2.x sob `/api/v1` (do fim da organização, 2.0.0, até o fim do redesign) como exceção única; a próxima quebra vai para `/api/v2`.
- [credencial de dispositivo](standards/code/server-mcp-e-dispositivos.md#credencial-de-dispositivo) — Token `eclp_` de `kind: device` (com a plataforma do aparelho, `recordings:read` e `recordings:write`, sem validade) que o desktop ou o celular recebe ao entrar por e-mail e senha ou por código de pareamento; revogá-lo desliga o aparelho.
- [descoberta (mDNS)](standards/code/server-mcp-e-dispositivos.md#descoberta-na-rede-mdns) — Anúncio `_eclume._tcp` na LAN pelo serviço `mdns` (`eclume-server announce`), com a URL pública e a impressão digital da CA no TXT, para os apps acharem o servidor sem digitar o endereço.
- [descritor do servidor](standards/code/server-mcp-e-dispositivos.md#descritor-do-servidor) — `GET /api/v1/server`, público: nome, endereço, endereço MCP, impressão digital da CA raiz e versões; a fonte do mDNS, do QR, do pareamento e do instalador com endereço embutido.
- [Design System do eclume](standards/code/web-design-system.md) — O repositório `eclume-design` (tokens, classes, componentes e as telas do mapa v6) que é a base visual do web: o `styles.css` dele entra como `web/src/styles/eclume.css`, cópia fiel.
- **diarização** — Separação de uma gravação em trechos por locutor ("quem falou quando"), feita no worker GPU pelo pyannote.
- [dica em linha](standards/code/web-central-de-ajuda.md#busca-gaveta-e-dica) — O "?" (`HelpHint`) ao lado de uma regra que não é óbvia na tela, que abre um popover curto com o link para o artigo.
- **eclume** — Serviço de transcrição institucional e auto-hospedado (eco + lume), extraído do lumea e ligado a ele só por contrato de API.
- [eclume_pt](standards/code/server-nucleo.md) — Configuração de busca textual do Postgres: `portuguese` com `unaccent` antes do stemmer, usada no `tsvector` dos segmentos.
- **engine** — Implementação da interface de ASR do pacote `eclume_engines` (`whisperx-local`, remota OpenAI-compatível ou CPU para dev).
- **épico** — Spec orquestradora (`holetz/eclume#1`) cujas tasks apontam para specs filhas, cada uma uma issue própria.
- [escopo](standards/api/contrato-v1.md#convenções) — Permissão de um token (`recordings:read`, `summaries:write`, `people:read`…) que cada rota da API e cada ferramenta do servidor MCP exige.
- [etapa do pipeline](standards/code/processamento-automatico.md) — Um dos seis passos do processamento de uma gravação por revisão (recebido, pré-processamento, transcrição, tipo de agenda, campos, resumo), com estado `pending`, `active`, `done`, `failed` ou `skipped`.
- [ffmpeg.wasm](standards/code/formato-audio-upload.md) — O ffmpeg compilado para WebAssembly, fallback da conversão no navegador para contêineres e codecs que o WebCodecs não atende.
- [fila de importação](standards/code/frontend-web.md#importar-modal-e-fila) — Os arquivos escolhidos no modal Importar, convertidos e enviados um por vez pelo shell, que sobrevivem a fechar o modal e a navegar.
- [finalidade](standards/code/server-agentes.md#rotas-de-provider-e-a-fronteira-com-o-painel-admin) — Uso de um provider (`used_for`): `summaries`, `fields`, `chat` ou `agenda_detection`; cada finalidade tem no máximo um provider.
- [gate de qualidade](standards/code/monorepo.md) — Prova dos nove pilares no host GPU (`bash deploy/gate.sh`) que publica o status `eclume/gate` no commit; deploy e releases recusam um SHA sem ele em `success`.
- [gaveta de ajuda](standards/code/frontend-web.md) — O painel lateral `.help-drawer` do web, aberto com `?` ou pelo botão Ajuda do cabeçalho da página, com os links de ajuda daquela página e os atalhos de teclado.
- [grupo de escopo](standards/code/server-mcp-e-dispositivos.md#grupos-da-tela-conexão-mcp) — Conjunto de escopos que a tela Conexão MCP oferece como uma escolha só: Buscar e ler gravações, Ler e editar resumos, Editar campos e tags e Excluir gravações.
- [heartbeat do worker GPU](standards/api/jobs-transcricao.md) — Hash `eclume:gpu:health` que o worker GPU regrava a cada 15 s (TTL 45 s) com a GPU, o modelo residente e se há job; a Saúde do painel admin lê dele.
- [host GPU](project/host-setup.md) — O servidor `192.168.15.199` (GTX 1660 Super, 6 GB) onde rodam os containers do eclume e do lumea, acessado por `docker --context gpu-host`.
- [importação no desktop](standards/code/desktop-importacao.md) — Um arquivo de áudio ou vídeo trazido para o app desktop pelo diálogo ou arrastado para a janela, com a data lida do arquivo e confirmada, convertido para Ogg/Opus (ou copiado como está) e enviado com `source: upload`.
- [impressão de voz](standards/code/identificacao-por-voz.md) — Conjunto de amostras de uma pessoa (embeddings de locutores confirmados como ela, do mesmo modelo da diarização), comparado por centroide para sugeri-la em transcrições novas; dado biométrico sensível pela LGPD, só com a identificação ligada na plataforma e só entre as pessoas do dono.
- [impressão digital da CA](standards/code/server-mcp-e-dispositivos.md#fixação-da-ca-pelos-apps) — SHA-256, em hex, do DER do certificado raiz do Caddy publicado em `/downloads/eclume-root.crt`; os apps a conferem para fixar essa raiz sem instalá-la no sistema.
- [início da gravação](standards/code/formato-audio-upload.md#o-início-da-gravação-lido-antes-da-conversão) — O `recorded_at` de uma gravação importada, lido dos metadados do arquivo antes da conversão e confirmado pela pessoa no modal Importar.
- [locutor](standards/code/server-nucleo.md#pessoas-coleções-e-edição-da-transcrição) — Voz distinta que a diarização separa numa transcrição ("Locutor 1"), ligada a uma pessoa do diretório à mão ou pela identificação por voz.
- **lumea** — Plataforma de desenvolvimento humano e organizacional da EK, que importa transcrições do eclume por PAT.
- [marcador](standards/code/server-nucleo.md#gravação-data-natureza-e-marcadores) — Instante de uma gravação (`at_ms`), com nota opcional e o dispositivo que marcou, enviado pelos apps de forma idempotente por `client_id`.
- [Mediabunny](standards/code/formato-audio-upload.md) — Biblioteca TypeScript de demux, conversão e mux sobre WebCodecs, a via principal da conversão de mídia no navegador.
- [mock server](../contracts/README.md) — Prism servindo o bundle do contrato v1 com as fixtures (`deploy/docker-compose.mock.yml`, `127.0.0.1:4010`), contra o qual o lumea, o desktop e o web desenvolvem sem o backend.
- [nota de voz](standards/code/server-nucleo.md#gravação-data-natureza-e-marcadores) — Gravação de `kind: note` (uma pessoa ditando uma ideia ou lembrete), que passa pelo mesmo pipeline da reunião (`kind: meeting`); é o termo da tela, do desktop e do MCP.
- **OKF** — Open Knowledge Format: o formato do bundle `docs/`, com homes fixas e frontmatter por doc.
- [origem da data](standards/code/server-nucleo.md#gravação-data-natureza-e-marcadores) — De onde veio o início da gravação (`recorded_at_source`): `capture` (relógio do app), `file_metadata` (metadados do arquivo, confirmados na importação), `user` (digitada) ou `upload` (hora do envio).
- [origem do valor](standards/code/processamento-automatico.md) — De onde veio o valor de um campo: `auto` (o agente), `edited` (o usuário escreveu) ou `accepted` (o usuário aceitou o automático); os dois últimos o automático não sobrescreve.
- [padrão de título](standards/code/processamento-automatico.md) — Modelo do título que um tipo de agenda aplica à gravação, com os marcadores `{assunto}`, `{data}`, `{tipo}` e `{<chave do campo>}`.
- [painel de administração](standards/code/frontend-web.md) — App à parte dentro do web (`/admin/entrar`, `/admin/*`), com login, sessão e moldura próprios, onde a conta de admin configura a plataforma sem ver conteúdo de usuário.
- [painel de filtros](standards/code/frontend-web.md#biblioteca-no-tempo) — O `.filters` recolhível à direita da biblioteca (tipo, situação, tags, pessoas, coleções e campos do usuário), cujos filtros vão na URL e na consulta.
- [parada por silêncio](standards/code/desktop-gravacao.md#nota-de-voz-e-parada-por-silêncio) — O fim automático da nota de voz depois de 2, 4 ou 8 s sem fala, decidido pelo detector de energia do app desktop; sem voz nos primeiros 10 s, a nota é descartada.
- [participante](standards/code/frontend-web.md#pessoas-busca-e-coleções) — Pessoa do diretório ligada a um locutor da gravação; o filtro Participantes da biblioteca casa empresa, área e tag de pessoa de um mesmo participante.
- [pasta sincronizada](standards/code/desktop-pasta-sincronizada.md) — Pasta do computador que o app desktop mantém como espelho da biblioteca: o resumo atual de cada gravação em Markdown e a transcrição em JSONL, uma subpasta por coleção e um `AGENTS.md` na raiz, para servir de vault do Obsidian e de pasta de trabalho de agente.
- [PAT](standards/code/server-nucleo.md#autenticação) — Personal Access Token (na tela, token de acesso): token pessoal `eclp_` com escopos, guardado como hash, usado pelo lumea e pelos assistentes (MCP) para acessar a API; o desktop e o celular usam a credencial de dispositivo.
- [Perguntar](standards/code/server-agentes.md#chat-sobre-a-base) — A tela de perguntas sobre todas as gravações do usuário (`/perguntas`, o chat sobre a base), item em destaque da navegação do web, que responde citando as gravações em que se apoia.
- [pessoa](standards/code/server-nucleo.md) — Entrada do diretório do usuário a que os locutores das transcrições são ligados; base do filtro `person=` do lumea.
- **pilar** — Uma das pastas de topo do monorepo com toolchain própria: `server/`, `worker-gpu/`, `engines/`, `web/`, `desktop/`, `mobile/`, `contracts/`, `deploy/`.
- [pré-processamento](standards/api/jobs-transcricao.md#pré-processamento) — Tratamento do áudio pelo worker GPU antes do ASR, configurado pelo admin: 16 kHz mono, redução de ruído (RNNoise), normalização de loudness, corte do silêncio das pontas e separação de canais.
- [primeira execução](standards/code/desktop-deteccao-e-sync.md#primeira-execução-descoberta-e-ca-fixada) — A tela "Bem-vindo" do app desktop sem credencial: o servidor do instalador, achado na rede ou digitado, a CA fixada pela impressão digital e a entrada por e-mail e senha ou código de pareamento.
- [provider](standards/code/server-agentes.md#providers) — Acesso a um modelo de linguagem (`claude-cli`, `anthropic`, `openai-compatible` ou `ollama`) que o admin cadastra na plataforma e marca com as finalidades.
- [Rede do eclume](standards/code/mobile-app.md#rede-do-eclume-e-sync) — Estado do app móvel em que ele pode sincronizar: Wi‑Fi não medido e o `GET /api/v1/server` respondendo pela CA fixada com a mesma impressão digital; fora dela, nada sai pelos dados móveis.
- [referência da gravação](standards/code/desktop-pasta-sincronizada.md#layout) — Os 8 primeiros caracteres do id de uma gravação ("ref. 01928f3a"), mostrados sob o título no eclume web e usados como sufixo do nome dos arquivos da pasta sincronizada do desktop, para ligar um arquivo à gravação.
- [regra de preenchimento](standards/code/processamento-automatico.md) — O "como identificar" de um campo: a instrução que o agente segue para preenchê-lo a partir da transcrição.
- [regra do assunto](standards/code/processamento-automatico.md#tipos-de-agenda) — A regra (`title_instructions`) que o agente segue para escrever o `{assunto}` do título de uma gravação, definida em cada tipo de agenda; vazia, vale a do tipo de reserva.
- [revisão da transcrição](standards/code/processamento-automatico.md#o-pipeline-por-revisão) — Cada transcrição de uma gravação, numerada (`transcription_jobs.revision`): retranscrever abre uma revisão nova e refaz a cadeia do pipeline, cujas etapas valem por revisão.
- [RLS](standards/code/server-nucleo.md) — Row-Level Security do Postgres: as políticas por dono (`app.user_id`) que isolam os dados do eclume sob o papel `eclume_app`.
- [segredo da plataforma](standards/code/server-admin.md) — Valor sensível (`hf_token`, `anthropic_api_key`) de `platform_secrets`, gravado cifrado pelo painel de administração, só de escrita: a API nunca o devolve; o token do Hugging Face fica em Locutores, e a chave da Anthropic, em Agentes.
- [Serviço de gravação (Android)](standards/code/mobile-app.md#plugin-nativo-e-serviço-em-primeiro-plano) — O serviço em primeiro plano do tipo microfone do app móvel, com a notificação contínua (Pausar, Marcador, Parar), que mantém a gravação com a tela bloqueada.
- [servidor MCP](standards/code/server-mcp-e-dispositivos.md#servidor-mcp) — O Model Context Protocol do eclume em `/mcp`, no processo do server, sem estado e só com Bearer `eclp_`: ferramentas para um assistente buscar, ler e editar gravações, resumos e campos, cada uma com o escopo do token.
- **spec** — Unidade de trabalho do ciclo Quenching, guardada como issue do GitHub e conduzida por `develop` → `execute` → `conclude`.
- [sugestão por voz](standards/code/identificacao-por-voz.md) — Pessoa proposta para um locutor sem pessoa quando a voz passa do limiar da plataforma mas não do de atribuição da conta; só vira vínculo quando alguém aceita.
- [tag de pessoa](standards/code/frontend-web.md#pessoas-busca-e-coleções) — Rótulo livre de uma pessoa do diretório (como "cliente" ou "diretoria"), separado das tags das gravações; filtra a biblioteca pelos participantes.
- [Tempo de áudio](standards/code/desktop-gravacao.md#pausa-tempo-de-áudio-e-nível) — O tempo gravado sem as pausas: o relógio das telas de gravação, o `at_ms` dos marcadores e o `duration_ms` do upload.
- [tipo de agenda](standards/code/processamento-automatico.md) — Categoria de gravação do usuário (reunião de equipe, 1:1…) com como identificar, padrão de título, tags padrão e as instruções do resumo; o agente detecta o tipo depois da transcrição.
- [tipo de agenda padrão](standards/code/server-admin.md) — Tipo de agenda mantido pelo admin na plataforma e copiado para cada conta nova no cadastro.
- [tipo de reserva](standards/code/processamento-automatico.md#tipos-de-agenda) — O tipo de agenda de cada conta ("Geral", com o selo "Padrão" na tela) que não pode ser excluído e fica com a gravação quando nenhum outro tipo se encaixa com confiança (abaixo de 0,6), sem outros tipos, sem agente de detecção ou com a detecção falha. Não confundir com os tipos de agenda padrão do admin.
- [token de acesso](standards/code/server-mcp-e-dispositivos.md#grupos-da-tela-conexão-mcp) — O PAT como a tela o chama: criado pela pessoa em Conexão MCP, com grupos de escopo e validade, para um assistente ou outro programa usar o eclume em seu nome.
- [updater](standards/code/desktop-distribuicao.md) — Atualização automática do app desktop pelo plugin do Tauri: lê `latest.json` em `/downloads/` do servidor eclume e só instala o pacote assinado com a chave minisign do eclume.
- [versão do resumo](standards/code/server-agentes.md#versões-e-edição) — Cada estado do resumo de uma transcrição, numerado por transcrição e com origem `generated` (agente), `manual` (edição à mão ou volta à gerada) ou `chat`; a atual é a de maior número concluída.
- [WhisperX](project/referencias.md) — Biblioteca de ASR (faster-whisper em lote, alinhamento por palavra, diarização pyannote) usada como motor no worker GPU.
- **worker CPU** — O processo arq do pacote `server` (`eclume_server.worker`, fila `eclume:default`) que ingere as transcrições do worker GPU e descarta uploads vencidos.
- **worker GPU** — O processo arq do pilar `worker-gpu/` que roda ASR, alinhamento, diarização e embeddings num único processo CUDA.
