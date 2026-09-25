# eclume

Serviço de transcrição institucional e auto-hospedado. Grava reuniões, transcreve na GPU do
servidor, separa e reconhece os locutores, organiza as transcrições por pessoa e as resume com o
agente que a organização escolher.

> Estado: em definição. O plano de construção é o épico em `holetz/eclume#1`.

## Peças

- **server/**: API FastAPI multiusuário com organizações, PATs, gravações, pessoas e busca.
- **worker-gpu/**: WhisperX (ASR, alinhamento, diarização e embeddings de locutor) em CUDA.
- **web/**: interface do usuário e painel de administração, com conversão local de áudio e vídeo
  antes do upload.
- **desktop/**: app Tauri para Windows, Linux e macOS. Detecta reuniões, grava, sincroniza e fica
  na bandeja do sistema.
- **engines/**: a interface de engine de ASR, compartilhada pelo server e pelo worker.
- **contracts/**: OpenAPI v1 e o schema da transcrição, que são o contrato com integrações como o
  lumea.
- **deploy/**: compose de desenvolvimento (Postgres com pgvector, Redis e MinIO) e, depois, o de
  produção.
- **docs/**: o conhecimento do projeto, num bundle OKF.

## Desenvolvimento

Os comandos de build, lint e teste de cada peça estão em
[docs/standards/code/monorepo.md](docs/standards/code/monorepo.md).

## Licença

MIT. Veja [LICENSE](LICENSE).
