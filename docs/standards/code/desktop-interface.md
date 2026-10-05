---
type: standard
title: Interface do app desktop no Design System
description: A janela e a bandeja do app desktop seguem o Design System do eclume — HTML e módulos ES sem framework nem bundler, eclume.css fiel (a mesma cópia do web), fonts.css e app.css, o tauri.js como único contato com o Tauri, uma seção por vista, tema escolhível (Sistema, Claro ou Escuro), CSP sem estilo inline, ícones Lucide embutidos, os atalhos globais por modo (global, portal do Wayland ou atalho do sistema) e os da janela, a janela no Linux, o menu de ajuda, o aviso "Atualizado para X", o painel Recentes no topo da principal e os testes Playwright com o Tauri simulado.
resource: desktop/ui/**, desktop/ui-tests/**, desktop/scripts/sincronizar_ds.sh, desktop/scripts/cdp.mjs, desktop/src-tauri/tests/ui_assets.rs, desktop/src-tauri/src/shortcuts.rs, desktop/src-tauri/tauri.conf.json
tags: [code, desktop, design-system, ui, css, tauri, playwright, atalhos]
timestamp: 2026-10-05
audience: both
authority: current
source: holetz/eclume#40, holetz/eclume#57, holetz/eclume#88, holetz/eclume#125, holetz/eclume#130, holetz/eclume#114, holetz/eclume#120, holetz/eclume#141, holetz/eclume#147
maintainer: holetz
---

# Interface do app desktop no Design System

A janela (520 × 600) e o menu da bandeja do app desktop seguem os frames de
`design-system/examples/desktop.html`, do Design System do eclume, na variante A onde o frame
marca "Pending stage 2". Os textos ficam em pt-BR. O mesmo DS vale para o web
([web-design-system.md](web-design-system.md)), e as duas cópias do CSS são uma só.

## Sem framework

- A UI é HTML e JS em **módulos ES nativos** (`<script type="module">`), servidos pelo protocolo
  do Tauri como `frontendDist` estático. Não há bundler, lockfile nem passo de build: o
  `cargo tauri build` e o `cargo xwin` do host seguem sem Node.
- São cinco vistas com o estado todo vindo do Rust. Um framework traria bundler e build no
  release só para desenhar listas.

## Camadas de estilo

Na ordem do `index.html`:

| Arquivo | O que tem |
|---|---|
| `fonts.css` | `@font-face` de Archivo 400–800 e IBM Plex Mono 400/500, subconjunto latin, apontando para `fonts/*.woff2` (com o `OFL.txt`) |
| `eclume.css` | cópia fiel do `styles.css` do DS sem o `@import` do Google Fonts; **byte a byte igual** a `web/src/styles/eclume.css` |
| `app.css` | só produto: `.tray.tray-window` ocupando a janela inteira, as utilidades que os exemplos fazem por `style=""` (`.row`, `.stack`, `.grid-2`...), o medidor de 16 barras, os campos da primeira execução |

- **Sincronizar.** O `desktop/ui/eclume.css` é gerado de `design-system/styles.css` pelo
  `uv run python design-system/sincronizar.py`, junto das cópias do web e do celular
  ([web-design-system.md](web-design-system.md)); o `bash desktop/scripts/sincronizar_ds.sh` só
  baixa as fontes do `@fontsource` por `npm pack` num diretório temporário, na mesma versão do
  web, sem depender de `web/node_modules`. Ajuste de produto vai em `app.css`, nunca no `eclume.css`.
- **CSS com LF.** O `.gitattributes` fixa `*.css text eol=lf`: o teste de igualdade compara bytes,
  e um checkout Windows com `core.autocrlf=true` levaria o do web com CRLF.
- **Tokens.** As classes do DS já usam `--color-rec` (terracota, reservada à gravação),
  `--speaker-2` e `--color-success`. O mapa `--rec → --color-accent` do readme do DS contradiz a
  seção Color, e vale a seção Color. Os `--radius-*` valem 0: todo canto é reto.

## CSP e DOM

- A CSP da janela é `default-src 'self' ipc: http://ipc.localhost`. Ela bloqueia `style=""`, e
  nenhum atributo de estilo entra no HTML. Valores dinâmicos (o `--h` de cada barra do medidor)
  vão por `el.style.setProperty`, que a CSP permite.
- A janela não carrega nada de fora: nem fonte, nem script, nem imagem.
- O DOM é montado por `dom.js` (`el(tag, attrs, ...filhos)`, `trocar`, `$`), sem `innerHTML` com
  dado vindo do servidor ou do disco. `$` falha alto quando a marcação mudou.
- `icones.js` embute os ícones Lucide usados (engrenagem, ajuda, voltar, fechar, copiar, microfone) como
  SVG, com a licença ISC no cabeçalho; `data-icone="<nome>"` no HTML recebe o SVG na carga.

## Módulos e vistas

- **`tauri.js`** é o único lugar que toca o Tauri: `invoke`, `listen` e `versao` resolvem
  `window.__TAURI__` (o `withGlobalTauri`) a cada chamada, para os testes injetarem o mock antes.
- **`vocabulario.js`** é cópia byte a byte de `web/src/lib/vocabulario.js` (o vocabulário de
  estados compartilhado, [frontend-web.md](frontend-web.md)); a fila de envio tira dele os rótulos e
  o tom dos estados no aparelho (Gravando, Aguardando envio, Enviando, Enviada, Falhou o envio), e
  um envio que falhou mostra o `last_error` em texto na própria linha (`.fila-erro`), não só no
  `title`. Mude o texto no web e copie o arquivo; nunca edite a cópia.
- **`main.js`** registra as vistas, uma `<section data-vista>` cada, e só uma fica visível. Ele
  aplica o tema, trata as teclas da janela e consulta `status`, `recordings` e `recent` a cada 1 s
  (e no evento `status-changed`); uma falha do `recent` mantém o último painel e não impede o
  resto de desenhar. Sem credencial (`connection: first_run`), a janela fica na primeira
  execução, e as teclas da janela não valem.
- **`vistas/*.js`** exportam `montar(secao, app)`, que devolve `{ entrar?, sair?, atualizar? }`:

| Vista | Frame do DS | O que mostra |
|---|---|---|
| `principal` | Main window, Voice note, Automatic recording, After an update | o painel Recentes no topo, linha de status, gravar, "Nova nota" e "Importar arquivo…", medidor e marcadores, política do app, pergunta de reunião, fila de envio e conta |
| `primeira-execucao` | First run | servidores conhecidos, conferência da impressão digital, e-mail e senha, e em "Avançado" o código de pareamento e o endereço |
| `importar` | Import file | a data lida do arquivo escolhido com a origem e o progresso da conversão; a área de soltar recebe um arquivo arrastado ou abre o seletor de novo |
| `configuracoes` | Settings · Meetings, Audio, Storage, Server | as seis abas, nesta ordem: Geral (Aparência, Início e Avisos; abre por padrão), Reuniões (detecção e política por app, com a parada automática), Áudio, Armazenamento, Pasta e Servidor; `app.ir("configuracoes", { aba })` abre outra |
| `atalhos` | — (menu de ajuda) | a folha com os atalhos globais e os da janela |

- **Tema.** "Aparência", na aba Geral, escolhe Sistema (o padrão), Claro ou Escuro
  (`theme` na config, que o `status` também traz). Em Sistema, `data-theme` em `<html>` segue
  `prefers-color-scheme`, como o readme do DS pede, e acompanha a troca do sistema com o app
  aberto; Claro e Escuro vencem o sistema. O DS só tem o escuro sob `data-theme="dark"`, então o
  atributo é sempre gravado.

## Painel Recentes

- O topo da principal, logo abaixo da linha da marca e antes da linha de status, tem o painel
  **Recentes** (`#recentes`, montado por `recentes.js`): as últimas N gravações da conta que o
  comando `recent` entrega ([desktop-deteccao-e-sync.md](desktop-deteccao-e-sync.md) §Painel de
  gravações recentes). N vem de Configurações → Geral → "Gravações recentes na janela" (Ocultar,
  3, 5 ou 10; 5 por padrão); Ocultar esconde o painel.
- **Duas linhas em Geral, uma por lugar.** Logo abaixo, "Gravações recentes no menu da bandeja"
  (`#recentes-bandeja-quantidade`: Ocultar, 1, 3 ou 5; 1 por padrão) salva `tray_recent_count`
  na hora, apartada da janela; os rótulos dizem "na janela" e "no menu da bandeja" para a
  diferença ficar clara. O menu em si é nativo, montado no Rust
  ([desktop-gravacao.md](desktop-gravacao.md) §App e bandeja).
- **Compacto para 520 × 600.** Cabeçalho de uma linha (o kicker "Recentes" e, quando há,
  "N precisam de você" em `.badge-warning`) e uma linha por gravação numa grade de três colunas:
  o título com reticências (sem título, a data curta "dd/mm hh:mm"), o `.badge` do estado e a
  ação `btn-sm`. Uma segunda linha `.recente-detalhe` só aparece quando há o que dizer: o
  `<progress class="progress">` da transcrição com o % em texto, a frase da espera
  (`fraseDaEspera`), o motivo (`motivo`) ou o erro de uma ação.
- **Rótulos do vocabulário.** O Rust entrega a fase; `recentes.js` tira os rótulos de
  `vocabulario.js`: `ESTADOS_APARELHO` no aparelho, `ESTADOS_SERVIDOR` na fila e pronta, o
  `andamento` de `ETAPAS` ("Transcrevendo", "Resumindo"), e os textos dos desfechos ("Resumo
  pronto", "O resumo falhou", "A transcrição falhou", "Pronta sem resumo"). Um estado desconhecido
  vira "Precisa de você", com a etapa, o código e "resolva no web".
- **Alertas em texto.** A linha com alerta leva `.recente-alerta`, o motivo em texto na segunda
  linha e a ação que resolve: **Abrir no web** (`open_recording`) ou **Tentar agora**
  (`sync_now`). Estado nunca só por cor.
- **Copiar resumo** (com o ícone copiar) chama `copy_summary`; o retorno ("Copiado" no botão e
  "Resumo copiado em Markdown." num `role="status"`, ou o erro) fica na linha por 2,5 s, guardado
  por chave para sobreviver ao redesenho de cada segundo. Ao entrar, a principal chama
  `recent_refresh` para o painel não esperar a próxima volta da leitura.

## Atalhos

- **Globais**, registrados no Rust (`shortcuts.rs`, sem permissão de JS): alternar a gravação,
  nova nota (que também para a nota em curso) e marcador (só com gravação ativa).

| SO | Gravar | Nova nota | Marcador |
|---|---|---|---|
| Windows e Linux | `Ctrl+Alt+R` | `Ctrl+Alt+N` | `Ctrl+Alt+M` |
| macOS | `⌘⇧R` | `⌘⇧N` | `⌘⇧K` |

  O `Ctrl+Shift` do DS roubaria atalhos de uso diário, porque o registro captura a tecla no
  sistema inteiro: `Ctrl+Shift+M` é o mudo do Teams, `Ctrl+Shift+N` a janela anônima do Chrome e
  `Ctrl+Shift+R` o recarregar sem cache. No ABNT2, o AltGr (`Ctrl+Alt`) não usa R, N nem M. No
  Mac, `⌘⇧M` é o mudo do Teams.
- Os atalhos ficam em `config.json` (`shortcuts: {record, note, marker}`) e mudam em Áudio →
  "Alterar", que captura a próxima combinação na janela. O texto é validado por
  `Shortcut::from_str` ao salvar.
- **Três modos por sessão**, que a aba Áudio explica numa linha (`ShortcutMode` no
  `SettingsView`):

| Modo | Quando | Como o atalho chega |
|---|---|---|
| `global` | X11, Windows, macOS | `tauri-plugin-global-shortcut`; falha de registro vira "Em uso por outro app" (outro app tem a combinação) ou "Indisponível nesta sessão" (o plugin não subiu) |
| `portal` | Wayland com `org.freedesktop.portal.GlobalShortcuts` (KDE, GNOME 48+) | `ashpd`: uma sessão com os três atalhos, o gatilho preferido no formato do XDG (`CTRL+ALT+r`) e o sinal `Activated`; o sistema pode pedir confirmação. Registrar de novo fecha a sessão anterior |
| `system` | Wayland sem o portal (GNOME 46) | o atalho é do sistema e chama `eclume-desktop --alternar-gravacao`, `--nova-nota` ou `--marcador`; a instância única (`tauri-plugin-single-instance`) entrega a flag à instância aberta, e sem instância o app abre e faz a ação. No GNOME, "Criar atalhos no GNOME" grava custom-keybindings em `…/custom-keybindings/eclume-<ação>/` (nome "eclume · …", combinação no formato do GTK, `<Control><Alt>n`); criar de novo só regrava, remover não toca nos atalhos da pessoa, e com eles criados cada registro os regrava com as combinações e o executável de agora (o AppImage, quando é por ele). Fora do GNOME, a aba mostra o comando de cada ação. Sem o atalho do sistema, a linha diz "Crie o atalho no sistema" |

  Numa sessão Wayland o app começa em `system` e passa a `portal` quando o portal responde. O
  botão e a bandeja valem em todos os modos.
- **Da janela**, por `keydown` no JS: `Ctrl/⌘+O` importar, `Ctrl/⌘+,` configurações,
  `Ctrl/⌘+/` atalhos e `Esc` volta à principal. "Importar arquivo…" e `Ctrl/⌘+O` abrem direto o
  seletor de arquivos do sistema (`tauri-plugin-dialog`); escolhido um arquivo, a vista
  `importar` abre com ele, e desistir deixa a janela onde estava.

## Janela no Linux

- A barra de título é a nativa. No Wayland, o tao até a 0.35 cobria a HeaderBar do GTK com um
  `EventBox` acima dos botões, e minimizar e fechar não recebiam o clique até a janela ser
  realocada (tauri-apps/tauri#13440); por isso o `Cargo.toml` fixa o Tauri em 2.12 ou mais, que
  traz o tao 0.37 com a correção. Não há barra de título própria em nenhum sistema.
- Fechar esconde a janela (o app segue na bandeja), como nos outros sistemas.

## Início com o computador

- A aba Geral das configurações tem a chave **Iniciar com o computador** (`#iniciar-com-o-sistema`, na
  seção "Início", antes de "Avisos"), **ligada por padrão** e salva na hora como as outras.
- A preferência é `Config.autostart` (padrão `true`, inclusive numa config de versão anterior). O
  app **concilia** o registro do sistema a ela a cada abertura e a cada salvar
  (`reconcile_autostart`), em vez de registrar uma vez: um caminho que mudou se corrige sozinho, e
  quem desligou continua desligado depois de reabrir ou atualizar. Um build de desenvolvimento
  (`debug_assertions`) não registra, e uma falha do sistema só vai ao log.
- Iniciado pelo sistema (`--autostart`), o app sobe **só na bandeja**: a janela nasce escondida
  e só abre pelo item da bandeja ou por um atalho.

## Ajuda e atualização

- O ícone de ajuda abre um `.menu`: "Primeiros passos" (o artigo `primeira-gravacao`) e
  "Permissões de microfone" (`permissoes-de-microfone`), abertos em `<web_url>/ajuda/<artigo>`, "Atalhos de teclado", "Abrir a central de ajuda", "Relatar um
  problema…" (abre a pasta de logs, com a dica "Anexe o eclume.log": o servidor é local e não
  há formulário) e a linha da versão. Todo artigo que a UI pede ao `open_help` tem de existir em
  `web/src/features/help/articles/`: o teste `ui_assets` extrai os slugs de `desktop/ui/js` e
  falha sem o `.md`, e o filtro `desktop` da CI inclui os artigos.
- Depois de uma atualização automática, a principal mostra o `.alert-success` "Atualizado para
  X" com as notas do release até a pessoa fechar ([desktop-distribuicao.md](desktop-distribuicao.md)).

## Testes

- **`ui_assets`** (`desktop/src-tauri/tests`, no `cargo test`): o `eclume.css` e o
  `js/vocabulario.js` iguais aos do web,
  nenhuma URL `http(s)://` na UI, as fontes declaradas existentes com o `OFL.txt`, nenhum
  `style=""` e o `index.html` carregando só arquivos que existem. Por isso nem um `placeholder`
  leva `https://`.
- **Playwright** (`desktop/ui-tests`, no job `desktop` da CI e no host): o próprio teste serve
  `desktop/ui`, aborta e registra toda requisição de fora e injeta `mock-tauri.js`, que simula
  `window.__TAURI__` com cenários (`window.__mock.cenario(nome)`: ocioso, gravando, nota,
  marcadores, pergunta, fila, vazio, atualizado, atalhoEmUso, pat, primeiraExecucao, semServidor,
  caMudou, recentes) e registra cada comando em `__mock.chamadas`. O `recent` responde em todo
  cenário (vazio fora de `recentes`), e o `copy_summary` grava o Markdown em
  `__mock.estado.areaDeTransferencia`.
- **`recentes.spec.ts`** confere o painel no topo com as N da configuração, cada fase com o seu
  rótulo e progresso, o estado desconhecido como "Precisa de você" com Abrir no web, o Copiar
  resumo pelo Tauri (e o erro sem copiar nada), o Tentar agora, Ocultar e a ausência de rolagem
  horizontal em 520 × 600 e 380 × 420.
- **`visual.spec.ts`** passa por cada vista em 520 × 600 e 380 × 420, nos temas claro e escuro, e
  confere a Archivo carregada, nenhuma requisição externa, nenhuma rolagem horizontal, os cantos
  retos das peças do DS e o botão de gravar no `--color-rec`. As capturas ficam em
  `desktop/ui-tests/capturas/<vista>-<tamanho>-<tema>.png` (fora do git), para revisão.
- **Na janela real**, `node desktop/scripts/cdp.mjs eval "<expr>"` e
  `node desktop/scripts/cdp.mjs screenshot janela.png` falam com o WebView2 pela porta de
  depuração 9229 ([estacao-windows.md](../../project/estacao-windows.md)), com o `WebSocket`
  nativo do Node 22 e sem dependência.
