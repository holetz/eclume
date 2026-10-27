---
type: how-to
title: Auto-hospedar o eclume
description: Como subir o eclume num servidor próprio, com ou sem GPU NVIDIA — requisitos, o caminho sem GPU, o deploy/.env.prod gerado, o deploy por qualquer contexto Docker, o primeiro admin, o provider de resumo, a premissa de rede local (mDNS e CA própria), o que muda ao expor à internet, como fechar o cadastro e o backup.
resource: deploy/deploy.sh, deploy/docker-compose.prod.yml, deploy/docker-compose.cpu.yml, deploy/.env.prod.example, deploy/bootstrap-admin.sh, deploy/backup.sh
tags: [deploy, auto-hospedagem, gpu, cpu, instalacao]
timestamp: 2026-10-07
audience: both
source: holetz/eclume#126, holetz/eclume#151
maintainer: holetz
---

# Auto-hospedar o eclume

O eclume roda inteiro num servidor Linux seu, por Docker Compose, em oito contêineres de longa
duração: a borda Caddy com HTTPS na porta 8443 e o web embutido, a API, um worker CPU, o worker de
transcrição, o anúncio mDNS, Postgres, Redis e MinIO. O deploy sai de uma **estação** (a máquina em que
você clonou o repositório) e fala com o servidor por um **contexto Docker** `ssh://`: o build
roda no daemon do servidor e as pastas de dados são criadas por SSH. Este guia vale para qualquer
servidor; o registro concreto da produção da instituição, que segue estes passos, está em
[deploy-producao.md](../project/deploy-producao.md) e [host-setup.md](../project/host-setup.md).

## Requisitos

**No servidor**

- Linux x86_64 com Docker Engine **25 ou mais novo** (o `start_interval` dos healthchecks) e o
  plugin Compose **2.24 ou mais novo** (o deploy confere), e SSH por chave a partir da estação.
