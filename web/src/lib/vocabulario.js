// Vocabulário de estados do eclume: os nomes em pt-BR que web, desktop e celular mostram para a
// gravação no aparelho, a gravação no servidor, as etapas do processamento e os motivos de uma etapa
// pulada. Fonte única em web/src/lib/vocabulario.js, copiada byte a byte para
// desktop/ui/js/vocabulario.js e mobile/ui/src/app/vocabulario.js (um teste em cada cliente confere).
// Módulo ES puro, sem import nem sintaxe TS: o desktop o carrega sem bundler.

/** @typedef {'neutral' | 'progress' | 'success' | 'danger' | 'warning'} Tom */

/**
 * A gravação no aparelho (desktop e celular), antes e durante o envio. "Na fila" não mora aqui: é
 * só a espera pela transcrição no servidor.
 * @type {Record<'recording' | 'pending' | 'uploading' | 'uploaded' | 'interrupted' | 'failed', { rotulo: string, tom: Tom }>}
 */
export const ESTADOS_APARELHO = {
  recording: { rotulo: 'Gravando', tom: 'progress' },
  pending: { rotulo: 'Aguardando envio', tom: 'neutral' },
  uploading: { rotulo: 'Enviando', tom: 'progress' },
  uploaded: { rotulo: 'Enviada', tom: 'success' },
  interrupted: { rotulo: 'Interrompida', tom: 'warning' },
  failed: { rotulo: 'Falhou o envio', tom: 'danger' },
}

/**
 * A gravação no servidor. "Em andamento" cede o rótulo à etapa corrente (`ETAPAS[...].andamento`);
 * "Cancelada" é a gravação `failed` cujo job terminou `cancelled`.
 * @type {Record<'na_fila' | 'em_andamento' | 'pronta' | 'falhou' | 'cancelada', { rotulo: string, tom: Tom }>}
 */
export const ESTADOS_SERVIDOR = {
  na_fila: { rotulo: 'Na fila', tom: 'neutral' },
  em_andamento: { rotulo: 'Em andamento', tom: 'progress' },
  pronta: { rotulo: 'Pronta', tom: 'success' },
  falhou: { rotulo: 'Falhou', tom: 'danger' },
  cancelada: { rotulo: 'Cancelada', tom: 'neutral' },
}

/**
 * As seis etapas, na ordem do servidor (`STEPS` em pipeline.py): o nome e o rótulo enquanto anda.
 * @type {Array<{ etapa: 'received' | 'preprocessing' | 'transcription' | 'agenda_type' | 'fields' | 'summary', nome: string, andamento: string }>}
 */
export const ETAPAS = [
  { etapa: 'received', nome: 'Áudio recebido', andamento: 'Enviando' },
  { etapa: 'preprocessing', nome: 'Pré-processamento', andamento: 'Pré-processando' },
  { etapa: 'transcription', nome: 'Transcrição', andamento: 'Transcrevendo' },
  { etapa: 'agenda_type', nome: 'Tipo de agenda', andamento: 'Detectando o tipo' },
  { etapa: 'fields', nome: 'Campos', andamento: 'Preenchendo campos' },
  { etapa: 'summary', nome: 'Resumo', andamento: 'Resumindo' },
]

/**
 * O estado de uma etapa em palavra, para ser lido sem a cor da barra.
 * @type {Record<'pending' | 'active' | 'done' | 'skipped' | 'failed', string>}
 */
export const ESTADOS_ETAPA = {
  pending: 'esperando',
  active: 'em andamento',
  done: 'concluída',
  skipped: 'pulada',
  failed: 'falhou',
}

/**
 * O texto de cada código de motivo (`reason`) que o servidor grava numa etapa pulada. Código novo no
 * servidor exige texto aqui (um teste confere); código desconhecido aparece cru na tela.
 * @type {Record<string, string>}
 */
export const MOTIVOS = {
  no_provider: 'nenhum agente configurado; fale com quem administra',
  no_auto_fields: 'nenhum campo com preenchimento automático',
  no_types: 'só o tipo padrão está cadastrado: ficou ele',
  set_by_user: 'o tipo foi escolhido por você',
  no_agenda_type: 'a gravação não tem tipo de agenda',
  before_pipeline: 'gravação anterior ao processamento automático',
  worker_without_preprocess: 'o processador desta gravação não faz pré-processamento',
  summary_deleted: 'o resumo foi excluído',
  cancelled: 'a transcrição foi cancelada',
}

/**
 * O texto do motivo, ou o próprio código quando ainda não há texto.
 * @param {string} codigo
 * @returns {string}
 */
export function motivo(codigo) {
  return MOTIVOS[codigo] ?? codigo
}

/**
 * O nome da etapa, ou o próprio código quando a etapa é nova.
 * @param {string} etapa
 * @returns {string}
 */
export function nomeDaEtapa(etapa) {
  return ETAPAS.find((item) => item.etapa === etapa)?.nome ?? etapa
}
