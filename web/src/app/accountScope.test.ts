import { afterEach, describe, expect, it } from 'vitest'
import { clearUserQueries, enterAccount } from './accountScope'
import { createQueryClient } from './queryClient'

const DRAFT = 'eclume-resumo-rascunho:gravacao-1'

function seeded() {
  const client = createQueryClient({ retry: false })
  client.setQueryData(['me'], { user: { id: 'conta-a' } })
  client.setQueryData(['recordings', 'semana'], ['da conta A'])
  client.setQueryData(['admin', 'me'], { email: 'admin@exemplo.org' })
  return client
}

afterEach(() => window.sessionStorage.clear())

describe('account scope', () => {
  it('a new account clears the user cache and the tab drafts, but neither the admin nor the session', () => {
    window.sessionStorage.setItem('eclume-conta', 'conta-a')
    window.sessionStorage.setItem(DRAFT, '{"base_version":2,"content_md":"# A"}')
    window.sessionStorage.setItem('eclume-recarga-chunk', '1')
    const client = seeded()
    enterAccount(client, 'conta-b', ['me'])
    expect(client.getQueryData(['recordings', 'semana'])).toBeUndefined()
    expect(client.getQueryData(['me'])).toBeDefined()
    expect(client.getQueryData(['admin', 'me'])).toBeDefined()
    expect(window.sessionStorage.getItem(DRAFT)).toBeNull()
    expect(window.sessionStorage.getItem('eclume-recarga-chunk')).toBe('1')
    expect(window.sessionStorage.getItem('eclume-conta')).toBe('conta-b')
  })

  it('the same account coming back keeps the drafts', () => {
    window.sessionStorage.setItem('eclume-conta', 'conta-a')
    window.sessionStorage.setItem(DRAFT, '{"base_version":2,"content_md":"# A"}')
    enterAccount(seeded(), 'conta-a', ['me'])
    expect(window.sessionStorage.getItem(DRAFT)).not.toBeNull()
  })

  it('a 401 clears the user queries and keeps the drafts', () => {
    window.sessionStorage.setItem(DRAFT, '{"base_version":2,"content_md":"# A"}')
    const client = seeded()
    clearUserQueries(client)
    expect(client.getQueryData(['recordings', 'semana'])).toBeUndefined()
    expect(client.getQueryData(['me'])).toBeUndefined()
    expect(client.getQueryData(['admin', 'me'])).toBeDefined()
    expect(window.sessionStorage.getItem(DRAFT)).not.toBeNull()
  })
})
