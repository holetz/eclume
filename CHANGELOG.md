# Changelog do eclume

O que muda no **produto** — server, worker GPU, engines e web, que sobem juntos no mesmo deploy —
para quem hospeda e para quem usa. Os apps têm o próprio: [desktop](desktop/CHANGELOG.md) e
[celular](mobile/CHANGELOG.md). O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/)
e as versões, o [SemVer](https://semver.org/lang/pt-BR/); quando cada linha sobe e o que entra aqui
está em [versionamento.md](docs/standards/code/versionamento.md). A versão do contrato
(`info.version` da v1) tem linha própria e cada entrada a cita.

## [Não lançado]

### Adicionado

- Marcação obrigatória dos locutores: com a preferência da conta ligada, a cadeia por agente espera
  todo locutor ter nome, com a etapa `speakers` e o aviso "Aguardando locutores" (contrato 2.22.0,
  holetz/eclume#144).
- Agente no lugar de Perguntas: conversas guardadas, arquivos de entrada e de saída e o histórico
  das sessões (contrato 2.23.0, holetz/eclume#142).
- Habilidades do usuário no Agente e ações no ambiente que o agente propõe e a pessoa confirma
  (contrato 2.24.0, holetz/eclume#145).

### Alterado

- Server mais enxuto em CPU e memória, sem mudar comportamento: sonda de fila mínima, imports sob
  demanda, `eclume-server worker` com as filas `eclume:default` e `eclume:agents` num só processo,
  pool de conexões configurável, `last_used_at` do PAT a cada 60 s, upload sem cópia e índice
  parcial dos jobs em aberto (migration 033_indice_jobs_em_aberto, holetz/eclume#150).
- Tela da gravação com a transcrição numa área de rolagem própria e os locutores num bloco
  recolhível (holetz/eclume#143).

### Obsoleto

- O chat sobre a base (`/base-chat`), que o Agente substitui (contrato 2.23.0, holetz/eclume#142).

### Para quem hospeda

- **Migrations**, nenhuma destrutiva: `030_marcacao_dos_locutores` (troca os `CHECK` das etapas),
  `031_agente_conversas` e `032_agente_habilidades_e_acoes`.

## [0.2.0] - 2026-10-03

O que entrou em `main` depois da 0.1.0, antes de existir a norma de versionamento (holetz/eclume#89 a
#130, mesclados entre 2026-10-01 e 2026-10-02).

### Adicionado

- Etapas do processamento que se retomam sozinhas depois de uma queda e podem ser canceladas
  (holetz/eclume#96).
- Upload retomável por 7 dias e exclusão completa: apagar gravação ou conta não deixa objeto no
  bucket (holetz/eclume#97).
- Deploy rastreável e reversível: o `/health` diz o commit da imagem e o `deploy.sh --voltar` sobe
  um deploy retido (holetz/eclume#92).
- Observabilidade e alertas da produção: `eclume-server saude --json`, o `vigia.sh` e o aviso de
  vencimento do token do agente (holetz/eclume#93).
- Backup cifrado fora do host, com os segredos e o ensaio de restauração (holetz/eclume#91).
- Cotas por conta (armazenamento, arquivo, uploads abertos, minutos de áudio e pedidos ao agente) e
  fila justa da GPU (holetz/eclume#98).
- Posição na fila de transcrição e estado do processador (holetz/eclume#117).
- Aviso de resumo pronto ou com falha em qualquer cliente (holetz/eclume#118).
- Recuperação de senha por link de uso único gerado pelo admin (holetz/eclume#119).
- Conta que não guarda amostras de voz e a tela que diz o que sai do servidor (holetz/eclume#116).
- Idioma da transcrição por conta e por arquivo (holetz/eclume#121).
- Primeiros passos e estados vazios que ensinam, do resumo até a regra (holetz/eclume#115).
- CA própria do servidor com restrição de nome, com rotação anunciada no descritor
  (`ca_next_sha256`) (holetz/eclume#101).
- Referência da API navegável e offline em `/referencia-api.html`, ligada pela tela de tokens de
  acesso (holetz/eclume#127).

### Mudado

- Estados do processamento com nome e motivo, iguais no web, no desktop e no celular
  (holetz/eclume#114).
- Configurações e regras do processamento automático reorganizadas (holetz/eclume#120).
- Transcrição amarrada à revisão de ponta a ponta (holetz/eclume#95).
- Servidor endurecido: limites de corpo, cabeçalhos de segurança, tentativas de login e escopos
  (holetz/eclume#99).
- Serviços de produção isolados e com limite de memória; MinIO e Redis com credencial por serviço
  (holetz/eclume#94).
- O provider de resumo deixa de exigir binário proprietário: a CLI `claude` na imagem passa a ser
  escolha de quem hospeda (holetz/eclume#129).
- Web em data router, com erro por rota e rascunho do resumo protegido (holetz/eclume#110),
  resiliente a queda de rede, sessão vencida e troca de conta (holetz/eclume#111), com transcrição
  longa fluida (holetz/eclume#112) e no Design System, com o contraste dos controles corrigido
  (holetz/eclume#122, holetz/eclume#130).
- `owner` e `created_by` marcados como obsoletos na v1: continuam preenchidos e saem na `/api/v2`
  (contrato 2.11.0, holetz/eclume#100).
- Toolchains, imagens e dependências fixadas e atualizadas (holetz/eclume#90).

### Para quem hospeda

- **Migrations**, nenhuma destrutiva: `024_exclusao_no_armazenamento`, `025_validade_da_chave`,
  `026_cotas_e_fila_justa`, `027_redefinicao_de_senha`, `028_conta_sem_amostras_de_voz` e
  `029_idioma_da_conta`.
- **Variáveis novas** no env de produção (o modelo é o `deploy/.env.prod.example`):
  - `ECLUME_CLAUDE_CLI` (`0` ou `1`), **obrigatória**: o deploy recusa um env que não a declare;
    `1` mantém a CLI do provider `claude-cli` na imagem.
  - `ECLUME_MINIO_SERVER_PASSWORD`, `ECLUME_MINIO_GPU_PASSWORD`, `ECLUME_REDIS_SERVER_PASSWORD` e
    `ECLUME_REDIS_GPU_PASSWORD`: o deploy gera as que faltarem.
  - `ECLUME_TLS_CA` (`eclume` ou `local`) e `ECLUME_CA_NOMES`: a CA do HTTPS; a troca da raiz do
    Caddy pela própria segue a rotação em três passos de
    [deploy-producao.md](docs/project/deploy-producao.md).
  - `ECLUME_SIGNUPS_PER_IP_PER_DAY` (padrão 5) e os limites de memória `ECLUME_MEM_*` (com padrão
    no compose).
- **Contrato**: 2.9.0 → 2.21.0, só crescendo.
- **Apps compatíveis**: desktop 0.4.1 e celular 0.1.1, que trazem a fixação estrita da CA
  (holetz/eclume#102).

## [0.1.0] - 2026-09-30

A linha de base: o que está em produção no host desde o primeiro deploy até 2026-09-30.

### Adicionado

- API com contas de usuário isoladas e cadastro aberto, conta de admin separada, PATs e
  dispositivos pareados; gravações, pessoas, busca, coleções automáticas e tags.
- Transcrição na GPU com WhisperX: alinhamento, diarização, identificação de locutores por voz e
  atribuição automática.
- Resumo pelo agente que o admin configura, com tipos de agenda, campos e chat sobre a base.
- Web com a biblioteca, a gravação, as configurações, a ajuda e o painel do admin, com conversão
  local de áudio e vídeo antes do upload.
- Servidor MCP para dispositivos e integrações.

### Para quem hospeda

- **Migrations**: `001_nucleo`, `002_agentes`, `003_pessoas_e_busca`, `004_painel_admin`,
  `005_identificacao_por_voz`, `006_papel_de_conexao`, `007_purga_de_embeddings`,
  `008_conta_por_usuario` (**destrutiva**: tira a organização, os grupos, o compartilhamento, os
  convites e a auditoria de voz; faça o backup antes, como em
  [deploy-producao.md](docs/project/deploy-producao.md)), `009_tipos_de_agenda`,
  `010_campos_e_valores`, `011_plataforma_de_processamento`, `012_etapas_do_pipeline`,
  `013_revisao_do_processamento`, `014_gravacao_resumo`, `015_dispositivos_e_mcp`,
  `016_origem_mobile`, `017_dispositivo_le_resumo`, `018_dispositivo_le_transcricao`,
  `019_atribuicao_automatica_de_locutores`, `020_pessoas_enriquecidas`,
  `021_tipo_de_agenda_padrao`, `022_colecoes_automaticas` e `023_cadastro_de_tags`.
- **Contrato**: 2.9.0.
- **Apps compatíveis**: desktop 0.4.0, publicado junto com ela, e celular 0.1.0.
