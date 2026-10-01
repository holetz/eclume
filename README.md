# eclume

Serviço de transcrição institucional e auto-hospedado. Grava reuniões, transcreve na GPU do
servidor, separa e reconhece os locutores, organiza as transcrições por pessoa e as resume com o
agente que o admin da plataforma configurar. Cada usuário tem o próprio espaço, sem organização.

> Estado: em produção no host da consultoria (`https://192.168.15.199:8443`); o runbook está em
> [docs/project/deploy-producao.md](docs/project/deploy-producao.md). A direção do produto está em
> [docs/vision/](docs/vision/index.md); o épico `holetz/eclume#1` é o registro da primeira construção.

## Peças

- **server/**: API FastAPI com contas de usuário isoladas (cadastro aberto), conta de admin separada, PATs,
  gravações, pessoas e busca.
- **worker-gpu/**: WhisperX (ASR, alinhamento, diarização e embeddings de locutor) em CUDA.
- **web/**: interface do usuário e painel de administração, com conversão local de áudio e vídeo
  antes do upload.
- **desktop/**: app Tauri para Windows e Linux (macOS fora enquanto o repositório for privado).
  Detecta reuniões, grava, sincroniza e fica na bandeja do sistema.
- **mobile/**: app Tauri 2 para Android, um microfone portátil que grava com o serviço em primeiro
  plano, marca momentos e sincroniza com o servidor.
- **engines/**: a interface de engine de ASR, compartilhada pelo server e pelo worker.
- **contracts/**: OpenAPI v1 e o schema da transcrição, que são o contrato com integrações como o
  lumea.
- **deploy/**: composes de desenvolvimento e de teste (Postgres com pgvector, Redis e MinIO), o de
  produção no host GPU e os scripts de deploy, backup e release do desktop.
- **docs/**: o conhecimento do projeto, num bundle OKF.

## Auto-hospedagem

Para subir o eclume num servidor seu, com ou sem GPU, siga
[docs/how-to/auto-hospedar.md](docs/how-to/auto-hospedar.md).

## Desenvolvimento

Do clone a uma gravação transcrita numa máquina sem GPU:
[docs/how-to/desenvolver-sem-gpu.md](docs/how-to/desenvolver-sem-gpu.md). Os comandos de build,
lint e teste de cada peça estão em
[docs/standards/code/monorepo.md](docs/standards/code/monorepo.md).

## Licença

MIT. Veja [LICENSE](LICENSE).
