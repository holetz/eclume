// Rótulos e chaves da seção Identificação por voz do admin.
export const VOICE_AUDIT_KEY = ['admin', 'voice-audit'] as const

/** Evento da trilha em pt-BR; um valor novo do contrato aparece cru. */
export const AUDIT_EVENTS: Record<string, string> = {
  comparison: 'Comparação na transcrição',
  suggested: 'Sugestão',
  accepted: 'Sugestão aceita',
  rejected: 'Sugestão recusada',
  sample_added: 'Amostra guardada',
  sample_removed: 'Amostra removida',
  link_restored: 'Vínculo restaurado (retranscrição)',
  link_dropped: 'Vínculo perdido (retranscrição)',
  consent_granted: 'Consentimento registrado',
  consent_revoked: 'Consentimento revogado',
  voiceprint_deleted: 'Impressão excluída',
  exported: 'Dados exportados',
  org_opt_in_changed: 'Configuração de voz alterada',
  org_purged: 'Todas as impressões apagadas',
}
