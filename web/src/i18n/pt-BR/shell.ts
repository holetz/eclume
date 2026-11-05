import type en from '../en/shell'
import type { Catalog } from '../locale'

const shell: Catalog<typeof en> = {
  nav: {
    primary: 'Principal',
    group: {
      agent: 'Agente',
      recordings: 'Gravações',
      organize: 'Organizar',
      rules: 'Regras',
      settings: 'Minhas configurações',
      help: 'Ajuda',
    },
    part: {
      account: 'Conta e privacidade',
      devices: 'Aparelhos',
      integrations: 'Integrações',
      environment: 'Ambiente',
    },
    item: {
      agent: 'Agente',
      conversations: 'Conversas',
      skills: 'Habilidades',
      library: 'Biblioteca',
      search: 'Busca',
      people: 'Pessoas',
      collections: 'Coleções',
      tags: 'Tags',
      automation: 'Processamento automático',
      agendaTypes: 'Tipos de agenda',
      fields: 'Campos personalizados',
      account: 'Conta',
      desktopApp: 'App desktop',
      mobileApp: 'App móvel',
      mcp: 'Conexão MCP',
      tokens: 'Tokens de acesso',
      environment: 'Ambiente',
      helpCenter: 'Central de ajuda',
    },
  },
  account: {
    helpThisPage: 'Ajuda desta página',
    help: 'Ajuda',
    settings: 'Configurações',
    logout: 'Sair',
    loggingOut: 'Saindo…',
    logoutDuringUpload: 'Sair durante o envio?',
    uploadInterrupted: 'O envio em andamento será interrompido.',
  },
  frame: {
    skipToContent: 'Pular para o conteúdo',
    menu: 'Menu',
  },
  connection: {
    offline: 'Sem conexão com o servidor. O que está na tela pode estar desatualizado; tentando de novo…',
  },
  copy: {
    failed: 'Não foi possível copiar. Selecione o texto e copie.',
  },
  help: {
    title: 'Ajuda',
    close: 'Fechar a ajuda',
    openCenter: 'Abrir a central de ajuda',
    shortcut: 'Pressione <key>?</key> a qualquer momento',
    about: 'Sobre {{subject}}',
    readArticle: 'Ler o artigo →',
  },
  notFound: {
    title: 'Página não encontrada',
    text: 'O endereço não existe ou mudou.',
    back: 'Voltar à biblioteca',
  },
  routeError: {
    updatedTitle: 'O eclume foi atualizado',
    updatedText: 'Esta tela mudou desde que a aba foi aberta. Recarregue para usar a versão nova.',
    failedTitle: 'Algo deu errado nesta tela',
    failedText: 'Recarregue a página; se o erro continuar, avise quem administra o eclume.',
    reload: 'Recarregar',
  },
  leave: {
    title: 'Descartar alterações?',
    message: 'As alterações ainda não foram salvas.',
    keepEditing: 'Continuar editando',
    discard: 'Descartar',
  },
  outcome: {
    recording: 'Gravação',
    summaryReady: 'Resumo pronto',
    summaryFailed: 'O resumo falhou',
    summaryFailedBody: '{{name}} · abra para gerar de novo',
    noSummary: 'Pronta sem resumo',
    noReason: 'sem motivo informado',
    transcriptionFailed: 'A transcrição falhou',
    transcriptionFailedBody: '{{name}} · abra para ver o motivo',
    awaitingSpeakers: 'Precisa de você',
    awaitingSpeakersBody: '{{name}} · nomeie os locutores para seguir com o resumo',
  },
  privacy: {
    purpose: {
      transcription: 'Transcrição do áudio',
      summaries: 'Resumos',
      fields: 'Campos',
      chat: 'Chat',
      agenda_detection: 'Detecção do tipo de agenda',
    },
    location: {
      server: 'Neste servidor',
      local_network: 'Na rede local',
      disabled: 'Desligado: nada é enviado',
      external: 'Fora do servidor',
      externalBy: 'Fora do servidor: {{processor}}',
    },
  },
  transcription: {
    serverDefault: 'Padrão do servidor: {{language}}',
    accountDefault: 'Padrão da conta: {{language}}',
  },
}

export default shell
