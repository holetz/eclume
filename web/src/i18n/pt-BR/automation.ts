import type en from '../en/automation'
import type { Catalog } from '../locale'

const automation: Catalog<typeof en> = {
  kicker: 'Regras',
  title: 'Processamento automático',
  lede: 'Depois de cada gravação, o eclume segue estas etapas sozinho, nesta ordem. Cada uma mostra como está agora e leva à tela que a configura. <how>Saiba como funciona</how>.',
  steps: 'Etapas do processamento automático',
  configure: 'Configurar',
  loading: 'Carregando…',
  transcription: {
    title: 'Pré-processamento e transcrição',
    what: 'O áudio é limpo, transcrito e separado por locutor. Quem configura é o administrador.',
    state: 'Da plataforma',
  },
  voice: {
    title: 'Locutores pela voz',
    what: 'Cada locutor é comparado com as vozes das pessoas cadastradas.',
    link: 'Configurar em Pessoas',
    platformOff: 'Voz: desligada na plataforma',
    noSamples: 'Voz: a conta não guarda amostras de voz',
    suggestOnly: 'Voz: só sugere, não liga sozinho',
    auto: 'Voz: liga sozinho a partir de {{threshold}}',
  },
  naming: {
    title: 'Marcação dos locutores',
    what: 'Exigida, a gravação com algum locutor sem pessoa espera você nomeá-lo antes do tipo, dos campos, das coleções e do resumo.',
    switch: 'Exigir a marcação dos locutores',
    optional: 'Não exigida: a gravação segue com "Locutor N"',
    required: 'Exigida',
    waiting_one: 'Exigida · {{count}} gravação esperando você',
    waiting_other: 'Exigida · {{count}} gravações esperando você',
  },
  agendaType: {
    title: 'Tipo de agenda',
    what: 'O agente escolhe o tipo da reunião, que dá o título e as tags padrão.',
    link: 'Configurar em Tipos de agenda',
    count_zero: '{{count}} tipos de agenda',
    count_one: '{{count}} tipo de agenda',
    count_other: '{{count}} tipos de agenda',
  },
  fields: {
    title: 'Campos personalizados',
    what: 'O agente preenche os campos marcados para preenchimento automático.',
    link: 'Configurar em Campos personalizados',
    none: 'Nenhum campo preenchido pelo agente',
    count_one: '{{count}} campo preenchido pelo agente',
    count_other: '{{count}} campos preenchidos pelo agente',
  },
  tags: {
    title: 'Tags',
    what: 'O agente marca os assuntos da gravação junto com os campos.',
    link: 'Configurar em Tags',
    off: 'Tags: desligadas',
    fixed: 'Tags: só as cadastradas ({{n}})',
    free: 'Tags: o agente pode criar tags',
  },
  collections: {
    title: 'Coleções com regra',
    what: 'A gravação entra nas coleções cuja regra ela cumpre.',
    link: 'Configurar em Coleções',
    none: 'Nenhuma coleção com regra',
    count_one: '{{count}} coleção com regra',
    count_other: '{{count}} coleções com regra',
  },
  summary: {
    title: 'Resumo',
    what: 'O resumo segue as instruções do tipo de agenda escolhido.',
    link: 'Configurar o resumo em Tipos de agenda',
    none: 'Resumo padrão em todos os tipos',
    count_one: '{{count}} tipo com instruções de resumo',
    count_other: '{{count}} tipos com instruções de resumo',
  },
}

export default automation
