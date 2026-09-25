---
type: project
title: Runbook do host GPU
description: Como preparar o servidor 192.168.15.199 (Ubuntu 24.04, GTX 1660 Super) para receber os containers do eclume e do lumea: IP fixo, driver NVIDIA, Docker, NVIDIA Container Toolkit, firewall e docker context.
resource: deploy/**
tags: [host, deploy, gpu, runbook]
timestamp: 2026-09-24
audience: both
authority: current
source: holetz/eclume#1
maintainer: holetz
---

# Preparar o host 192.168.15.199

Este runbook deixa o servidor pronto para receber os containers do eclume e do lumea. O servidor
roda Ubuntu 24.04 LTS com uma NVIDIA GTX 1660 Super (6 GB). Os passos 1 a 8 rodam **no
servidor**; o passo 9 roda **na máquina de desenvolvimento**.

Portas:

| Serviço | Endereço |
|---|---|
| lumea | `https://192.168.15.199` (443) |
| eclume | `https://192.168.15.199:8443` |

## 1. IP fixo e SSH

1. No roteador, reserve o IP `192.168.15.199` (reserva DHCP) para a placa de rede do servidor.
2. No servidor:
   ```bash
   sudo apt-get update && sudo apt-get install -y openssh-server
   ```
3. Na máquina de desenvolvimento:
   ```bash
   ssh-copy-id usuario@192.168.15.199
   ```
4. Depois de confirmar que o login por chave funciona, desligue o login por senha:
   ```bash
   echo 'PasswordAuthentication no' | sudo tee /etc/ssh/sshd_config.d/10-hardening.conf
   sudo systemctl restart ssh
   ```

## 2. Driver NVIDIA

```bash
sudo ubuntu-drivers install
sudo reboot
nvidia-smi   # a GTX 1660 SUPER deve aparecer com 6144 MiB
```

## 3. Docker Engine e compose plugin (repositório oficial)

```bash
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"   # saia e entre de novo na sessão
```

## 4. NVIDIA Container Toolkit

```bash
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
docker run --rm --gpus all nvidia/cuda:12.6.0-base-ubuntu24.04 nvidia-smi
```

## 5. Diretórios de dados

```bash
sudo mkdir -p /srv/eclume /srv/lumea
sudo chown "$USER":"$USER" /srv/eclume /srv/lumea
df -h /srv   # reserve pelo menos 50 GB para modelos e áudio
```

## 6. Firewall

```bash
sudo ufw default deny incoming
sudo ufw allow from 192.168.15.0/24 to any port 22 proto tcp
sudo ufw allow from 192.168.15.0/24 to any port 443 proto tcp
sudo ufw allow from 192.168.15.0/24 to any port 8443 proto tcp
sudo ufw enable
```

> **Atenção:** portas publicadas pelo Docker (`ports:` no compose) **passam por fora do ufw**.
> Postgres, Redis e MinIO não podem ter `ports:` publicadas, ou devem ser ligados a
> `127.0.0.1:`. Só o Caddy de cada stack publica porta.

## 7. `claude -p` no servidor

Os agentes de sumarização podem usar o Claude Code do próprio servidor.

```bash
curl -fsSL https://claude.ai/install.sh | bash
claude   # faça o login uma vez; a credencial fica em ~/.claude/.credentials.json
```

Os workers montam `~/.claude/.credentials.json`, no mesmo padrão do `LUMEA_CLAUDE_CREDENTIALS` do
lumea.

## 8. Token do Hugging Face (diarização)

1. Crie um token de leitura em <https://huggingface.co/settings/tokens>.
2. Aceite os termos de `pyannote/speaker-diarization-community-1`, e também dos demais modelos
   gated indicados pela spec `engine-asr-whisperx`, com a mesma conta.
3. O token entra no `.env` do eclume no servidor. Ele nunca é versionado.

## 9. Na máquina de desenvolvimento: contexto Docker

```bash
docker context create gpu-host --docker "host=ssh://usuario@192.168.15.199"
docker --context gpu-host info | grep -i runtimes   # deve listar nvidia
docker --context gpu-host run --rm --gpus all nvidia/cuda:12.6.0-base-ubuntu24.04 nvidia-smi
```

Os builds e deploys usam `--context gpu-host`. O loop de desenvolvimento continua local.

## 10. Certificado do Caddy (depois do primeiro deploy)

Cada stack usa Caddy com `tls internal`. HTTPS é obrigatório para a conversão de mídia no navegador
(WebCodecs) e para o microfone. Instale a CA raiz em cada máquina cliente:

```bash
# extrair a CA raiz do Caddy do eclume
docker --context gpu-host compose -p eclume cp caddy:/data/caddy/pki/authorities/local/root.crt ./eclume-root.crt
```

- **Linux:** copie para `/usr/local/share/ca-certificates/eclume-root.crt` e rode
  `sudo update-ca-certificates`.
- **Windows:** rode `certutil -addstore -f Root eclume-root.crt` como administrador.
- **macOS:** rode
  `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain eclume-root.crt`.
- **Firefox:** importe em Configurações → Certificados, porque ele usa repositório próprio.

## Instaladores do desktop (sem assinatura de código)

- **Windows:** o SmartScreen avisa na primeira execução. Clique em "Mais informações" e depois em
  "Executar assim mesmo".
- **macOS:** abra com botão direito → Abrir, ou rode `xattr -dr com.apple.quarantine /Applications/eclume.app`.
- **Linux** (AppImage/.deb): sem aviso.
