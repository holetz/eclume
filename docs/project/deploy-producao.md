---
type: project
title: Deploy de produção no host GPU
description: Como o eclume roda em produção no host 192.168.15.199 — compose do projeto eclume com Caddy na 8443, build no daemon do host pelo contexto Docker, segredos em deploy/.env.prod, bootstrap do admin, CA interna nos clientes, backup diário por cron com restauração testada, operação e coexistência com o lumea.
resource: deploy/docker-compose.prod.yml, deploy/deploy.sh, deploy/.env.prod.example, deploy/server.Dockerfile, deploy/web.Dockerfile, deploy/web.Caddyfile, deploy/bootstrap-admin.sh, deploy/backup.sh, deploy/restaurar-backup.sh, deploy/smoke_prod.py
tags: [deploy, producao, host, caddy, backup, runbook]
timestamp: 2026-09-25
audience: both
authority: current
source: holetz/eclume#14, holetz/eclume#26, holetz/eclume#28, holetz/eclume#29
maintainer: holetz
---

# Deploy de produção no host GPU

O eclume de produção roda no host `192.168.15.199`, preparado pelo
[runbook do host](host-setup.md), e responde em **`https://192.168.15.199:8443`**. O host é
compartilhado com o lumea (443) e com os serviços pessoais do usuário, que o deploy nunca toca.

```
LAN ──► :8443 caddy (tls internal) ─┬─ /api/*, /media/*  ──► server:8000 (uvicorn)
                                    ├─ /downloads/*      ──► /srv/eclume/downloads (somente leitura)
                                    └─ resto             ──► web:80 (SPA)
server ──► postgres · redis · minio ◄── worker-cpu (eclume:default, claude -p)
                         redis ◄──────── worker-gpu (eclume:gpu, WhisperX na GTX 1660 SUPER)
```

## Stack

`deploy/docker-compose.prod.yml`, projeto **`eclume`** (containers `eclume-<serviço>-1`):

