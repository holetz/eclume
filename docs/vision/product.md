---
type: vision
title: Visão do produto
description: A visão do produto eclume — o registro confirmado (plataforma, usuários, propósito, posicionamento, contexto de uso, compromissos de marca e princípios), projetado no PRODUCT.md para quem desenha, e a direção (estado-alvo, pilares que já são realidade ou ainda direção, e não-objetivos com o motivo).
resource: PRODUCT.md
tags: [product, design]
timestamp: 2026-10-01
audience: both
authority: background
source: entrevista de produto confirmada em /quenching:design:align (2026-09-28) e decisão de produto de 2026-09-26
maintainer: holetz
---

# Visão do produto

Os cabeçalhos do registro (de `Platform` a `Product Principles`) são projetados no `PRODUCT.md`
pela `cq design build`; `Target state`, `Pillars` e `Non-goals` são a direção, fora da projeção.

## Platform

web

## Users

Quem grava reuniões de trabalho e precisa reencontrá-las (cada usuário com espaço próprio, cadastro aberto) e o admin da plataforma, que configura agentes de resumo e opera o host.

## Product Purpose

Gravar reuniões, transcrever na GPU do próprio servidor, separar e reconhecer locutores, organizar por pessoa, localizar pela busca e resumir pelo tipo de agenda, com os agentes que o admin configura.

## Positioning

Transcrição institucional auto-hospedada (open source no futuro), focada em organizar, localizar e reconhecer pessoas; integra-se ao lumea só por contrato de API versionado.

## Operating Context

Ferramenta de trabalho em desktop, na LAN, com sessões longas de leitura e revisão de transcrições; tema claro e escuro.

## Brand Commitments

Paleta linho e nogueira do ecossistema Jane, Archivo + IBM Plex Mono, raio zero, fios de 2px, terracota só para gravação e falha; produto em pt-BR.

## Product Principles

Regras que valem para qualquer tela; uma proposta que as contrarie está desenhando outro produto.

- **Conta isolada.** Cada conta vê só o que é dela; não há compartilhamento entre contas.
- **Sem transcrição ao vivo.** O eclume trabalha sobre a gravação terminada.
- **Nunca grava sem mostrar.** Toda gravação, em qualquer aparelho, tem indicação visível.
- **O admin não vê conteúdo.** Quem administra cuida da configuração e da saúde da plataforma, sem
  acesso às gravações, transcrições e resumos das contas.
- **Quem grava responde pelo consentimento** de quem é gravado, pelo aceite do aviso no cadastro.
- **O aparelho grava, o servidor processa.** O aparelho grava e envia; transcrever, classificar e
  resumir é trabalho do servidor.

## Target state

Cada pessoa grava o trabalho em qualquer aparelho que tem à mão, e o servidor da casa transforma a
gravação em algo que se lê e se reencontra: transcrição com locutores reconhecidos, tipo de agenda,
campos e resumo, organizados no tempo, por pessoa, coleção e tag, e consultáveis por busca e por
pergunta. A conta é de cada um, o admin opera a plataforma sem ver conteúdo, e o mesmo servidor
serve a web, o desktop, o celular e as integrações. Adiante, o eclume é software aberto que
qualquer instituição instala e opera no próprio host.

## Pillars

Cada pilar é **realidade**, com a norma que o governa, ou **direção**, sem norma ainda.

- **Conta por usuário** — realidade: cadastro aberto, sem convite e sem confirmação de e-mail,
  aceite do aviso e exclusão pela própria pessoa ([server-nucleo.md](../standards/code/server-nucleo.md),
  [contrato-v1.md](../standards/api/contrato-v1.md)).
- **Admin com login próprio** — realidade: agentes, tipos de agenda padrão, pré-processamento e
  saúde ([server-admin.md](../standards/code/server-admin.md), [frontend-web.md](../standards/code/frontend-web.md)).
- **Captura em qualquer aparelho** — realidade: o desktop detecta reuniões com políticas por app,
  grava a nota de voz pelo botão, pela bandeja ou pelo atalho (com parada por silêncio) e importa
  com a data do arquivo e marcadores; o celular é gravador portátil; a web importa pelo modal
  ([desktop-deteccao-e-sync.md](../standards/code/desktop-deteccao-e-sync.md),
  [desktop-gravacao.md](../standards/code/desktop-gravacao.md),
  [desktop-importacao.md](../standards/code/desktop-importacao.md), [mobile-app.md](../standards/code/mobile-app.md),
  [formato-audio-upload.md](../standards/code/formato-audio-upload.md)).
- **Aparelho que acha o servidor sozinho** — realidade: instalador com o endereço, mDNS, código de
  pareamento e CA fixada ([server-mcp-e-dispositivos.md](../standards/code/server-mcp-e-dispositivos.md),
  [desktop-deteccao-e-sync.md](../standards/code/desktop-deteccao-e-sync.md)).
- **Processamento automático** — realidade: pré-processamento, transcrição, tipo de agenda, campos
  e resumo ([processamento-automatico.md](../standards/code/processamento-automatico.md),
  [jobs-transcricao.md](../standards/api/jobs-transcricao.md)).
- **Gravação centrada no resumo** — realidade: resumo editável à mão ou pelo chat, e Perguntar
  sobre a base ([server-agentes.md](../standards/code/server-agentes.md),
  [frontend-web.md](../standards/code/frontend-web.md)).
- **Biblioteca no tempo** — realidade: semana, mês, lista e filtros, busca, pessoas, coleções e
  tags ([frontend-web.md](../standards/code/frontend-web.md), [server-nucleo.md](../standards/code/server-nucleo.md),
  [processamento-automatico.md](../standards/code/processamento-automatico.md)).
- **Reconhecer pessoas pela voz** — realidade
  ([identificacao-por-voz.md](../standards/code/identificacao-por-voz.md)).
- **Integrações** — realidade: PAT (o lumea), servidor MCP e pasta sincronizada no desktop
  ([contrato-v1.md](../standards/api/contrato-v1.md),
  [server-mcp-e-dispositivos.md](../standards/code/server-mcp-e-dispositivos.md),
  [desktop-pasta-sincronizada.md](../standards/code/desktop-pasta-sincronizada.md)).
- **Ajuda dentro do produto** — realidade
  ([web-central-de-ajuda.md](../standards/code/web-central-de-ajuda.md)).
- **Nota de voz também por comando de voz** (palavra de ativação) — direção. Só entra com um modelo
  pt-BR que rode offline, leve e de licença permissiva, sem microfone aberto escondido (respeita
  "nunca grava sem mostrar") e sem disparar a cada menção ao produto numa reunião.
- **Código aberto e auto-hospedável por terceiros** — direção: qualquer instituição instala e
  opera o eclume no próprio host.

## Non-goals

- **Organização, tenant, grupos e convites** — a conta por usuário os substituiu.
- **Compartilhamento entre contas** — cada conta guarda o próprio trabalho; o que é de outra
  pessoa chega por ela.
- **Transcrição ao vivo e bots que entram na chamada** — o produto trabalha sobre a gravação
  terminada, e um bot na chamada seria gravar sem o aparelho mostrar.
- **Confirmação de e-mail no cadastro** — o cadastro é aberto e o host é da casa; a confirmação só
  adiaria o uso.
- **Consentimento de voz por pessoa** — o aceite do aviso no cadastro o substituiu.
- **"Cliente" como entidade** — coleção e tag cobrem o agrupamento por cliente.
