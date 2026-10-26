---
type: standard
title: Identificação de pessoas pela voz
description: Como o eclume sugere e atribui quem é cada locutor pela voz — impressão de voz como conjunto de amostras de locutores confirmados, comparação por centroide normalizado no ingest com limiar calibrado, só entre pessoas do dono, sugestão abaixo do limiar da conta e atribuição automática acima dele (antes do resumo), retranscrição que preserva vínculos, e o regime LGPD (liga-desliga da plataforma com purga dos embeddings ao desligar, a conta que deixa de guardar amostras com a purga da conta, o aceite do aviso no cadastro no lugar do consentimento por pessoa, e esquecer a voz de uma pessoa).
resource: server/src/eclume_server/voice.py, server/src/eclume_server/db/migrations/019_atribuicao_automatica_de_locutores.sql, web/src/features/people/AutoAssignCard.tsx, server/src/eclume_server/routes/voice.py, server/src/eclume_server/people.py, server/src/eclume_server/db/migrations/005_identificacao_por_voz.sql, server/src/eclume_server/db/migrations/008_conta_por_usuario.sql, web/src/features/people/VoiceSection.tsx, web/src/features/admin/SpeakersPage.tsx, web/src/features/transcript/SpeakersPanel.tsx, server/src/eclume_server/db/migrations/028_conta_sem_amostras_de_voz.sql, web/src/features/account/AccountPage.tsx
tags: [code, server, web, voz, lgpd, pgvector]
timestamp: 2026-10-05
audience: both
authority: current
source: holetz/eclume#15, holetz/eclume#26, holetz/eclume#32, holetz/eclume#34, holetz/eclume#95, holetz/eclume#97, holetz/eclume#116, holetz/eclume#144
maintainer: holetz
---

# Identificação de pessoas pela voz

Ligar locutores a pessoas à mão em toda transcrição é repetitivo. O eclume aprende a voz de quem
já foi confirmado, **liga sozinho** o locutor cuja voz passa do limiar de atribuição da conta e
**sugere** a pessoa nos casos de menos certeza. Voz é dado biométrico, dado
pessoal sensível pela LGPD (art. 11), então tudo aqui depende de duas travas: o liga-desliga da
plataforma, que só o admin muda, e o aceite do aviso "Sou responsável por pedir o consentimento
das pessoas que gravo", que toda conta dá no cadastro e que substitui o consentimento por pessoa.

## A impressão de voz é um conjunto de amostras

- **Amostra** (`voice_samples`): o embedding de **um locutor confirmado** como a pessoa, copiado
  de `speaker_embeddings` quando o dono liga o locutor (`PATCH` com `person_id`). Guarda também o
  modelo, a fala (`talk_ms`), quem confirmou, quando e o `owner_id` da transcrição.
- **A amostra vive enquanto o vínculo existir.** A FK `(transcript_id, speaker_id) → speakers` tem
  `ON DELETE CASCADE`, e o gatilho `speakers_voice_relink` apaga a amostra quando o `person_id`
  do locutor muda. Desligar, religar a outra pessoa, mesclar, retranscrever ou excluir a gravação
  tiram exatamente a contribuição daquele locutor. Por isso a impressão é um conjunto e não um
  centroide acumulado: um centroide não sabe subtrair o vetor que a mesclagem ou a retranscrição
  já apagaram.
- **Só entra amostra** com a identificação por voz ligada na plataforma e pelo menos
  `MIN_SAMPLE_TALK_MS` (10 s) de fala. A condição mora no próprio `INSERT ... SELECT`
  (`voice.add_sample`), não num `if` antes dele.
- **No new sample from a recording whose audio was deleted** by the audio retention policy
  (`recordings.audio_deleted_at IS NOT NULL`): `_ADD_SAMPLE` joins `recordings` and requires it
  null, so confirming a speaker of such a recording adds nothing. The voiceprints already
  extracted stay and keep matching other recordings; only new contributions stop.
- **A pessoa e a amostra são da mesma conta.** A FK `(person_id, owner_id) → people (id,
  owner_id)` garante que a impressão de uma pessoa só junta vozes das gravações do dono dela.

## Comparação no `ingest_transcript`

- Roda no `system_tx` da ingestão, depois dos embeddings, só quando o job veio com
  `options.embeddings` e a identificação por voz está ligada na plataforma. Filtra o dono da
  transcrição de forma explícita (`s.owner_id = :owner`), porque o papel de conexão não passa pela
  RLS: **só se compara com pessoas do próprio dono**.
