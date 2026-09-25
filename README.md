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
- **contracts/**: OpenAPI v1 e o schema da transcrição, que são o contrato com integrações como o
  lumea.

## Licença

MIT. Veja [LICENSE](LICENSE).