| Serviço | Imagem | Papel |
|---|---|---|
| `caddy` | `caddy:2.11` | TLS interno na 8443, a **única porta publicada** |
| `web` | `eclume-web:prod` (`deploy/web.Dockerfile`) | SPA estática, servida por um Caddy mínimo com fallback para o `index.html` |
| `server` | `eclume-server:prod` (`deploy/server.Dockerfile`) | API (`uvicorn`), com healthcheck em `/api/v1/health` |
| `worker-cpu` | `eclume-server:prod` | `arq eclume_server.worker.WorkerSettings`: ingestão, resumos, expiração de uploads |
| `worker-gpu` | `eclume-worker-gpu:prod` (`worker-gpu/Dockerfile`, ~8 GB) | ASR e diarização, `max_jobs=1` ([worker-gpu.md](worker-gpu.md)) |
| `postgres` | `pgvector/pgvector:pg16` | banco; server e worker CPU conectam como `eclume_server` (sem superusuário, só DML) e as requisições baixam para `eclume_app`; o superusuário `eclume` fica para o `migrate`, o bootstrap e o backup ([server-nucleo.md](../standards/code/server-nucleo.md#papéis-do-banco)) |
| `redis` | `redis:7-alpine` | filas e progresso, com `appendonly` |
| `minio` | `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` | áudio e artefatos (a MinIO parou de publicar imagens) |

One-shots do perfil `tools`, rodados por `compose run --rm`: `minio-init` (bucket), `migrate`
(`eclume-server migrate`, como o superusuário, que também liga o `LOGIN` de `eclume_server` com `ECLUME_RUNTIME_PG_PASSWORD`) e `publish-ca` (copia a CA para `/downloads/`).

- **Só o Caddy publica porta.** O Docker publica por fora do ufw, então Postgres, Redis, MinIO,
  server e web não têm `ports:`. Para depurar, use `compose exec`.
- **Rotas do Caddy.** `/api/*` e `/media/*` vão ao server sem cortar o prefixo. `/downloads/*` é a
  pasta dos instaladores ([desktop-distribuicao.md](../standards/code/desktop-distribuicao.md)),
  com `Cache-Control: no-cache` nos manifestos e arquivos ocultos escondidos. O resto vai ao SPA.
  Nenhuma rota do SPA pode começar com `/api`, `/media` ou `/downloads`.
- **O Caddyfile é um `configs.content` inline.** Com o daemon remoto, um `file:` viraria bind
  mount de um caminho da estação.
- **As imagens do server e do web ficam em `deploy/`,** com `<Dockerfile>.dockerignore` ao lado
  filtrando o contexto da raiz. Uma imagem de server serve à API, ao worker CPU, às migrations e ao
  CLI. Ela roda como uid 1000 (`HOME=/home/app`) e traz o binário nativo da CLI `claude`, fixado
  na versão do host.
- **Restart `unless-stopped` e logs rotacionados** (3 × 10 MB por container): o stack volta
  sozinho depois de um reboot, sem ninguém rodar deploy.

### Dados em `/srv/eclume`

| Pasta | Conteúdo |
|---|---|
| `pg/`, `redis/`, `minio/` | volumes `eclume-prod-*` (bind) do banco, das filas e dos objetos |
| `caddy/data`, `caddy/config` | **CA interna do Caddy**: apagar gera uma CA nova e obriga a reinstalar a raiz em todos os clientes |
| `models/` | cache de modelos do worker GPU |
| `downloads/` | instaladores do desktop, `latest.json` e `eclume-root.crt` |
| `secrets/` (700) | `env.prod`, `hf_token`, `admin-password`, chaves do updater — tudo 600 |
| `backups/` | `pg/`, `minio/`, `caddy/` e `backup.log` |
| `bin/` | `backup.sh` e `restaurar-backup.sh`, instalados pelo deploy |

## Deploy

Da máquina de desenvolvimento, com o contexto `gpu-host` do [runbook do host](host-setup.md):

```bash
bash deploy/deploy.sh --gerar-env              # uma vez: deploy/.env.prod com segredos aleatórios
bash deploy/deploy.sh --plan --context gpu-host
bash deploy/deploy.sh --context gpu-host
bash deploy/bootstrap-admin.sh                 # uma vez: organização EK e o admin
```

O `deploy.sh` usa o contexto Docker para build e subida e o SSH (o alvo sai do endpoint
`ssh://` do contexto) para o que é do host. Em ordem:

1. Recusa com o disco do host em 90% ou mais (`ECLUME_DISK_LIMIT`), antes e depois do build.
2. Cria as pastas de `/srv/eclume` e um `hf_token` vazio se faltar. Um arquivo ausente num bind
   mount viraria pasta.
3. Guarda a cópia de `deploy/.env.prod` em `/srv/eclume/secrets/env.prod`, instala os scripts
   de backup em `bin/` e a linha `# eclume-backup` no crontab.
4. Constrói `server`, `web` e `worker-gpu` no daemon do host (`--services` restringe;
   `--sem-build` pula). Com o lock inalterado, o worker GPU sai do cache em segundos.
5. `up --wait postgres redis minio` → `run --rm minio-init` → `run --rm migrate` →
   `up --wait server worker-cpu worker-gpu web` → `up --force-recreate --wait caddy`. Os one-shots
   ficam fora do `--wait`, que trata a saída 0 de um serviço que ninguém espera como falha. O
   Caddy é sempre recriado porque o compose não recria um container quando só o
   `configs.content` muda. A CA está no volume e sobrevive.
6. Publica a CA em `/srv/eclume/downloads/eclume-root.crt`, poda as imagens do eclume que ficaram
   sem tag (rótulo `org.eclume.image`, nada de outros projetos) e confere o health pela CA
   publicada.

### Segredos

`deploy/.env.prod` (600, no `.gitignore`) sai de `deploy/.env.prod.example` por
`--gerar-env`, com `openssl rand`. As senhas são hex, porque entram na DSN sem escape, e
`ECLUME_ENCRYPTION_KEY` é o base64 de 32 bytes. O deploy recusa enquanto houver um `=troque-`.
Sem o arquivo no checkout (outra máquina, outra worktree), o deploy o restaura da cópia do
host.

| Variável | Observação |
|---|---|
| `ECLUME_PG_PASSWORD` | do superusuário `eclume` (migrador); só vale na criação do volume; para trocar depois, `ALTER USER eclume PASSWORD '…'` antes de mudar o env |
| `ECLUME_RUNTIME_PG_PASSWORD` | do papel `eclume_server`, a conexão do server e do worker CPU. O `migrate` a aplica a cada deploy, então trocá-la é mudar o env e fazer deploy. Um env anterior a ela ganha uma gerada pelo próprio `deploy.sh` (append, sem tocar no resto) |
| `ECLUME_JOB_GRACE_SECONDS`, `ECLUME_JOB_STALL_SECONDS` | opcionais (120 e 1800): detecção de job morto ([jobs-transcricao.md](../standards/api/jobs-transcricao.md#job-morto)) |
| `ECLUME_KEEP_ASR_RESIDENT`, `ECLUME_RESIDENT_MIN_FREE_MB`, `ECLUME_MODEL_IDLE_SECONDS` | opcionais (1, 2500, 300): o ASR residente entre jobs no worker GPU ([worker-gpu.md](worker-gpu.md)) |
| `ECLUME_SECRET_KEY` | assina as URLs de parte e de áudio; trocar invalida as que estão em circulação |
| `ECLUME_ENCRYPTION_KEY` | cifra as chaves de API dos providers e os segredos do painel admin; o worker GPU recebe a mesma, para abrir o token do HF que chega cifrado no job; trocar obriga a recadastrá-los ([server-agentes.md](../standards/code/server-agentes.md), [server-admin.md](../standards/code/server-admin.md)) |
| `ECLUME_PUBLIC_URL` | `https://192.168.15.199:8443`, a base das URLs devolvidas ao cliente |
| `ECLUME_CLAUDE_OAUTH_TOKEN` | opcional: token de longa duração do Claude (`claude setup-token`, 1 ano), entregue ao worker CPU como `CLAUDE_CODE_OAUTH_TOKEN`. O caminho normal é o token no painel (abaixo), que vence este; sem nenhum dos dois, o `claude-cli` falha com `provider_not_configured`. **Não monte** o `~/.claude/.credentials.json` do host: a renovação do OAuth diverge no bind mount ([server-agentes.md](../standards/code/server-agentes.md#deploy)) |

### Admin e provider

O `bootstrap-admin.sh` (pelo one-shot `migrate`, com o superusuário) cria a organização **EK** e o admin `admin@example.com`. A
senha é gerada no host e fica **só** em `/srv/eclume/secrets/admin-password` (600). Ela chega
ao `eclume-server admin bootstrap --password-stdin` por um pipe e nunca é gravada na estação.
Com alguma organização no banco, o script não faz nada.

O provider padrão da organização é o `claude-cli` ("Claude (servidor)", modelo `sonnet`), que
roda o `claude -p` no worker CPU com o token de longa duração. O smoke o cadastra se faltar.

**Token do Claude.** Num computador com o Claude Code logado na assinatura, `claude setup-token`
abre a autorização no navegador e imprime o token (`sk-ant-oat01-…`). Cadastre-o no painel:
**Admin → Agentes → Claude (servidor) → Editar → Token do Claude**. Ele fica cifrado no banco e
vence o `ECLUME_CLAUDE_OAUTH_TOKEN` do env, que sobra como alternativa de operação sem painel. O
token vale 1 ano e não se renova: gere outro antes de vencer (o sintoma é o resumo falhando com
`provider_auth` na Saúde do admin).

Deploy de uma estação Windows ([estacao-windows.md](estacao-windows.md)): rode o `deploy.sh` de
uma exportação com LF (`git -c core.autocrlf=false archive HEAD | tar -x -C <pasta>`), porque o
`autocrlf` do checkout põe CRLF nos scripts que o deploy instala no host. Sem `flock`, a trava
vira o diretório `deploy/.deploy.lock.d`.

## Validar

```bash
ssh holetz@192.168.15.199 cat /srv/eclume/downloads/eclume-root.crt > /tmp/eclume-root.crt
ssh holetz@192.168.15.199 cat /srv/eclume/secrets/admin-password \
  | python3 deploy/smoke_prod.py --ca /tmp/eclume-root.crt
```

O `smoke_prod.py` usa só a biblioteca padrão. Ele confere health, SPA e `/downloads/latest.json`,
faz login, garante o provider e envia `worker-gpu/tests/fixtures/duas-vozes.ogg` pelo upload
multipart. Depois espera a transcrição com 2 locutores e um resumo `done`, e imprime `OK`. Um
áudio já enviado volta `deduplicated`, e o smoke confere a transcrição que já existe.

### Primeiro deploy (2026-09-25)

- **Tempo:** o deploy do zero levou ~6,5 min, quase tudo no build do worker GPU (7,98 GB). As
  demais imagens medem 507 MB (server) e 96 MB (web). Um redeploy sem mudança de dependência leva
  ~20 s. O disco do host foi de 80% a 82%.
- **Smoke:** o upload de uma parte, a transcrição na GPU em 30 s (13 segmentos, 2 locutores, com os
  modelos já no cache de `/srv/eclume/models`) e a ata pelo `claude-sonnet-5` em ~8 s passaram.
  O smoke inteiro levou 41 s.
- **Backup:** o primeiro backup levou 1 s. `restaurar-backup.sh --teste` restaurou banco e bucket
  com contagens idênticas às da produção. A retenção de 7 e os hardlinks entre instantâneos foram
  conferidos.
- **Rede:** um container do lumea alcança `https://192.168.15.199:8443` pelo IP do host.

## CA raiz nos clientes

HTTPS é obrigatório para o microfone e a conversão de mídia no navegador, e o desktop só confia no
servidor pelo repositório de CAs do sistema. A raiz fica em
**`https://192.168.15.199:8443/downloads/eclume-root.crt`**. Ela é distinta da do lumea.

- **Primeiro download** (antes de confiar): `curl -k -o eclume-root.crt https://192.168.15.199:8443/downloads/eclume-root.crt`,
  ou `scp holetz@192.168.15.199:/srv/eclume/downloads/eclume-root.crt .`. Confira a impressão
  digital contra o host:
  `openssl x509 -noout -fingerprint -sha256 -in eclume-root.crt`.
- **Linux:** `sudo cp eclume-root.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates`.
- **Windows:** `certutil -addstore -f Root eclume-root.crt`, como administrador.
- **macOS:** `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain eclume-root.crt`.
- **Firefox:** importe em Configurações → Certificados, porque ele usa um repositório próprio.
- **lumea:** monte o PEM no container `api` e aponte `LUMEA_ECLUME_CA_BUNDLE` para ele, com
  `LUMEA_ECLUME_URL=https://192.168.15.199:8443` (`deploy/.env.remote` do lumea).

## Backup e restauração

**Agendamento: cron do usuário `holetz`, às 03:30.** Ele não tem linger, então um timer systemd de
usuário não rodaria fora de sessão. O `deploy.sh` instala o script e a linha do cron:

```
30 3 * * * ECLUME_DATA_DIR=/srv/eclume /srv/eclume/bin/backup.sh >> /srv/eclume/backups/backup.log 2>&1 # eclume-backup
```

| Arquivo em `/srv/eclume/backups/` | O que é |
|---|---|
| `pg/roles-<data>.sql` | `pg_dumpall --roles-only` (o `eclume_app` é do cluster, não do banco) |
| `pg/eclume-<data>.dump` | `pg_dump -Fc eclume` |
| `caddy/caddy-pki-<data>.tgz` | a CA interna do Caddy |
| `minio/.espelho/` | `mc mirror --remove` do bucket |
| `minio/<data>/` | instantâneo do espelho por `rsync --link-dest`: um objeto igual ao do dia anterior é um hardlink e não ocupa disco de novo |

Ficam os **7 mais recentes** de cada (`MANTER`). Rodar duas vezes no mesmo dia substitui o
backup do dia. O backup fica **no mesmo disco**: ele protege contra erro lógico e corrupção,
não contra a perda do disco. Copiar `backups/` para fora do host é decisão do usuário.

```bash
ssh holetz@192.168.15.199 /srv/eclume/bin/backup.sh                    # backup agora
ssh holetz@192.168.15.199 /srv/eclume/bin/restaurar-backup.sh --teste   # prova o mais recente
ssh holetz@192.168.15.199 /srv/eclume/bin/restaurar-backup.sh --aplicar 2026-09-25 --confirmo
```

- **`--teste [<data>]`** restaura o dump num banco `eclume_restore_teste` e o instantâneo num
  bucket `eclume-restore-teste`. Depois compara as contagens (organizações, usuários, gravações,
  transcrições, resumos e objetos) com a produção e apaga os dois.
- **`--aplicar <data> --confirmo`** para server e workers e recria o banco `eclume` a partir do
  dump. Depois espelha o instantâneo de volta no bucket, sem apagar objetos que não estão no
  backup, e sobe os serviços.
- **Num host novo,** restaure `caddy-pki-<data>.tgz` em `/srv/eclume/caddy/data` **antes** do
  primeiro deploy, para manter a CA dos clientes. Depois rode o deploy, e só então `--aplicar`.
  Os papéis entram antes do dump.

## Operação

```bash
P=(docker --context gpu-host compose -p eclume -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod)
"${P[@]}" ps --all
"${P[@]}" logs -f --tail 100 worker-gpu
"${P[@]}" exec postgres psql -U eclume eclume
"${P[@]}" run --rm migrate eclume-server admin create-user --org-id <org> --email <e-mail> --name "<nome>" --password-stdin
bash deploy/deploy.sh --context gpu-host --services "server web"   # só código do server e do web
```

- **Login do Claude expirado:** o resumo falha com `provider_auth`. Rode `claude` no host, faça o
  login e reenvie o resumo; o arquivo montado é o mesmo, sem reiniciar nada.
- **Renovação do token do Claude sobre o mount de arquivo** (verificada na holetz/eclume#26): o
  `rename` sobre um arquivo montado dá `EBUSY`, e a CLI (2.1.282) cai para a escrita no próprio
  arquivo — o escritor atômico dela trata `EXDEV`/`EPERM`/`EEXIST`/`EBUSY` assim —, que o host
  enxerga. Por isso o mount é do arquivo, não da pasta `~/.claude`.
- **Job de transcrição parado:** o worker CPU marca sozinho como falha recuperável (`worker_lost`,
  `job_lost`, `job_stalled`) o job que o worker GPU abandonou; o dono retranscreve ou o admin usa
  "Tentar de novo" na Saúde ([jobs-transcricao.md](../standards/api/jobs-transcricao.md#job-morto)).
- **E2E do web contra o backend real** num stack efêmero, sem tocar a produção:
  `remote-run . 'bash deploy/e2e-real.sh'` ([frontend-web.md](../standards/code/frontend-web.md)).
- **Token do Hugging Face:** grave em Administração → Segredos (vence o arquivo) ou troque
  `/srv/eclume/secrets/hf_token` (600). O worker relê a cada job, sem reiniciar
  ([worker-gpu.md](worker-gpu.md)).
- **Instaladores do desktop:** `deploy/publicar-desktop.sh` grava em `/srv/eclume/downloads/`,
  que o Caddy já serve ([host-setup.md](host-setup.md), seção dos instaladores).
- **Disco:** o `deploy.sh` mostra o uso no `--plan`. Para liberar espaço, rode
  `docker --context gpu-host builder prune -f --filter until=720h`; nunca faça `image prune -a`,
  porque ele apagaria imagens dos serviços pessoais.

## Coexistência com o lumea

O lumea usa a 443, o projeto `lumea`, os containers `lumea-*` e os dados em `/srv/lumea`. O
eclume usa a 8443, o projeto `eclume`, os volumes `eclume-prod-*` e os dados em `/srv/eclume`,
com CA, rede e Caddy próprios. Nenhum comando daqui toca os containers, volumes ou imagens do
lumea ou dos serviços pessoais (Jellyfin, *arr, qBittorrent, Samba). Depois de um deploy,
`curl --cacert lumea-root.crt https://192.168.15.199/api/health` deve seguir 200.
