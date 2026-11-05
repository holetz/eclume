import type en from '../en/admin'
import type { Catalog } from '../locale'

const admin: Catalog<typeof en> = {
  kicker: 'Painel de administração',
  tabTitle: '{{title}} — Admin eclume',
  badge: 'Admin',
  platform: 'Plataforma',
  signOut: 'Sair',
  signingOut: 'Saindo…',
  section: {
    usuarios: 'Usuários',
    audio: 'Pré-processamento de áudio',
    transcricao: 'Transcrição',
    locutores: 'Locutores',
    agentes: 'Agentes',
    'tipos-de-agenda': 'Tipos de agenda padrão',
    saude: 'Saúde',
  },
  signIn: {
    tabTitle: 'Entrar',
    heading: 'Entrar como admin',
    email: 'E-mail',
    password: 'Senha',
    wrong: 'E-mail ou senha incorretos.',
    submit: 'Entrar',
    submitting: 'Entrando…',
  },
  notFound: {
    title: 'Página não encontrada',
    home: 'Ir para Usuários',
  },
  external: {
    label: 'Dados fora do servidor',
    text: 'Saem deste servidor: {{list}}. Os usuários veem isso em Conta › Privacidade e dados e na linha do cadastro.',
    item: '{{purpose}} ({{processor}})',
    service: 'serviço externo',
  },
  secret: {
    save: 'Salvar',
    saving: 'Salvando…',
    cancel: 'Cancelar',
    stored: '•••••••• guardado',
    replace: 'Substituir',
    delete: 'Apagar',
    writeOnly: 'Só escrita. ',
    writeOnlyUpdated: 'Só escrita · atualizado em {{date}}. ',
    confirmTitle: 'Apagar {{label}}?',
    confirmBody: 'O valor guardado some do servidor e não volta.',
  },
  lastChange: 'Última alteração por {{name}} em {{date}}.',
  defaultSettings: 'Configuração padrão, ainda não alterada.',
  option: {
    engine: {
      'whisperx-local': { hint: 'Padrão: na GPU do servidor, com alinhamento por palavra e separação de locutores.' },
      'openai-compatible': { label: 'Remoto (OpenAI-compatível)', hint: 'Um servidor como o speaches; exige o endereço.' },
      cpu: { hint: 'faster-whisper na CPU, só para desenvolvimento: lento e sem separação de locutores.' },
    },
    computeType: {
      int8_float16: 'int8_float16 (recomendado na GTX 1660)',
      float32: 'float32 (mais VRAM)',
    },
    purpose: {
      summaries: 'Resumos',
      fields: 'Preenchimento de campos',
      chat: 'Chat do resumo',
      agenda_detection: 'Detecção do tipo de agenda',
    },
    providerKind: {
      ollama: { hint: 'Roda só com a fila da GPU vazia; exige o endereço.' },
      'openai-compatible': { label: 'OpenAI-compatível', hint: 'DeepSeek, Groq, OpenRouter ou um servidor local; exige o endereço.' },
      anthropic: { label: 'API da Anthropic', hint: 'Sem chave própria, usa o segredo anthropic_api_key.' },
      'claude-cli': {
        label: 'Claude Code do servidor',
        hint: 'Roda o claude -p no servidor, autenticado pelo token do Claude; exige a imagem construída com a CLI (ECLUME_CLAUDE_CLI=1); sem endereço.',
      },
    },
    apiKey: {
      label: 'Chave de API',
      stored: 'Guardada',
      missing: 'Sem chave',
      clear: 'Apagar a chave guardada',
    },
    claudeToken: {
      label: 'Token do Claude',
      stored: 'Token guardado',
      missing: 'Sem token',
      clear: 'Apagar o token guardado',
      help: 'Num computador com o Claude Code logado na assinatura, rode claude setup-token, autorize no navegador e cole aqui o token sk-ant-oat01-… que ele imprime. Vale 1 ano: quando os resumos falharem por autenticação, gere outro. Uma chave de API da Anthropic (sk-ant-api…) também serve.',
    },
    secretInfo: {
      hf_token: {
        label: 'Token do Hugging Face',
        hint: 'Baixa os modelos do pyannote. A conta precisa ter aceitado os termos de pyannote/speaker-diarization-community-1.',
      },
      anthropic_api_key: {
        label: 'Chave da API da Anthropic',
        hint: 'Usada pelos providers “API da Anthropic” cadastrados sem chave própria.',
      },
    },
    speakers: {
      detect: 'Detectar',
      custom: 'Personalizado ({{min}}–{{max}})',
    },
    step: {
      received: 'Recebido',
      preprocessing: 'Pré-processamento',
      transcription: 'Transcrição',
      fields: 'Preenchimento de campos',
      agenda_type: 'Tipo de agenda',
      summary: 'Resumo',
    },
    service: {
      api: 'Servidor da API',
      storage: 'Armazenamento (MinIO)',
      gpu_worker: 'Worker GPU',
      cpu_worker: 'Worker CPU',
      mcp: 'Servidor MCP',
    },
    serviceStatus: {
      healthy: 'Saudável',
      degraded: 'Degradado',
      down: 'Fora',
      absent: 'Ausente',
    },
  },
}

export default admin
