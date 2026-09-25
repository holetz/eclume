import { describe, expect, it } from 'vitest'
import { apiQuery, filtersFromParams, isSearchable, paramsFromFilters } from './filters'
import { parseHighlight } from './highlight'

describe('destaque', () => {
  it('separa os termos marcados e desfaz o escape sem aceitar outro HTML', () => {
    expect(parseHighlight('Três <mark>turmas</mark> de 12')).toEqual([
      { text: 'Três ', marked: false },
      { text: 'turmas', marked: true },
      { text: ' de 12', marked: false },
    ])
    expect(parseHighlight('&lt;b&gt;<mark>a &amp; b</mark>&lt;/b&gt;')).toEqual([
      { text: '<b>', marked: false },
      { text: 'a & b', marked: true },
      { text: '</b>', marked: false },
    ])
    expect(parseHighlight('sem termo')).toEqual([{ text: 'sem termo', marked: false }])
  })
})

describe('filtros', () => {
  it('vão e voltam da URL em pt-BR e viram a consulta da API', () => {
    const filters = filtersFromParams(new URLSearchParams('q=turmas&pessoa=p1&de=2026-09-01&ate=2026-09-18&tag=a'))
    expect(filters).toEqual({ q: 'turmas', person: 'p1', from: '2026-09-01', to: '2026-09-18', tag: 'a', collection: '' })
    expect(paramsFromFilters(filters)).toEqual({ q: 'turmas', pessoa: 'p1', de: '2026-09-01', ate: '2026-09-18', tag: 'a' })
    const query = apiQuery(filters)
    expect(query.from).toBe(new Date(2026, 8, 1).toISOString())
    expect(query.to).toBe(new Date(2026, 8, 19).toISOString())
    expect(query).toMatchObject({ q: 'turmas', person: 'p1', tag: 'a' })
    expect(query).not.toHaveProperty('collection')
    expect(isSearchable(filtersFromParams(new URLSearchParams('tag=a')))).toBe(false)
    expect(isSearchable(filtersFromParams(new URLSearchParams('pessoa=p1')))).toBe(true)
  })
})
