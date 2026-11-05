# eclume changelog

What changes in the **product** — server, GPU worker, engines and web, which ship together in the
same deploy — for those who host it and those who use it. The apps have their own:
[desktop](desktop/CHANGELOG.md) and [phone](mobile/CHANGELOG.md). The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions follow
[SemVer](https://semver.org/); when each line is bumped and what goes in here is in
[versionamento.md](docs/standards/code/versionamento.md). The contract version (`info.version` of
v1) has its own line and each entry cites it.

## [Unreleased]

### Added

- Community files for the public repository: `SECURITY.md`, project rules in `CONTRIBUTING.md` and issue forms (#255).
- Required speaker naming: with the account preference turned on, the agent chain waits for every
  speaker to have a name, with the `speakers` step and the "Aguardando locutores" notice (contract
  2.22.0, #144).
- Agent in place of Questions: stored conversations, input and output files, and the session
  history (contract 2.23.0, #142).
- User skills in the Agent, and actions on the workspace that the agent proposes and the person
  confirms (contract 2.24.0, #145).
- Voice note transcribed with a single speaker and, when re-transcribing, the expected number of
  speakers (`min_speakers`/`max_speakers`; contract 2.25.0, #175).
- Audio retention: each account can choose how many days the server keeps the audio of its
  recordings, the admin can set a ceiling, and a daily job deletes the audio past the window while
  the transcript, summary and chat stay (contract 2.29.0, #179).
- Account locale: each account has a product locale (`en`, the default, or `pt-BR`), read and
  changed at `/me/locale`; summaries, field values, the adjustment chat and the Agent answer in the
  owner's locale (contract 2.30.0, #248).
- Web interface in English and Portuguese: the app follows the account locale (else the browser
  language), switches in place at Settings › Account, loads only the active language, and shows
  every API error in it (#249).
- The library, the recording page, import, search, people, custom fields and agenda types,
  collections and tags in English and Portuguese, with the pipeline steps and reasons shared with
  the apps (#250).
- The administration panel, the Agent, the automatic processing overview and the help center
  (its frame, search and topic names) in English and Portuguese (#251).
- The help center articles and frequently asked questions in English and Portuguese: the center
  and the drawer show the active locale's articles, with English slugs (#252).

### Fixed

- A count of exactly one million (or another multiple of a million) in Portuguese showed the bare
  message key instead of the text; every plural now answers for every category of the language
  (#250).
- Re-transcribing with only the minimum or only the maximum number of speakers filled in keeps the
  platform limit on the empty side, as the help text promises; before, the whole pair was replaced
  and the ceiling disappeared (#216).

### Changed

- Self-hosting without the maintainer's host: `deploy/gate.sh` and `deploy/release-mobile.sh` no
  longer default the Docker context to `gpu-host` (pass `--context NAME` or set
  `ECLUME_DOCKER_CONTEXT`; without either they exit 2), `deploy/smoke_prod.py` guards production only
  through `ECLUME_PUBLIC_URL`, `deploy/operator.env.example` lists the operator variables, and
  examples, fixtures and apps use the documentation address 192.0.2.10 instead of the maintainer's
  host. The subscription-token terms decision is recorded in the self-hosting guide (#258).
- License: eclume is now GPL-3.0-or-later (was MIT), for the server, GPU worker, engines and web
  and for the desktop and phone apps; the desktop crates adapted from Anarlog stay MIT.
  `NOTICE.md` records the third-party licence decisions (#324).
- The queue store is Valkey (`valkey/valkey`, BSD-3-Clause) instead of the `redis:7-alpine` image,
  whose Redis 7.4 is under RSALv2/SSPLv1. Same protocol, ACL and `redis` service. Valkey cannot
  read Redis 7.4's data: before the first deploy with this change, drain the queue and set
  `/srv/eclume/redis` aside, as the
  [cutover](docs/project/deploy-producao.md#one-time-cutover-from-redis-to-valkey) describes (#324).
- API errors are localized by their `code`: `title` and `detail` are now English, and the contract
  lists every code in `ProblemCode`. The agent prompts are English, with the output language taken
  from the account locale (contract 2.30.0, #248).
- Hosting scripts, flags and pillars in English: `deploy/pillars.sh` (pillar `audit`),
  `restore-backup.sh`, `watchdog.sh`, `publish-desktop.sh`, `publish-mobile.sh`,
  `release-mobile.sh`, and flags such as `deploy.sh --rollback`/`--no-gpu`/`--generate-env` and
  `gate.sh --status`; the old flags fail with "unknown flag". The full map is in
  [deploy/README.md](deploy/README.md) (#244).
- Python dependencies raised to clear the `audit` pillar: aiohttp 3.14.5, certifi 2026.10.23,
  filelock 4.2.4, opentelemetry 1.45.1, pillow 13.0.0 (GPU worker image only, through matplotlib),
  pypdf 6.21.2 (floor raised in `server/pyproject.toml`) and setuptools 84.2.1 (#296).
- Leaner server in CPU and memory, with no behaviour change: minimal queue probe, on-demand imports,
  `eclume-server worker` with the `eclume:default` and `eclume:agents` queues in a single process,
  configurable connection pool, the PAT's `last_used_at` every 60 s, upload without copying and a
  partial index of the open jobs (migration 033_indice_jobs_em_aberto, #150).
- Leaner production for those who host it: the SPA embedded in the Caddy edge (image `eclume-edge`,
  without the `web` service), a single CPU `worker` for the `eclume:default` and `eclume:agents`
  queues (without `worker-agents`; `ECLUME_AGENT_MAX_JOBS` becomes 2 in the compose), spaced-out
  healthchecks with `start_interval`, CPU weight per role, `memswap_limit` of 1.5 × the ceiling
  (`ECLUME_MEMSWAP_<SERVIÇO>`) and revised ceilings. The deploy removes the old containers, keeps
  the new edge alongside the old trios with `web` and prunes the build cache older than 7 days.
  `ECLUME_MEM_WORKER` replaces `ECLUME_MEM_WORKER_AGENTS` (still accepted);
  `ECLUME_MEM_WORKER_CPU` and `ECLUME_MEM_WEB` no longer apply. Requires Docker Engine 25 or newer
  (#151).
- Recording screen with the transcript in its own scroll area and the speakers in a collapsible
  block (#143).
- Expected speakers (`min_speakers`/`max_speakers`), when re-transcribing and in the admin limits,
  now accept 1 to 30 and reject a boolean with 422, instead of failing diarization after spending
  the GPU (contract 2.26.0, #191).
- The GPU worker's audio test fixture is now about 30 s of speech by two real speakers from
  Common Voice (CC0), in place of Piper synthetic voices whose licence did not allow a public
  repository; `make-test-audio.sh fixture` rebuilds it from pinned clips (#351).

### Deprecated

- The chat over the knowledge base (`/base-chat`), which the Agent replaces (contract 2.23.0, #142).
- The pt-BR names of the hosting env vars, still read as a fallback: `ECLUME_CA_NOMES`,
  `ECLUME_PULOS`, `ECLUME_BACKUP_DIA`, `ECLUME_ENSAIO_DIA`, `ECLUME_DEPLOYS_RETIDOS`,
  `ECLUME_STAGING_LOTE`, `VIGIA_*` and the publish `DESTINO`/`MANTER` give way to `ECLUME_CA_NAMES`,
  `ECLUME_SKIPS`, `ECLUME_BACKUP_DAY`, `ECLUME_REHEARSAL_DAY`, `ECLUME_DEPLOYS_KEPT`,
  `ECLUME_STAGING_BATCH`, `WATCHDOG_*`, `DEST` and `KEEP` (#244).

### Security

- Dependencies bumped past open Dependabot advisories: DOMPurify 3.4.17 (through Redoc, in the API
  reference page), nltk 3.10.4 and, in the web and phone app toolchains, Vite 8.3.6, Vitest 5.1.0,
  undici 8.12.4 and zod 4.6.7. torch stays at 2.8 because WhisperX 3.8.6 pins `torch~=2.8.0`.

### For those who host

- **Migrations**, none destructive: `030_marcacao_dos_locutores` (swaps the step `CHECK`s),
  `031_agente_conversas`, `032_agente_habilidades_e_acoes` and `034_audio_retention` (adds the
  account and platform retention settings and makes `recordings.audio_key` nullable).
- **Migration** `035_account_locale`, not destructive: adds `users.locale` and sets every existing
  account to `pt-BR`; accounts created afterwards take the browser's language (#248).

## [0.2.0] - 2026-10-03

What landed in `main` after 0.1.0, before the versioning standard existed (#89 to #130, merged
between 2026-10-01 and 2026-10-02).

### Added

- Processing steps that resume on their own after a crash and can be cancelled (#96).
- Resumable upload for 7 days and complete deletion: deleting a recording or an account leaves no
  object in the bucket (#97).
- Traceable and reversible deploy: `/health` reports the image's commit and `deploy.sh --voltar`
  brings back a retained deploy (#92).
- Production observability and alerts: `eclume-server saude --json`, `vigia.sh` and the agent token
  expiry warning (#93).
- Encrypted off-host backup, with the secrets and the restore drill (#91).
- Per-account quotas (storage, file, open uploads, audio minutes and agent requests) and a fair GPU
  queue (#98).
- Position in the transcription queue and processor state (#117).
- Notice of a summary that is ready or has failed, in any client (#118).
- Password recovery through a single-use link generated by the admin (#119).
- Account that keeps no voice samples, and the screen that says what leaves the server (#116).
- Transcription language per account and per file (#121).
- First steps and empty states that teach, from the summary to the rule (#115).
- The server's own name-constrained CA, with rotation announced in the descriptor
  (`ca_next_sha256`) (#101).
- Browsable, offline API reference at `/referencia-api.html`, linked from the access tokens screen
  (#127).

### Changed

- Processing states with a name and a reason, the same on the web, the desktop and the phone
  (#114).
- Automatic processing settings and rules reorganized (#120).
- Transcription tied to the revision end to end (#95).
- Hardened server: body limits, security headers, login attempts and scopes (#99).
- Production services isolated and memory-limited; MinIO and Redis with per-service credentials
  (#94).
- The summary provider no longer requires a proprietary binary: the `claude` CLI in the image
  becomes the host's choice (#129).
- Web on a data router, with per-route errors and a protected summary draft (#110), resilient to
  network loss, expired session and account switching (#111), with smooth long transcripts (#112)
  and on the Design System, with the control contrast fixed (#122, #130).
- `owner` and `created_by` marked deprecated in v1: they stay filled in and leave in `/api/v2`
  (contract 2.11.0, #100).
- Toolchains, images and dependencies pinned and updated (#90).

### For those who host

- **Migrations**, none destructive: `024_exclusao_no_armazenamento`, `025_validade_da_chave`,
  `026_cotas_e_fila_justa`, `027_redefinicao_de_senha`, `028_conta_sem_amostras_de_voz` and
  `029_idioma_da_conta`.
- **New variables** in the production env (the template is `deploy/.env.prod.example`):
  - `ECLUME_CLAUDE_CLI` (`0` or `1`), **required**: the deploy refuses an env that does not declare
    it; `1` keeps the `claude-cli` provider's CLI in the image.
  - `ECLUME_MINIO_SERVER_PASSWORD`, `ECLUME_MINIO_GPU_PASSWORD`, `ECLUME_REDIS_SERVER_PASSWORD` and
    `ECLUME_REDIS_GPU_PASSWORD`: the deploy generates the missing ones.
  - `ECLUME_TLS_CA` (`eclume` or `local`) and `ECLUME_CA_NOMES`: the HTTPS CA; replacing Caddy's
    root with the server's own follows the three-step rotation in
    [deploy-producao.md](docs/project/deploy-producao.md).
  - `ECLUME_SIGNUPS_PER_IP_PER_DAY` (default 5) and the `ECLUME_MEM_*` memory limits (with defaults
    in the compose).
- **Contract**: 2.9.0 → 2.21.0, only growing.
- **Compatible apps**: desktop 0.4.1 and phone 0.1.1, which bring strict CA pinning (#102).

## [0.1.0] - 2026-09-30

The baseline: what has been in production on the host from the first deploy up to 2026-09-30.

### Added

- API with isolated user accounts and open sign-up, a separate admin account, PATs and paired
  devices; recordings, people, search, auto collections and tags.
- GPU transcription with WhisperX: alignment, diarization, speaker identification by voice and
  automatic assignment.
- Summary by the agent the admin configures, with agenda types, fields and chat over the knowledge
  base.
- Web with the library, the recording, the settings, the help and the admin panel, with local
  audio and video conversion before upload.
- MCP server for devices and integrations.

### For those who host

- **Migrations**: `001_nucleo`, `002_agentes`, `003_pessoas_e_busca`, `004_painel_admin`,
  `005_identificacao_por_voz`, `006_papel_de_conexao`, `007_purga_de_embeddings`,
  `008_conta_por_usuario` (**destructive**: removes the organization, the groups, the sharing, the
  invitations and the voice audit; take the backup first, as in
  [deploy-producao.md](docs/project/deploy-producao.md)), `009_tipos_de_agenda`,
  `010_campos_e_valores`, `011_plataforma_de_processamento`, `012_etapas_do_pipeline`,
  `013_revisao_do_processamento`, `014_gravacao_resumo`, `015_dispositivos_e_mcp`,
  `016_origem_mobile`, `017_dispositivo_le_resumo`, `018_dispositivo_le_transcricao`,
  `019_atribuicao_automatica_de_locutores`, `020_pessoas_enriquecidas`,
  `021_tipo_de_agenda_padrao`, `022_colecoes_automaticas` and `023_cadastro_de_tags`.
- **Contract**: 2.9.0.
- **Compatible apps**: desktop 0.4.0, published together with it, and phone 0.1.0.
