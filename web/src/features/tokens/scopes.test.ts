import { describe, expect, it } from 'vitest'
import { setLocale } from '../../i18n'
import { expiresAt, EXPIRATIONS, SCOPE_GROUPS, SCOPES, summarizeScopes } from './scopes'

describe('scopes', () => {
  it('summarizes the complete groups and counts the loose scopes', () => {
    expect(
      summarizeScopes(['recordings:read', 'transcripts:read', 'summaries:read', 'summaries:write', 'recordings:write']),
    ).toBe('ler, resumos, campos')
    expect(summarizeScopes(['recordings:read', 'transcripts:read', 'people:read'])).toBe('ler, +1')
    expect(summarizeScopes(['recordings:delete'])).toBe('excluir')
  })

  it('with no complete group, lists the scopes as they came', () => {
    expect(summarizeScopes(['transcripts:read', 'people:read'])).toBe('transcripts:read, people:read')
  })

  it('covers every contract scope and every group scope exists', () => {
    const known = SCOPES.map((s) => s.scope)
    expect(new Set(known).size).toBe(9)
    for (const group of SCOPE_GROUPS) for (const scope of group.scopes) expect(known).toContain(scope)
  })

  it('offers 30 days, 90 days and never, and computes the expiry', () => {
    expect(EXPIRATIONS.map((e) => e.label)).toEqual(['30 dias', '90 dias', 'Nunca'])
    const now = new Date('2026-09-24T12:00:00Z')
    expect(expiresAt(null, now)).toBeNull()
    expect(expiresAt(30, now)).toBe('2026-10-24T12:00:00.000Z')
  })

  it('reads the labels and the summary in the active locale', async () => {
    await setLocale('en')
    try {
      expect(EXPIRATIONS.map((e) => e.label)).toEqual(['30 days', '90 days', 'Never'])
      expect(SCOPE_GROUPS[0].label).toBe('Search and read recordings')
      expect(SCOPES[0].description).toBe('List and search recordings, see their state and play the audio.')
      expect(summarizeScopes(['recordings:read', 'transcripts:read', 'people:read'])).toBe('read, +1')
    } finally {
      await setLocale('pt-BR')
    }
  })
})
