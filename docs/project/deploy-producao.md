---
type: project
title: Deploy de produção no host GPU
description: Como o eclume roda em produção no host 192.168.15.199 — compose do projeto eclume com Caddy na 8443, build no daemon do host pelo contexto Docker, segredos em deploy/.env.prod, conta de admin separada e cadastro aberto, CA interna nos clientes, backup diário por cron com restauração testada, operação e coexistência com o lumea.
resource: deploy/docker-compose.prod.yml, deploy/deploy.sh, deploy/.env.prod.example, deploy/server.Dockerfile, deploy/web.Dockerfile, deploy/web.Caddyfile, deploy/bootstrap-admin.sh, deploy/backup.sh, deploy/restaurar-backup.sh, deploy/smoke_prod.py, deploy/smoke_mcp.py, deploy/prova-web-prod.sh
tags: [deploy, producao, host, caddy, backup, runbook]
timestamp: 2026-09-27
audience: both
authority: current
source: holetz/eclume#14, holetz/eclume#26, holetz/eclume#28, holetz/eclume#29, holetz/eclume#32, holetz/eclume#33, holetz/eclume#35, holetz/eclume#39
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
| `server` | `eclume-server:prod` (`deploy/server.Dockerfile`) | API (`uvicorn`) e o servidor MCP em `/mcp`, com healthcheck em `/api/v1/health`; lê a CA publicada (`/srv/downloads`, read-only) para o descritor `/api/v1/server` |
| `mdns` | `eclume-server:prod` | `eclume-server announce`: anuncia `_eclume._tcp` na LAN com o endereço público e a impressão digital da CA; `network_mode: host`, sem porta publicada ([server-mcp-e-dispositivos.md](../standards/code/server-mcp-e-dispositivos.md#descoberta-na-rede-mdns)) |
| `worker-cpu` | `eclume-server:prod` | `arq eclume_server.worker.WorkerSettings`: ingestão, resumos, expiração de uploads |
| `worker-gpu` | `eclume-worker-gpu:prod` (`worker-gpu/Dockerfile`, ~8 GB) | ASR e diarização, `max_jobs=1` ([worker-gpu.md](worker-gpu.md)) |
| `postgres` | `pgvector/pgvector:pg16` | banco; server e worker CPU conectam como `eclume_server` (sem superusuário, só DML) e as requisições baixam para `eclume_app`; o superusuário `eclume` fica para o `migrate`, o bootstrap e o backup ([server-nucleo.md](../standards/code/server-nucleo.md#papéis-do-banco)) |
| `redis` | `redis:7-alpine` | filas e progresso, com `appendonly` |
| `minio` | `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` | áudio e artefatos (a MinIO parou de publicar imagens) |

One-shots do perfil `tools`, rodados por `compose run --rm`: `minio-init` (bucket), `migrate`
(`eclume-server migrate`, como o superusuário, que também liga o `LOGIN` de `eclume_server` com `ECLUME_RUNTIME_PG_PASSWORD`) e `publish-ca` (copia a CA para `/downloads/`).

- **Só o Caddy publica porta.** O Docker publica por fora do ufw, então Postgres, Redis, MinIO,
  server e web não têm `ports:`. Para depurar, use `compose exec`.
- **Rotas do Caddy.** `/api/*`, `/media/*` e `/mcp` (rota exata) vão ao server sem cortar o prefixo. `/downloads/*` é a
  pasta dos instaladores ([desktop-distribuicao.md](../standards/code/desktop-distribuicao.md)),
  com `Cache-Control: no-cache` nos manifestos e arquivos ocultos escondidos. O resto vai ao SPA.
  Nenhuma rota do SPA pode começar com `/api`, `/media`, `/mcp` ou `/downloads`.
- **O `mdns` é recriado depois do `publish-ca`**, e a conferência do deploy exige que
  `/api/v1/server` traga a impressão digital da CA publicada. O multicast (5353/udp na rede do
  host) depende da regra do ufw do [host-setup.md](host-setup.md#6-firewall).
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
bash deploy/bootstrap-admin.sh                 # uma vez: a conta de admin do painel
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
| `ECLUME_SIGNUP_OPEN` | `true` (padrão): qualquer pessoa na LAN cria conta por `POST /api/v1/auth/signup`, com o aceite do aviso. `false` fecha o cadastro sem deploy de código: mude o env e recrie o server (`bash deploy/deploy.sh --context gpu-host --sem-build`) |
| `ECLUME_CLAUDE_OAUTH_TOKEN` | opcional: token de longa duração do Claude (`claude setup-token`, 1 ano), entregue ao worker CPU como `CLAUDE_CODE_OAUTH_TOKEN`. O caminho normal é o token no painel (abaixo), que vence este; sem nenhum dos dois, o `claude-cli` falha com `provider_not_configured`. **Não monte** o `~/.claude/.credentials.json` do host: a renovação do OAuth diverge no bind mount ([server-agentes.md](../standards/code/server-agentes.md#deploy)) |

### Admin, contas e provider

Não há organização: cada conta de usuário é isolada pela RLS do dono, e o painel é da
**plataforma**. O **painel de administração** fica em
**`https://192.168.15.199:8443/admin/entrar`**: não há link para ele no app do usuário. A **conta de admin** (`admins`) é separada das contas de usuário, com login e
sessão próprios em `/admin/entrar`, que só alcançam `/admin/*`
([server-admin.md](../standards/code/server-admin.md)).

- **Contas de usuário** nascem pelo cadastro aberto (`POST /api/v1/auth/signup`; a tela Criar
  conta do web chega com a holetz/eclume#36), com o aceite do aviso de consentimento. Não há convite nem CLI de usuário; o admin só ativa ou desativa contas em
  Admin → Usuários. `ECLUME_SIGNUP_OPEN=false` fecha o cadastro.
- **Conta de admin.** O `bootstrap-admin.sh` (pelo one-shot `migrate`, com o superusuário) cria a
  conta de admin `admin@example.com` por `eclume-server admin create`. A senha é
  gerada no host e fica **só** em `/srv/eclume/secrets/admin-password` (600). Ela chega ao CLI
  por um pipe (`--password-stdin`) e nunca é gravada na estação. Com alguma conta de admin no
  banco, o script não faz nada.
- **Migração da organização (008, holetz/eclume#32).** Os usuários antigos viraram contas
  independentes, com gravações, pessoas, coleções e templates do dono. Cada admin antigo ganhou
  uma conta de admin com o **mesmo e-mail e o mesmo hash**: a senha de `admin-password` entra nas
  duas até alguém trocar uma delas.
- **Trocar a senha do admin** (encerra as sessões dele):
  `ssh holetz@192.168.15.199 cat /srv/eclume/secrets/admin-password | "${P[@]}" run --rm -T migrate eclume-server admin set-password --email admin@example.com --password-stdin`
  (grave a nova senha no arquivo antes; `P` como em Operação). A senha da conta de usuário se troca pelo app.

O provider padrão da plataforma é o `claude-cli` ("Claude (servidor)", modelo `sonnet`), que
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

O `smoke_prod.py` usa só a biblioteca padrão. Ele confere health, SPA, `/downloads/latest.json`
e o cadastro aberto com o aviso, entra pela sessão de admin (garante o provider) e pela de
usuário, com o mesmo e-mail e a mesma senha (`--admin-email` e `ECLUME_SMOKE_ADMIN_PASSWORD`
quando divergirem), e envia `worker-gpu/tests/fixtures/duas-vozes.ogg` pelo upload
multipart. Depois espera a transcrição com 2 locutores e um resumo `done`. Sobre essa gravação,
prova a gravação centrada no resumo (holetz/eclume#34): edita o resumo à mão (versão `manual`),
pede ao chat "Diga quem fala primeiro na reunião e acrescente isso no início do resumo" e espera a
resposta `done` com `reads` não vazio e uma versão `chat` (o tempo do chat sai no log), volta à
gerada, grava 2 marcadores, acha a gravação na biblioteca do dia dela com `kind=meeting` e baixa
os quatro formatos de exportação conferindo o `Content-Type` e a assinatura `PK` do DOCX. No fim,
imprime `OK`. Um áudio já enviado volta `deduplicated`, e o smoke confere a transcrição que já
existe; cada rodada acrescenta versões e marcadores à mesma gravação.

**Processamento automático** (`--pipeline`): retranscreve uma gravação e espera as seis etapas do
pipeline `done` (recebido, pré-processamento, transcrição, campos, tipo de agenda e resumo), com a
duração de cada uma, os campos automáticos, o tipo detectado e o resumo automático. Uma etapa
`failed` ou `skipped` falha o smoke. Sem `--recording`, a gravação é a do áudio de fixture:

```bash
ssh holetz@192.168.15.199 cat /srv/eclume/secrets/admin-password \
  | python3 deploy/smoke_prod.py --ca /tmp/eclume-root.crt --pipeline --recording <id de uma gravação real>
```

**Painel de administração no navegador** (`npm --prefix web run test:e2e:prod`, só leitura, no
Chrome da estação): entra com a conta de admin, percorre as sete telas com os dados reais, espera a
segunda leitura da Saúde em até 17 s, confere `/admin/voz` → Locutores, que a sessão de admin dá
401 em `GET /api/v1/me` e que o logout fecha a sessão. Os screenshots ficam em
`web/test-results/prod/`. O padrão é o Google Chrome; numa estação sem ele, `E2E_CHANNEL=msedge`
usa o Edge.

```bash
ECLUME_PROD_URL=https://192.168.15.199:8443 ECLUME_ADMIN_EMAIL=admin@example.com   ECLUME_ADMIN_PASSWORD="$(ssh holetz@192.168.15.199 cat /srv/eclume/secrets/admin-password)"   npm --prefix web run test:e2e:prod
```

**MCP e pareamento** (`deploy/smoke_mcp.py`, com o SDK `mcp`, então por `uv run`): confere que o
descritor traz a impressão digital da CA dada, cria um PAT de leitura de 1 hora, e o cliente MCP
real lista as 9 ferramentas, busca e lê uma gravação e tem a exclusão recusada por falta de
`recordings:delete`; depois gera um código de pareamento, troca-o por uma credencial de
dispositivo e confere o estado `used`. Revoga o que criou. A descoberta se prova da estação:

```bash
ssh holetz@192.168.15.199 cat /srv/eclume/secrets/admin-password \
  | uv run python deploy/smoke_mcp.py --ca /tmp/eclume-root.crt
uv run eclume-server discover --timeout 10
```

**Prova do web** (`bash deploy/prova-web-prod.sh`, `web/e2e-prod/prova.spec.ts`, no Chrome da
estação ou com `E2E_CHANNEL=msedge`): entra pela tela com a conta do smoke (a senha é lida no host),
cria um campo temporário, testa a regra nas últimas gravações e o exclui; gera o código de vínculo
em App desktop e confere que a contagem começa entre 9:55 e 10:00 e desce; lê o QR de App móvel no
próprio navegador (SVG → `<canvas>` → `jsqr`) e confere o `pair_url` com o código da tela; confere o
endereço MCP contra `GET /api/v1/server`, cria um token só de leitura e o revoga em Tokens de
acesso; busca "token" na central e abre o artigo; e abre a gaveta de ajuda em Pessoas. Termina
com `OK`, sem erro de página, e deixa os screenshots em `web/test-results/prod/`. Os códigos de
vínculo gerados vencem sozinhos em 10 minutos.

```bash
bash deploy/prova-web-prod.sh
```

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

### Conta por usuário em produção (2026-09-27)

- **Antes:** backup e `restaurar-backup.sh --teste` idênticos à produção (1 organização, 1
  usuário, 7 gravações, 7 transcrições, 10 resumos, 17 objetos).
- **Deploy:** a 008 aplicou sem erro; usuários, gravações, transcrições e resumos ficaram com as
  mesmas contagens, `organizations` sumiu e o admin antigo ganhou a conta de admin com o mesmo
  e-mail. O disco foi de 87% a 89%.
- **Smoke:** cadastro aberto (aviso v1), sessão de admin e sessão de usuário com a senha de
  `admin-password`, transcrição deduplicada e resumo novo pelo `claude-cli` passaram. A conta
  migrada fica com `notice_required` até aceitar o aviso (`POST /api/v1/me/notice`).

### Processamento automático em produção (2026-09-27)

- **Antes:** backup e `restaurar-backup.sh --teste` idênticos à produção (1 usuário, 7 gravações,
  7 transcrições, 11 resumos, 17 objetos).
- **Deploy:** as migrations 009 a 012 aplicaram sem erro. Os 3 templates viraram tipos de agenda
  do dono (mesmo id) e ganharam os 4 tipos padrão; o provider `Claude (servidor)` herdou as
  quatro finalidades; as 7 gravações ganharam o histórico do pipeline (recebido e transcrição
  feitos, o resto `before_pipeline`). A imagem do worker GPU traz o `cb.rnnn` do RNNoise. O disco
  foi de 86% a 84% (a poda levou as imagens antigas).
- **Smoke `--pipeline`:** numa gravação real de 32 s, as seis etapas feitas em 30 s:
  pré-processamento 1,1 s (RNNoise, loudness, sem silêncio a cortar), transcrição 9,9 s, campos
  3,1 s, tipo 4,6 s e resumo 7,5 s. O agente deu o título e as tags, a detecção escolheu
  "Reunião de equipe" (padrão de título e tags padrão aplicados) e o resumo automático saiu pelas
  instruções do tipo, pelo `claude-cli`. Numa gravação sem fala, a cadeia também fechou: nenhum
  campo preenchido e o resumo dizendo que não havia fala.

### Painel de administração em produção (2026-09-27)

- **Antes:** backup e `restaurar-backup.sh --teste` idênticos à produção (1 usuário, 7 gravações,
  7 transcrições, 15 resumos, 18 objetos).
- **Deploy:** nenhuma migration (schema em dia); os scripts em `/srv/eclume/bin/` ficaram com LF.
- **Navegador:** o `test:e2e:prod` passou em 18 s no Edge da estação (sem Chrome instalado):
  as sete telas com os dados reais, as cinco etapas e a API saudável na Saúde, a segunda leitura
  em 15 s, `/admin/voz` → Locutores, 401 em `GET /api/v1/me` com a sessão de admin e o logout. O
  MCP aparece "Ausente" até a holetz/eclume#35.

### Gravação centrada no resumo em produção (2026-09-27)

- **Antes:** backup e `restaurar-backup.sh --teste` idênticos à produção (1 usuário, 7 gravações,
  7 transcrições, 15 resumos, 18 objetos).
- **Deploy:** feito de uma exportação com LF (`git -c core.autocrlf=false archive`), só as imagens
  `server` e `web` (o worker GPU não mudou). A 014 aplicou sem erro: as versões dos resumos
  renumeradas por transcrição, as gravações do desktop com `recorded_at_source: capture`, e as
  tabelas do chat e dos marcadores. Os scripts em `/srv/eclume/bin/` ficaram sem CRLF. A imagem
  do server foi de 507 MB para 522 MB com o `python-docx` (e o `lxml`); o disco ficou em 84%.
- **Smoke:** a edição à mão virou versão `manual`; o chat leu a transcrição (`read_transcript`
  de 00:00:00 a 00:00:30) e criou a versão `chat` em 14 s pelo `claude-cli`; voltar à gerada, os
  2 marcadores, a biblioteca do dia com `kind=meeting` e os quatro formatos (TXT 848 B, SRT
  1 022 B, MD 1 118 B, DOCX 37 kB) passaram.

### MCP e pareamento em produção (2026-09-27)

- **Antes:** backup e `restaurar-backup.sh --teste` idênticos à produção (1 usuário, 7 gravações,
  7 transcrições, 19 resumos, 18 objetos).
- **Deploy:** de uma exportação com LF, só as imagens `server` e `web`. A 015 aplicou sem erro
  (tipo e plataforma dos tokens, `recordings:delete` para quem tinha `recordings:write`,
  `pairing_codes`). O `mdns` subiu na rede do host anunciando `192.168.15.199:8443`, e a
  conferência achou a impressão digital da CA no descritor. A imagem do server foi a 533 MB com o
  `mcp` e o `zeroconf`; o disco ficou em 84%.
- **Smoke:** o SDK `mcp` inicializou, listou as 9 ferramentas, buscou 5 gravações, leu uma
  (campos e etapas) e a transcrição dela (38 646 caracteres) e teve a exclusão recusada por falta
  de `recordings:delete`; o código `AED-YA3` virou a credencial de dispositivo da conta, e os dois
  tokens do smoke foram revogados. Da estação Windows, `eclume-server discover --timeout 10` achou
  o servidor com a impressão digital `98e209f5…3d97792f`, **sem** a regra 5353/udp no ufw: o
  `before.rules` padrão do Ubuntu já aceita o mDNS multicast.
- **Repositório:** as variáveis `ECLUME_SERVER_URL` e `ECLUME_SERVER_CA_SHA256` (a impressão
  digital acima), que o `desktop-release.yml` embute no instalador (holetz/eclume#40).

## Conectar um assistente (MCP)

1. Na web, crie um token em **Conexão MCP** (ou em Tokens de acesso) com os grupos de escopo
   que o assistente precisa ([grupos](../standards/code/server-mcp-e-dispositivos.md#grupos-da-tela-conexão-mcp))
   e a validade; o segredo `eclp_…` aparece uma vez.
2. No cliente MCP, cadastre um servidor HTTP streamable em `https://192.168.15.199:8443/mcp`
   com o header `Authorization: Bearer eclp_…`. Exemplo do Claude Code:
   `claude mcp add --transport http eclume https://192.168.15.199:8443/mcp --header "Authorization: Bearer eclp_…"`.
3. O cliente precisa confiar na CA interna (a seção abaixo); o Claude Code e outros clientes
   em Node aceitam `NODE_EXTRA_CA_CERTS=/caminho/eclume-root.crt`.
4. Revogar o token na web desliga o assistente. A Saúde do admin mostra quantos assistentes
   usaram o MCP nas últimas 24 h.

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
  bucket `eclume-restore-teste`. Depois compara as contagens (usuários, gravações, transcrições,
  resumos e objetos) com a produção e apaga os dois.
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
"${P[@]}" run --rm -T migrate eclume-server admin create --email <e-mail> --name "<nome>" --password-stdin
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
- **Token do Hugging Face:** grave em Administração → Locutores (vence o arquivo) ou troque
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
