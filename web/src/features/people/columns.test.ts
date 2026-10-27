import { afterEach, describe, expect, it } from 'vitest'
import { STORAGE_KEYS } from '../../app/storage'
import { DEFAULT_PERSON_COLUMNS, readPersonColumns, savePersonColumns } from './columns'

afterEach(() => window.localStorage.clear())

describe('People columns', () => {
  it('starts at the default, without the e-mail', () => {
    expect(readPersonColumns()).toEqual(DEFAULT_PERSON_COLUMNS)
    expect(readPersonColumns()).not.toContain('email')
  })

  it('stores the choice in table order and deletes the key on returning to the default', () => {
    savePersonColumns(['email', 'company'])
    expect(window.localStorage.getItem(STORAGE_KEYS.peopleColumns)).toBe('company,email')
    expect(readPersonColumns()).toEqual(['company', 'email'])
    savePersonColumns([...DEFAULT_PERSON_COLUMNS])
    expect(window.localStorage.getItem(STORAGE_KEYS.peopleColumns)).toBeNull()
  })

  it('accepts only the name and ignores a meaningless stored value', () => {
    savePersonColumns([])
    expect(readPersonColumns()).toEqual([])
    window.localStorage.setItem(STORAGE_KEYS.peopleColumns, 'lixo,outro')
    expect(readPersonColumns()).toEqual(DEFAULT_PERSON_COLUMNS)
  })
})