- Memória: os tetos padrão somam uns 12 GB (8 GB do worker de transcrição, 2 GB do worker CPU e o
  resto em fração de GB), mais o Postgres, sem teto; cada serviço tem o par
  `ECLUME_MEM_<SERVIÇO>`/`ECLUME_MEMSWAP_<SERVIÇO>` para ajustar
  ([deploy-producao.md](../project/deploy-producao.md#stack)).
- Disco: a imagem do worker de transcrição tem **~8 GB**, e o primeiro job baixa **~3,9 GB** de
  modelos para `<ECLUME_DATA_DIR>/models`; reserve 50 GB ou mais para modelos e áudio. O deploy
  recusa com o disco em 90% ou mais (`ECLUME_DISK_LIMIT`).
- Uma pasta de dados do usuário do SSH, por padrão `/srv/eclume`
  (`sudo mkdir -p /srv/eclume && sudo chown "$USER": /srv/eclume`).
- **Com GPU:** NVIDIA de **6 GB ou mais**, driver instalado (`nvidia-smi` responde) e o NVIDIA
  Container Toolkit configurado no Docker
  (`docker run --rm --gpus all nvidia/cuda:12.6.0-base-ubuntu24.04 nvidia-smi` responde).
- **Token do Hugging Face** (leitura), com os termos de `pyannote/speaker-diarization-community-1`
  aceitos na mesma conta: é o que liga a diarização (separar os locutores). Ele vai em
  `<ECLUME_DATA_DIR>/secrets/hf_token` ou no painel de administração. Sem GPU, não é usado.
- Firewall: só a 8443/tcp (o Caddy) e a 5353/udp (o anúncio mDNS) abertas para a rede local.
  Postgres, Redis e MinIO não publicam porta.

**Na estação:** `git`, Docker CLI com o plugin Compose, `ssh`, `openssl`, `python3` e o `gh`
autenticado (o deploy confere o commit e o status do gate no GitHub).

## Sem GPU

Um servidor sem GPU NVIDIA sobe o mesmo stack com `--sem-gpu`: o deploy acrescenta
`deploy/docker-compose.cpu.yml`, e o worker de transcrição usa a mesma imagem com a engine `cpu`
(faster-whisper `small` int8), sem reserva de GPU. O limite: **sem diarização** (a transcrição
sai com um locutor só, e a identificação por voz não tem o que sugerir) e várias vezes mais lenta
que na GPU. O contrato da engine está em
[jobs-transcricao.md](../standards/api/jobs-transcricao.md#how-the-worker-does-its-part).
Passe `--sem-gpu` em **todo** deploy desse servidor: sem ele, o compose pede a GPU e o worker não
sobe.

## 1. Contexto Docker

Na estação, um contexto apontando para o servidor por SSH:

```bash
docker context create meu-servidor --docker "host=ssh://usuario@servidor"
docker --context meu-servidor info
```

Os scripts de deploy não têm contexto padrão: passe `--context meu-servidor` ou exporte
`ECLUME_DOCKER_CONTEXT=meu-servidor`. Sem isso, recusam dizendo o que falta.

## 2. `deploy/.env.prod`

```bash
bash deploy/deploy.sh --context meu-servidor --gerar-env
```

gera `deploy/.env.prod` (600, fora do git) a partir de `deploy/.env.prod.example`, com segredos
aleatórios. Edite à mão o que é seu, que o exemplo traz como `troque-…` — o deploy recusa enquanto
houver um:

- `ECLUME_PUBLIC_HOST`: o IP ou nome pelo qual a rede chega ao servidor.
- `ECLUME_PUBLIC_URL`: `https://<ECLUME_PUBLIC_HOST>:8443`.
- `ECLUME_DATA_DIR` (padrão `/srv/eclume`), `ECLUME_SERVER_NAME` e `ECLUME_CLAUDE_CLI` (`0` ou
  `1`, ver o provider abaixo).

O deploy guarda uma cópia em `<ECLUME_DATA_DIR>/secrets/env.prod` no servidor e, numa estação
sem o arquivo, a restaura de lá. O significado de cada variável está nos comentários do exemplo e
na tabela de [deploy-producao.md](../project/deploy-producao.md#segredos).

## 3. Deploy

```bash
bash deploy/deploy.sh --context meu-servidor --plan      # só mostra o que faria
bash deploy/deploy.sh --context meu-servidor             # com GPU
bash deploy/deploy.sh --context meu-servidor --sem-gpu   # sem GPU
```

O deploy sai do commit do `HEAD`, limpo e publicado no GitHub, e exige nele o status
`eclume/gate` = `success`. Um commit do `main` publicado já tem o gate; para outro commit (um fork,
um ramo seu), `--sem-gate "<motivo>"` e `--fora-do-main "<motivo>"` dispensam essas duas
exigências e deixam o motivo no histórico. Os passos, a retenção e o retorno (`--voltar`) estão em
[deploy-producao.md](../project/deploy-producao.md#deploy).

## 4. Primeiro admin

```bash
bash deploy/bootstrap-admin.sh --context meu-servidor --email admin@exemplo.com.br
```

cria a conta de admin do painel uma vez só. O e-mail não tem padrão. A senha é gerada no servidor,
em `<ECLUME_DATA_DIR>/secrets/admin-password` (600), e nunca passa pela estação. O painel fica em
`https://<servidor>:8443/admin/entrar`.

## 5. Provider de resumo

A transcrição não precisa de provider; o resumo precisa. Cadastre um em **Admin → Agentes**. Os
tipos e o que cada um exige — chave de API, um servidor compatível com a API da OpenAI na sua rede,
ou a CLI do Claude, que só entra na imagem com `ECLUME_CLAUDE_CLI=1` — estão na matriz de
[server-agentes.md](../standards/code/server-agentes.md#what-each-provider-requires). Com
`ECLUME_CLAUDE_CLI=0`, a imagem do server fica só com software livre.

## 6. Clientes na rede local

O eclume assume uma **rede local**: o Caddy usa uma **CA própria** (`tls internal`), e o serviço
`mdns` anuncia `_eclume._tcp` para o desktop e o celular acharem o servidor sozinhos.

- A raiz da CA fica em `https://<servidor>:8443/downloads/eclume-root.crt`. Instale-a nos
  navegadores e sistemas que acessam o eclume (HTTPS é obrigatório para o microfone e a conversão
  de mídia); os comandos por sistema estão em
  [deploy-producao.md](../project/deploy-producao.md#ca-raiz-nos-clientes). Confira a impressão
  digital (`openssl x509 -noout -fingerprint -sha256 -in eclume-root.crt`) com o servidor.
- Os apps desktop e móvel conferem e fixam a CA sozinhos na primeira execução. As instruções de
  instalação deles ficam em `/downloads/` do próprio servidor.
- Apagar `<ECLUME_DATA_DIR>/caddy/data` gera outra CA e obriga a reinstalar a raiz em todos os
  clientes.

## 7. Expor à internet

O stack foi feito para a rede local. Antes de publicar a 8443 fora dela:

- **Feche o cadastro** (abaixo) ou aceite que qualquer pessoa crie conta.
- **Troque a CA interna por um certificado público** (domínio próprio e o HTTPS automático do
  Caddy) e não publique `eclume-root.crt` junto dele (holetz/eclume#102).
- O endurecimento do servidor exposto (limites, cabeçalhos, tentativas) é holetz/eclume#99, e a CA
  com restrição de nome, holetz/eclume#101; até lá, prefira uma VPN para o acesso de fora.
- O mDNS não atravessa a internet: os clientes de fora digitam o endereço.

## 8. Fechar o cadastro

O cadastro nasce aberto (`ECLUME_SIGNUP_OPEN=true`): qualquer pessoa que alcança o servidor cria
uma conta. Para fechar, ponha `ECLUME_SIGNUP_OPEN=false` em `deploy/.env.prod` e recrie o server
sem build:

```bash
bash deploy/deploy.sh --context meu-servidor --sem-build    # + --sem-gpu, se for o caso
```

O admin ativa e desativa contas em **Admin → Usuários**; não há convite.

## 9. Backup

O deploy instala no crontab do usuário do SSH o `backup.sh` diário: snapshot restic cifrado do
banco, dos objetos e dos segredos em `<ECLUME_DATA_DIR>/backups/restic`. Um backup só no mesmo
disco não sobrevive ao disco: configure o repositório fora do servidor
(`<ECLUME_DATA_DIR>/secrets/restic-fora.env`) e teste a restauração, como em
[deploy-producao.md](../project/deploy-producao.md#backup-e-restauração).