- **Impressão = centroide normalizado** das amostras de cada pessoa, do mesmo modelo e da mesma
  dimensão, excluídas as amostras da própria transcrição:
  `l2_normalize(avg(l2_normalize(embedding)))`. **Score = `max(0, 1 − distância de cosseno)`**
  entre o locutor normalizado e o centroide.
- Só se compara locutor sem pessoa e com pelo menos `MIN_COMPARE_TALK_MS` (10 s). Não se sugere
  quem já está ligado a outro locutor da mesma transcrição.
- Acima de `voice_identification.suggestion_threshold`, grava até `MAX_SUGGESTIONS` (3) por
  locutor em `speaker_suggestions` (`pending`, com o `owner_id` da transcrição), do maior score
  para o menor.
- **O limiar padrão é 0,55**, calibrado com fala real em
  [calibracao-voz.md](/docs/project/calibracao-voz.md): FPR de 0,17% e FNR de 3,6% por
  comparação. O admin o ajusta.
- Comparação exata, sem índice ANN. Uma conta tem dezenas de pessoas e centenas de amostras, e o
  índice exigiria dimensão fixa na coluna.

## Atribuição automática

- **Preferência da conta** (`users.voice_auto_assign`, padrão ligada; `users.voice_auto_threshold`,
  padrão 0,75, de 0,50 a 0,99): `GET`/`PATCH /me/voice-assignment`, só sessão. O `PATCH` vale para as
  próximas transcrições e não mexe nos vínculos que já existem. Só tem efeito com a identificação
  por voz ligada na plataforma (`platform_enabled` na resposta); o padrão de 0,75 fica acima do de
  sugestão (0,55), onde a calibração dá FPR de ~0,05% ([calibracao-voz.md](/docs/project/calibracao-voz.md)).
- **Quando liga.** Na mesma comparação do `ingest_transcript` (`voice.suggest`), antes da cadeia de
  campos, tipo de agenda e resumo: o resumo já nasce com o nome da pessoa e não com "Locutor N". A
  primeira candidata do locutor precisa ter pontuação ≥ limiar da conta **e** folga de
  `AUTO_MARGIN` (0,05) sobre a segunda, para não ligar quando duas pessoas têm voz parecida; uma
  pessoa que dois locutores disputam fica com o de maior pontuação. Quem não passa nesses
  critérios só recebe sugestões, como antes.
- **O que grava.** `speakers.person_id`, o `label` com o nome da pessoa e `speakers.auto_score`
  (a pontuação). `auto_score` nulo é vínculo feito ou confirmado por alguém; o `Speaker` da API traz
  `auto_score` para a interface marcar "Atribuído pela voz — 91%".
- **Não reforça a impressão.** A amostra (`voice.add_sample`) só entra com `auto_score IS NULL`:
  uma atribuição errada não vira amostra e não se propaga às próximas. **Confirmar** é o `PATCH` do
  locutor com o mesmo `person_id`; ele zera o `auto_score` e a amostra entra. Trocar ou desligar a
  pessoa também zera.
- **Retranscrição** restaura o vínculo automático como estava (com o `auto_score`, sem amostra);
  depois da restauração, os locutores que sobraram passam de novo pela atribuição.
