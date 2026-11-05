import type en from '../en/environment'
import type { Catalog } from '../locale'

const environment: Catalog<typeof en> = {
  kicker: 'Minhas configurações',
  title: 'Ambiente',
  lead: 'Ajustes deste navegador. Eles valem aqui, sem mudar a sua conta nem os outros computadores e celulares.',
  look: {
    title: 'Aparência',
    theme: 'Tema',
    themes: { system: 'Sistema', light: 'Claro', dark: 'Escuro' },
    density: 'Densidade',
    densityHint: 'Compacta aperta os espaços entre blocos para caber mais na tela; o tamanho do texto não muda.',
    densities: { comfortable: 'Confortável', compact: 'Compacta' },
    motion: 'Movimento',
    motionHint: 'Reduzir desliga as animações e transições, mesmo que o sistema não peça.',
    motions: { system: 'Seguir o sistema', reduce: 'Reduzir' },
  },
  agenda: {
    title: 'Agenda',
    workHours: 'Expediente',
    start: 'Início',
    end: 'Fim',
    workHint: 'A faixa destacada na semana da biblioteca, que ela mostra inteira ao abrir. O padrão é {{start}} às {{end}}.',
    opening: 'Abrir a biblioteca em',
    openingHint: 'Última usada volta à visão e aos filtros da sua última visita.',
    openings: { ultima: 'Última usada', semana: 'Semana', mes: 'Mês', lista: 'Lista' },
  },
  notices: {
    title: 'Avisos',
    toggle: 'Avisar no navegador quando uma gravação terminar de processar',
    unsupported: 'Este navegador não mostra avisos do sistema para este endereço.',
    blocked: 'O navegador bloqueou os avisos deste site: libere nas permissões do site e ligue de novo.',
    hint: 'Resumo pronto, pronta sem resumo ou com falha, com a aba do eclume aberta. Com a aba em segundo plano, o título dela também conta os avisos.',
  },
  keys: {
    title: 'Atalhos de teclado',
    wheel: 'roda do mouse',
    help: 'Abre a ajuda da página em que você está',
    close: 'Fecha a ajuda ou o diálogo aberto',
    zoom: 'Aproxima ou afasta as horas na semana da biblioteca',
  },
  restore: 'Restaurar os padrões',
  restored: 'Tudo voltou ao padrão.',
}

export default environment
