---
type: standard
title: Identificação de pessoas pela voz
description: Como o eclume sugere quem é cada locutor pela voz — impressão de voz como conjunto de amostras de locutores confirmados, comparação por centroide normalizado no ingest com limiar calibrado, sugestão que nunca liga sozinha, retranscrição que preserva vínculos, e o regime LGPD (opt-in da organização com purga dos embeddings ao desligar, consentimento versionado por pessoa, exclusão, exportação e trilha de auditoria).
resource: server/src/eclume_server/voice.py, server/src/eclume_server/routes/voice.py, server/src/eclume_server/db/migrations/005_identificacao_por_voz.sql, web/src/features/people/VoiceSection.tsx, web/src/features/admin/VoicePage.tsx, web/src/features/transcript/SpeakersPanel.tsx
tags: [code, server, web, voz, lgpd, pgvector, auditoria]
timestamp: 2026-09-25
audience: both
authority: current
source: holetz/eclume#15, holetz/eclume#26
maintainer: holetz
---

# Identificação de pessoas pela voz

Ligar locutores a pessoas à mão em toda transcrição é repetitivo. O eclume aprende a voz de quem
já foi confirmado e **sugere** a pessoa nas transcrições novas. Voz é dado biométrico, dado
pessoal sensível pela LGPD (art. 11), então tudo aqui depende de duas travas: o opt-in da
organização e o consentimento da pessoa.

## A impressão de voz é um conjunto de amostras

- **Amostra** (`voice_samples`): o embedding de **um locutor confirmado** como a pessoa, copiado
  de `speaker_embeddings` quando alguém liga o locutor (`PATCH` com `person_id`). Guarda também o
  modelo, a fala (`talk_ms`), quem confirmou e quando.
- **A amostra vive enquanto o vínculo existir.** A FK `(transcript_id, speaker_id) → speakers` tem
  `ON DELETE CASCADE`, e o gatilho `speakers_voice_relink` apaga a amostra quando o `person_id`
  do locutor muda. Desligar, religar a outra pessoa, mesclar, retranscrever ou excluir a gravação
  tiram exatamente a contribuição daquele locutor. Por isso a impressão é um conjunto e não um
  centroide acumulado: um centroide não sabe subtrair o vetor que a mesclagem ou a retranscrição
  já apagaram.
- **Só entra amostra** com o opt-in da organização ligado, o consentimento `granted` da pessoa e
  pelo menos `MIN_SAMPLE_TALK_MS` (10 s) de fala. A condição mora no próprio `INSERT ... SELECT`
  (`voice.add_sample`), não num `if` antes dele.
- Toda amostra removida gera o evento `sample_removed` (gatilho `voice_samples_audit_delete`),
  qualquer que tenha sido o caminho. Exclusões em lote ligam `eclume.voice_quiet` e auditam um
  evento só.

## Comparação no `ingest_transcript`

- Roda no `system_tx` da ingestão, depois dos embeddings, só quando o job veio com
  `options.embeddings` e o opt-in atual da organização está ligado. Filtra `org_id` de forma
  explícita, porque o papel de sistema não passa pela RLS.
- **Impressão = centroide normalizado** das amostras de cada pessoa com consentimento, do mesmo
  modelo e da mesma dimensão, excluídas as amostras da própria transcrição:
  `l2_normalize(avg(l2_normalize(embedding)))`. **Score = `max(0, 1 − distância de cosseno)`**
  entre o locutor normalizado e o centroide.
- Só se compara locutor sem pessoa e com pelo menos `MIN_COMPARE_TALK_MS` (10 s). Não se sugere
  quem já está ligado a outro locutor da mesma transcrição.
- Acima de `voice_identification.suggestion_threshold`, grava até `MAX_SUGGESTIONS` (3) por
  locutor em `speaker_suggestions` (`pending`), do maior score para o menor. Toda ingestão
  audita um `comparison` com as contagens, e cada sugestão um `suggested` com o score.
- **O limiar padrão é 0,55**, calibrado com fala real em
  [calibracao-voz.md](/docs/project/calibracao-voz.md): FPR de 0,17% e FNR de 3,6% por
  comparação. O admin o ajusta.
- Comparação exata, sem índice ANN. Uma organização tem centenas de pessoas e milhares de
  amostras, e o índice exigiria dimensão fixa na coluna.

## Sugestão nunca é identidade

- `Speaker.suggestions` mostra só as sugestões `pending` de um locutor **sem pessoa**, e só com o
  opt-in ligado (`voice.load_suggestions`, em lote, na transcrição, na listagem e na busca).
- **Aceitar é o `PATCH` do locutor com `person_id`.** A sugestão passa a `accepted` (evento
  `accepted`) e, com as duas travas, entra a amostra (`sample_added`): a confirmação reforça a
  impressão.
- **Recusar é `DELETE /transcripts/{id}/speakers/{speaker_id}/suggestions/{person_id}`**, só do
  dono da gravação e só por sessão. A sugestão vira `rejected`, some e não volta para aquele
  locutor. Sobe a `revision`.
- Nada liga um locutor sozinho, com nenhum limiar.

## Retranscrição preserva os vínculos confirmados

- Antes de apagar os locutores antigos, o ingest guarda os vínculos e os intervalos de fala deles
  (`voice.capture_links`).
- Depois de inserir os novos, casa cada vínculo antigo com o locutor novo de **maior
  sobreposição de fala**, um para um. Só casa com sobreposição de pelo menos 50% da fala dos dois
  (`RESTORE_OVERLAP`), e restaura `person_id` e `label`. É por tempo, não por voz: vale sem o
  opt-in e só reaplica uma decisão humana sobre o mesmo áudio.
