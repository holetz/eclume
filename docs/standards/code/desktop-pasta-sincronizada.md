---
type: standard
title: Pasta sincronizada do app desktop
description: O app desktop espelha a biblioteca do usuário numa pasta local — o resumo atual de cada gravação em Markdown com front matter e a transcrição em JSONL, uma subpasta por Collection, um AGENTS.md na raiz e um manifesto que só deixa o app mexer no que ele criou — para servir de vault do Obsidian e de pasta de trabalho de agente; estes são o layout, os formatos, o ciclo incremental, a sobrescrita e o que o servidor precisa oferecer.
resource: desktop/crates/mirror/**, desktop/src-tauri/src/mirror_sync.rs, desktop/src-tauri/src/config.rs, desktop/src-tauri/src/state.rs, desktop/ui/js/vistas/configuracoes.js, desktop/crates/sync/src/protocol.rs
tags: [code, desktop, sync, markdown, jsonl, obsidian, agentes, collections]
timestamp: 2026-09-29
audience: both
authority: current
source: holetz/eclume#68
maintainer: holetz
---

# Pasta sincronizada do app desktop

O app desktop mantém, se a pessoa ligar, uma pasta do computador que espelha a **biblioteca dela**
(não só o que aquele computador gravou): o resumo atual de cada gravação em `.md` e a transcrição
em `.jsonl`. A pasta serve a dois usos ao mesmo tempo: **vault do Obsidian** e **pasta de trabalho
de um agente** (Claude Code, Codex etc.). O servidor é a fonte; a pasta é um espelho.

A lógica pura vive no crate `eclume-mirror` (`desktop/crates/mirror`), sem Tauri nem rede (o app
móvel também compila `desktop/crates`); o app (`desktop/src-tauri/src/mirror_sync.rs`) só lê do
servidor e chama o crate. Configuração em `config.json` (`mirror`), aba **Pasta** das
Configurações. O que a pessoa lê está no artigo de ajuda `pasta-sincronizada` do web.

## Layout

```
<raiz>/
  AGENTS.md                                   ← gerado pelo app
  .eclume-sync.json                           ← manifesto (o Obsidian ignora dotfiles)
  <Collection>/
    AAAA-MM-DD <título> - <id8>.md            ← resumo atual
    AAAA-MM-DD <título> - <id8>.jsonl         ← transcrição (se ligada)
  sem-colecao/                                ← gravações sem Collection
```

- **Collections viram subpastas.** O servidor tem Collections planas (sem hierarquia) e uma
  gravação pode estar em várias: ela é escrita **em cada uma** (cópias idênticas).
- **Nome-base** = data (`recorded_at`, ou `0000-00-00`), título e os 8 primeiros caracteres
  alfanuméricos do id da gravação: único e estável mesmo com títulos repetidos.
- **Nomes seguros** (`layout::slug`): caracteres proibidos no Windows (`\ / : * ? " < > |` e
  controles) e os que quebram links do Obsidian (`[ ] # ^`) viram espaço; espaços se juntam;
  ponto e espaço do fim caem; nomes reservados do Windows (`CON`, `NUL`, `COM1`…) ganham `_`;
  o título é limitado a 70 caracteres e a Collection a 50, para o caminho ficar bem abaixo de 260.
  **Maiúsculas, acentos e espaços ficam**: o nome do arquivo é o título da nota no Obsidian.
- Uma gravação sem resumo mas com transcrição escreve só o `.jsonl`; sem nenhum dos dois, nada.

## Formatos

**Resumo (`.md`)**: front matter YAML e o Markdown do servidor.

```yaml
---
source: eclume
recording_id: "01928f3a-1c00-…"
title: "Alinhamento do orçamento"
recorded_at: "2026-09-18T14:00:05Z"
collections:
  - "Clientes"
agenda_type: "Reunião de equipe"     # omitido sem tipo de agenda
summary_version: 3
transcript: "2026-09-18 Alinhamento do orçamento - 01928f3a.jsonl"   # só com transcrição
---
```

**Transcrição (`.jsonl`)**: uma linha por objeto. A primeira é `{"type":"meta", id, recording_id,
title, language, recorded_at, duration_ms, revision, speakers:[{id,label}]}`; as demais,
`{"type":"segment", speaker, speaker_id, start_ms, end_ms, text}`. O Obsidian não indexa `.jsonl`,
então as transcrições, longas, **não poluem a busca nem o grafo do vault**, e um agente as lê com
`rg`/`jq`.

**`AGENTS.md`**: regerado a cada ciclo (a primeira linha é um marcador HTML de arquivo gerado)
com a estrutura, as propriedades, o formato do JSONL e exemplos de busca. Um `AGENTS.md` da
própria pessoa (sem o marcador) **nunca** é sobrescrito.

## O ciclo

Thread própria (`eclume-mirror`, a cada 60 s e a cada mudança de configuração), para uma
biblioteca grande não atrasar o upload das gravações.

1. `GET /collections`, e `GET /recordings?since=<cursor>` (o cursor é o maior `updated_at`
   lido, guardado **no manifesto**: apagar ou trocar a pasta refaz tudo). Na primeira passada a
   listagem já é a biblioteca inteira.
2. Para cada gravação com transcrição: `GET /recordings/{id}/summary` e, se ligadas,
   `GET /transcripts?recording_id=`. Uma falha numa gravação não para as outras, e **o cursor não
   avança** (o próximo ciclo repete, sem custo: a escrita é idempotente).
   **Servidor sem o escopo das transcrições** (403 `insufficient_scope`, um servidor anterior ao
   contrato 2.7.0 ou um token que a migração 018 ainda não alcançou): a primeira recusa vale para o
   ciclo todo, os resumos são escritos, o cursor avança e a aba avisa que falta atualizar o
   servidor. A varredura completa as transcrições que ficaram faltando quando o escopo chegar.
3. **Varredura** a cada 6 h e em "Sincronizar agora": lista a biblioteca inteira, traz o que o
   manifesto ainda não tem e apaga o que saiu do servidor. Só ela apaga; o ciclo incremental nunca.
4. Escreve o `AGENTS.md` e grava o manifesto.

## Sobrescrita e segurança

- **O servidor manda.** O arquivo é reescrito quando o conteúdo em disco difere (hash SHA-256); uma
  edição local num arquivo do app é sobrescrita no ciclo seguinte. Sem mudança, nada é escrito.
- **Só o que o manifesto lista é movido ou apagado** (título ou Collection mudou, gravação
  removida). Arquivos da pessoa na pasta, e pastas que os contenham, ficam. Um caminho do
  manifesto que fuja da raiz (`..`, absoluto) é recusado. Um manifesto ilegível recomeça vazio e
  **não apaga nada**.
- A escrita é atômica (arquivo temporário com ponto e renomeação). A raiz não pode ser a raiz do
  disco.

## O que o servidor oferece (contrato 2.7.0)

- A credencial de dispositivo tem `transcripts:read` (migração `018_dispositivo_le_transcricao`,
  que também estende os tokens já emitidos) além de `recordings:read` e `summaries:read`.
- Um resumo que termina ou é editado move o `updated_at` da gravação **e** da transcrição
  (`summaries.touch_recording`), então `?since=` percebe resumo novo ou refeito.

## Testes

`cargo test -p eclume-mirror` (layout, formatos, manifesto, reconciliação, `AGENTS.md`),
`cargo test -p eclume-desktop -- mirror_sync` (ciclos contra uma fonte falsa: primeira passada,
incremental, varredura, falha parcial) e `cargo test -p eclume-sync` (as leituras do cliente).
A aba e o texto explicativo: `desktop/ui-tests/configuracoes.spec.ts`; no servidor,
`server/tests/test_devices.py` e `test_summaries.py`.
