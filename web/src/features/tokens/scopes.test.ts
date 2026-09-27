import { describe, expect, it } from 'vitest'
import { expiresAt, EXPIRATIONS, SCOPE_GROUPS, SCOPES, summarizeScopes } from './scopes'

describe('escopos', () => {
  it('resume os grupos completos e conta os escopos soltos', () => {
    expect(
      summarizeScopes(['recordings:read', 'transcripts:read', 'summaries:read', 'summaries:write', 'recordings:write']),
    ).toBe('ler, resumos, campos')
    expect(summarizeScopes(['recordings:read', 'transcripts:read', 'people:read'])).toBe('ler, +1')
    expect(summarizeScopes(['recordings:delete'])).toBe('excluir')
  })

  it('sem grupo completo, lista os escopos como vieram', () => {
    expect(summarizeScopes(['transcripts:read', 'people:read'])).toBe('transcripts:read, people:read')
  })

  it('cobre todo escopo do contrato e cada escopo de grupo existe', () => {
    const known = SCOPES.map((s) => s.scope)
    expect(new Set(known).size).toBe(9)
    for (const group of SCOPE_GROUPS) for (const scope of group.scopes) expect(known).toContain(scope)
  })

  it('oferece 30 dias, 90 dias e nunca, e calcula a validade', () => {
    expect(EXPIRATIONS.map((e) => e.label)).toEqual(['30 dias', '90 dias', 'Nunca'])
    const now = new Date('2026-09-24T12:00:00Z')
    expect(expiresAt(null, now)).toBeNull()
    expect(expiresAt(30, now)).toBe('2026-10-24T12:00:00.000Z')
  })
})