- Restaurado o vínculo, a amostra é recriada do embedding novo (evento `link_restored`). O vínculo
  que não casa se perde (evento `link_dropped`). Amostra órfã não existe, porque a FK não deixa.

## LGPD

- **Opt-in da organização:** `voice_identification.enabled`, desligado por padrão, no
  `PATCH /admin/settings`. Desligado, nada é comparado, nenhuma amostra entra e as sugestões
  pendentes não aparecem. O worker só calcula embeddings com ele ligado (`options.embeddings`).
  Toda mudança no bloco de voz audita `org_opt_in_changed`.
- **Termo de consentimento** da organização: `consent_term_text`, com um texto padrão v1 em
  `voice.DEFAULT_TERM_TEXT`. Mandar um texto novo sobe `consent_term_version` sozinho.
- **Consentimento por pessoa:** `PUT /people/{id}/voice-consent` com `granted`/`revoked` e
  `notes` (como foi colhido). Qualquer membro registra. O histórico em `voice_consents` é só de
  inserção e guarda quem, quando, a versão e o **texto exato** do termo. `people` guarda o estado
  corrente (`Person.voice_consent` com `term_version`, `recorded_by` e `sample_count`).
- **Revogar apaga** as amostras e as sugestões pendentes da pessoa. **Excluir a impressão**
  (`DELETE /people/{id}/voiceprint`) faz o mesmo e mantém o consentimento. **Excluir a pessoa**
  leva tudo em cascata. **A purga da organização** (`DELETE /admin/voiceprints`, admin) apaga as
  amostras e as sugestões de todos. As quatro atravessam a visibilidade de gravação de quem pede
  e por isso passam pela função `SECURITY DEFINER` `eclume_voice_forget`, restrita a
  `eclume_org()`, com a purga exigindo `eclume_admin()`.
- **Exportação** (direito de acesso): `GET /people/{id}/voiceprint/export`, só admin, devolve
  consentimentos, amostras **com os vetores** e a trilha da pessoa, com `Content-Disposition`, e
  audita `exported`.
- **Só sessão:** todas as rotas de voz recusam PAT (403 `session_required`). Um PAT vazado não
  lê, exporta nem apaga biometria.
- **Os embeddings por gravação** (`speaker_embeddings`) existem para todo locutor enquanto o
  opt-in estiver ligado, mas nunca são comparados com a impressão de quem não consentiu nem saem
  pela API.
- **Purga ao desligar.** A transição `enabled: true → false` apaga, na mesma transação do
  `PATCH /admin/settings`, os `speaker_embeddings` e as sugestões pendentes de toda a organização
  (função `SECURITY DEFINER` `eclume_purge_speaker_embeddings`, restrita a `eclume_org()` e a
  `eclume_admin()`, migration `007`), audita `embeddings_purged` com as contagens e, depois do
  commit, enfileira `purge_embedding_objects(org_id)` no worker CPU, que apaga o
  `recordings/{id}/speaker_embeddings.json` de cada gravação da organização (lotes de 1000; nada,
  se o opt-in tiver sido religado nesse meio-tempo). As amostras de quem consentiu ficam: tirá-las
  é o fluxo de consentimento. Religar não traz os vetores antigos: só uma retranscrição os recria.
- **Opt-in vale na ingestão.** Um job enfileirado com `embeddings: true` antes do desligamento
  chega ao `ingest_transcript` depois dele: a ingestão relê o opt-in, não grava o vetor e apaga o
  `speaker_embeddings.json` que o worker produziu.
- **Excluir a gravação** apaga áudio, `recordings/{id}/` inteiro (transcrição bruta e
  embeddings), transcrição, locutores, segmentos, embeddings, amostras, sugestões, jobs e resumos
  (cascata no banco e `Storage.delete_recording` no bucket). Uma gravação excluída durante a
  transcrição tem os artefatos que o worker gravou depois apagados pelo `ingest_transcript`.
  Prova em `test_voice.py`.

## Auditoria

- `voice_audit` é só de inserção para `eclume_app`, e só admin lê: `GET /admin/voice-audit`, com
  cursor e `?person=`. Nunca guarda vetores. Copia o nome da pessoa, para o evento sobreviver à
  exclusão dela.
- Eventos: `comparison`, `suggested`, `accepted`, `rejected`, `sample_added`, `sample_removed`,
  `link_restored`, `link_dropped`, `consent_granted`, `consent_revoked`, `voiceprint_deleted`,
  `exported`, `org_opt_in_changed`, `org_purged` e `embeddings_purged` (1.4.0). O `actor` é `null` nos eventos do sistema.
- O id do evento é gerado no Python: um `INSERT ... RETURNING` exigiria a política de leitura, que
  é só de admin.

## Isolamento

- Toda tabela nova tem `org_id`, `ENABLE` + `FORCE ROW LEVEL SECURITY` e política por
  `eclume_org()`. As sugestões herdam a visibilidade da transcrição. As amostras são da
  organização: a página da pessoa as lista a qualquer membro, com o título só da gravação que ele
  vê.
- Criar amostra é do dono da gravação (política `voice_samples_insert`). Recusar sugestão também
  (`speaker_suggestions_update`).
- A prova está em `server/tests/test_voice.py`: outra organização nunca é comparada nem lida, pela
  API e por SQL direto sob `eclume_app`.

## Web

- **Gravação** (`SpeakersPanel`): cada sugestão pendente aparece como "Parece ser Fulana — 87%",
  com Aceitar e Recusar.
- **Pessoa** (`VoiceSection`): o estado do consentimento (quem, quando, versão do termo), o termo
  mostrado antes de registrar e com o aceite marcado, revogar, as amostras, excluir a impressão e
  exportar (só admin).
- **Admin** (`/admin/voz`): opt-in, limiar em %, texto do termo, trilha de auditoria e purga.
