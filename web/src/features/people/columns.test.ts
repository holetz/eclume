import { afterEach, describe, expect, it } from 'vitest'
import { STORAGE_KEYS } from '../../app/storage'
import { DEFAULT_PERSON_COLUMNS, readPersonColumns, savePersonColumns } from './columns'

afterEach(() => window.localStorage.clear())

describe('colunas de Pessoas', () => {
  it('começa no padrão, sem o e-mail', () => {
    expect(readPersonColumns()).toEqual(DEFAULT_PERSON_COLUMNS)
    expect(readPersonColumns()).not.toContain('email')
  })

  it('guarda a escolha na ordem da tabela e apaga a chave ao voltar ao padrão', () => {
    savePersonColumns(['email', 'company'])
    expect(window.localStorage.getItem(STORAGE_KEYS.peopleColumns)).toBe('company,email')
    expect(readPersonColumns()).toEqual(['company', 'email'])
    savePersonColumns([...DEFAULT_PERSON_COLUMNS])
    expect(window.localStorage.getItem(STORAGE_KEYS.peopleColumns)).toBeNull()
  })

  it('aceita só o nome e ignora valor guardado sem sentido', () => {
    savePersonColumns([])
    expect(readPersonColumns()).toEqual([])
    window.localStorage.setItem(STORAGE_KEYS.peopleColumns, 'lixo,outro')
    expect(readPersonColumns()).toEqual(DEFAULT_PERSON_COLUMNS)
  })
})