- **Marcação obrigatória depois da voz** (holetz/eclume#144): com `users.require_speaker_naming`
  ligada, o que a atribuição automática (e a restauração da retranscrição) não ligou para a cadeia
  na etapa `speakers` até o dono ligar cada locutor com pelo menos 10 s de fala a uma pessoa. O
  vínculo automático conta como nomeado; ligar a última pessoa pelo `PATCH` do locutor solta a
  gravação. Vale também com a voz desligada na plataforma. Regras em
  [processamento-automatico.md](processamento-automatico.md#marcação-dos-locutores).
- **Web:** cartão "Atribuição automática" em Pessoas (interruptor e pontuação mínima; só aparece com
  a voz ligada na plataforma) e, no painel de locutores, o selo com **Confirmar** e **Desligar pessoa**.

## Sugestão é só proposta

- `Speaker.suggestions` mostra só as sugestões `pending` de um locutor **sem pessoa**, e só com a
  identificação por voz ligada (`voice.load_suggestions`, em lote, na transcrição, na listagem e
  na busca).
- **Aceitar é o `PATCH` do locutor com `person_id`.** A sugestão passa a `accepted` e, com a voz
  ligada, entra a amostra: a confirmação reforça a impressão.
- **Recusar é `DELETE /transcripts/{id}/speakers/{speaker_id}/suggestions/{person_id}`**, só por
  sessão. A sugestão vira `rejected`, some e não volta para aquele locutor. Sobe a `revision`.
- A sugestão em si nunca liga: só a atribuição automática acima liga sozinha, e só acima do limiar da conta.

## Retranscrição preserva os vínculos confirmados

- Antes de apagar os locutores antigos, o ingest guarda os vínculos e os intervalos de fala deles
  (`voice.capture_links`).
- Depois de inserir os novos, casa cada vínculo antigo com o locutor novo de **maior
  sobreposição de fala**, um para um. Só casa com sobreposição de pelo menos 50% da fala dos dois
  (`RESTORE_OVERLAP`), e restaura `person_id` e `label`. É por tempo, não por voz: vale com a voz
  desligada e só reaplica uma decisão humana sobre o mesmo áudio.
- Restaurado o vínculo, a amostra é recriada do embedding novo. O vínculo que não casa se perde.
  Amostra órfã não existe, porque a FK não deixa.

## LGPD

- **Liga-desliga da plataforma:** `voice_identification.enabled`, desligado por padrão, no
  `PATCH /admin/settings`, só pela sessão de admin. Desligado, nada é comparado, nenhuma amostra
  entra e as sugestões pendentes não aparecem. O worker só calcula embeddings com ele ligado
  (`options.embeddings`).
- **Aceite do aviso no lugar do consentimento por pessoa.** A conta nasce aceitando o aviso em
  vigor ([server-nucleo.md](server-nucleo.md)); pedir o consentimento de quem grava é
  responsabilidade de quem grava. A pessoa não tem estado de consentimento, termo nem histórico.
- **Esquecer a voz de uma pessoa** (`DELETE /people/{id}/voiceprint`) apaga as amostras, as
  sugestões pendentes e os `speaker_embeddings` dos locutores ligados a ela, com `DELETE` comuns
  sob a RLS do dono (`voice.forget`): toda amostra da pessoa está nas gravações do próprio dono. O
  vínculo locutor ↔ pessoa fica; sem o vetor, religar um desses locutores não recria a amostra, e
  só uma retranscrição o recria (holetz/eclume#97 seguiu a recomendação da spec; a decisão final do
  alcance é da dona). **Excluir a pessoa** leva tudo em cascata.
- **Tirar uma amostra isolada** (`DELETE /people/{id}/voice-samples/{transcript_id}/{speaker_id}`)
  apaga só aquela amostra, sob a RLS do dono (`voice.forget_sample`); 404 se ela não existe ou é de
  outra conta. **O locutor segue ligado à pessoa**: a amostra sai da impressão, não o vínculo. Só uma
  retranscrição que restaure o vínculo a recria.
- **Só sessão:** as rotas de voz recusam PAT (403 `session_required`). Um PAT vazado não lê nem
  apaga biometria. `GET /people/{id}/voiceprint` devolve `enabled` (a plataforma), a contagem e as
  amostras, sem os vetores.
  Cada amostra traz a `recording_id` e o `excerpt` (`start_ms`/`end_ms` da fala mais longa daquele
  locutor), para ouvir a amostra no áudio da gravação; `excerpt` é null se a gravação ou os
  segmentos não existirem mais.
- **Os embeddings por gravação** (`speaker_embeddings`) existem para todo locutor enquanto a voz
  estiver ligada, mas nunca saem pela API nem são comparados com pessoas de outra conta.
- **Purga ao desligar.** A transição `enabled: true → false` apaga, na mesma transação do
  `PATCH /admin/settings` (papel de conexão), os `speaker_embeddings` e as sugestões pendentes de
  **toda a plataforma** (`voice.purge_embeddings`) e, depois do commit, enfileira
  `purge_embedding_objects` no worker CPU, que lista `recordings/` e apaga todo
  `speaker_embeddings.json` — o de cada revisão (`recordings/{id}/r{revision}/`) e o das chaves
  antigas, sem revisão — (lotes de 1000; nada, se a voz tiver sido religada nesse meio-tempo). O job
  aceita e ignora o antigo argumento `org_id`, que um job da versão anterior pode trazer. As
  amostras (locutores confirmados) ficam: esquecê-las é pela pessoa. Religar não traz os vetores
  antigos: só uma retranscrição os recria.
- **A conta pode deixar de guardar amostras** (holetz/eclume#116): `users.voice_keep_samples`
  (migration 028, padrão `true`), exposta como `keep_samples` em `/me/voice-assignment` junto de
  `sample_count` e `voiceprint_people` (só leitura). A transição `true → false` apaga, na mesma
  transação do `PATCH` e sob a RLS do dono (`voice.purge_account`), as amostras, os
  `speaker_embeddings` e as sugestões pendentes **da conta** e, depois do commit, enfileira
  `purge_embedding_objects(owner_id)`, que apaga só os `speaker_embeddings.json` das gravações da
  conta (nada, se ela voltou a guardar nesse meio-tempo; sem argumento, o job segue sendo o da
  plataforma). Diferente da purga da plataforma, **as amostras também saem**: é a escolha explícita
  do titular de não ter biometria guardada. Daí em diante o job nasce com `embeddings: false`
  (`transcribe_options(..., keep_samples=)`), a ingestão não grava vetor da conta, nada é
  comparado nem sugerido, e confirmar um locutor não cria amostra. Os vínculos locutor ↔ pessoa
  ficam. Voltar a `true` vale para as próximas transcrições, sem recuperar o que saiu.
- **Vale na ingestão.** Um job enfileirado com `embeddings: true` antes do desligamento (da
  plataforma ou da conta) chega ao `ingest_transcript` depois dele: a ingestão relê a plataforma e
  a preferência do dono e não grava o vetor.
- **O JSON de embeddings não fica no bucket.** Guardado ou descartado o vetor, a ingestão põe o
  `speaker_embeddings.json` da revisão que chegou (a chave que o job traz) na fila de exclusão do
  bucket, na mesma transação; o dreno o apaga em até um minuto. A biometria vive só no banco.
- **Excluir a gravação** apaga áudio, `recordings/{id}/` inteiro (transcrição bruta e
  embeddings de toda revisão), transcrição, locutores, segmentos, embeddings, amostras, sugestões, jobs e resumos
  (cascata no banco e `Storage.delete_recording` no bucket). Uma gravação excluída durante a
  transcrição tem os artefatos que o worker gravou depois apagados pelo `ingest_transcript`.
  Prova em `test_voice.py`.
- **Sem trilha de auditoria de voz.** A 008 removeu `voice_audit`, `voice_consents`, a exportação
  e a purga do admin: sem consentimento por pessoa, não há o que auditar nem exportar por pessoa, e
  o admin não vê conteúdo de usuário.

## Isolamento

- `voice_samples` e `speaker_suggestions` têm `owner_id`, `ENABLE` + `FORCE ROW LEVEL SECURITY` e a
  política de dono `<tabela>_own`, como toda tabela de conteúdo
  ([server-nucleo.md](server-nucleo.md#isolamento-por-rls)). `eclume_app` tem `DELETE` nas duas,
  para esquecer a voz sob a RLS.
- A prova está em `server/tests/test_voice.py`: outra conta nunca é comparada nem lida, pela API e
  por SQL direto sob `eclume_app`.

## Web

- **Gravação** (`SpeakersPanel`): o locutor atribuído pela voz mostra "Atribuído pela voz — 91%" com
  Confirmar; cada sugestão pendente aparece como "Parece ser Fulana — 87%",
  com Aceitar e Recusar.
- **Pessoa** (`VoiceSection`): se a identificação por voz está ligada, as amostras e "Esquecer a
  voz".
  O schema `Person` traz `voice_sample_count` (amostras da impressão) e `speaking_time_ms` (soma do
  `talk_ms` dos locutores ligados à pessoa, sob a RLS do dono), calculados em
  `people.person_select`.
- **Conta** (`/config/conta`, Privacidade e dados): as contagens de impressões e amostras e, com a
  voz ligada na plataforma, a chave **Guardar amostras de voz desta conta**; desligar pede
  confirmação (`ConfirmDialog`). Com a conta sem amostras, o `AutoAssignCard` em Pessoas troca a
  chave da atribuição automática por um aviso que leva à Conta.
- **Admin** (`/admin/locutores`, seção Identificação): liga-desliga (depende da separação e pede confirmação ao desligar) e limiar de 0,50 a 0,99.
