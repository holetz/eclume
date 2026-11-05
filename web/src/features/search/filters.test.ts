import { describe, expect, it } from 'vitest'
import { setLocale } from '../../i18n'
import { fixtures } from '../../test/fixtures'
import { apiQuery, filtersFromParams, isSearchable, paramsFromFilters, periodStart } from './filters'
import { groupHits, totalLabel } from './group'
import { parseHighlight } from './highlight'

describe('highlight', () => {
  it('splits the marked terms and undoes the escaping without accepting other HTML', () => {
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

describe('filters', () => {
  it('go to and come back from the pt-BR URL and become the API query', () => {
    const filters = filtersFromParams(
      new URLSearchParams('q=turmas&pessoa=p1&de=2026-09-01&ate=2026-09-18&tag=a&campo=f1:Serra&campo=sem'),
    )
    expect(filters).toEqual({
      q: 'turmas',
      person: 'p1',
      period: '',
      from: '2026-09-01',
      to: '2026-09-18',
      tag: 'a',
      collection: '',
      field: ['f1:Serra'],
    })
    expect(paramsFromFilters(filters).toString()).toBe(
      'q=turmas&pessoa=p1&de=2026-09-01&ate=2026-09-18&tag=a&campo=f1%3ASerra',
    )
    const query = apiQuery(filters)
    expect(query.from).toBe(new Date(2026, 8, 1).toISOString())
    expect(query.to).toBe(new Date(2026, 8, 19).toISOString())
    expect(query).toMatchObject({ q: 'turmas', person: 'p1', tag: 'a', field: ['f1:Serra'] })
    expect(query).not.toHaveProperty('collection')
    expect(isSearchable(filtersFromParams(new URLSearchParams('tag=a')))).toBe(false)
    expect(isSearchable(filtersFromParams(new URLSearchParams('pessoa=p1')))).toBe(true)
  })

  it('the quick period becomes only `from`, at local midnight', () => {
    const now = new Date(2026, 8, 26, 15, 30)
    expect(periodStart('7d', now)).toBe(new Date(2026, 8, 20).toISOString())
    expect(periodStart('30d', now)).toBe(new Date(2026, 7, 28).toISOString())
    expect(periodStart('ano', now)).toBe(new Date(2026, 0, 1).toISOString())
    const query = apiQuery(filtersFromParams(new URLSearchParams('q=a&periodo=30d&de=2026-01-01&ate=2026-02-01')), now)
    expect(query.from).toBe(new Date(2026, 7, 28).toISOString())
    expect(query).not.toHaveProperty('to')
    expect(filtersFromParams(new URLSearchParams('periodo=semestre')).period).toBe('')
  })
})

describe('search groups', () => {
  it('joins only the consecutive hits of the same recording and counts excerpts and recordings', () => {
    const [a, b] = fixtures.searchPage().items
    const other = { ...a, transcript: { ...a.transcript, id: 't2', recording_id: 'r2', title: 'Outra' } }
    const groups = groupHits([a, b, other, a])
    expect(groups.map((group) => [group.transcript.title, group.hits.length])).toEqual([
      [a.transcript.title, 2],
      ['Outra', 1],
      [a.transcript.title, 1],
    ])
    expect(totalLabel([a, b, other, a], false)).toBe('4 trechos em 2 gravações')
    expect(totalLabel([a], true)).toBe('1 trecho em 1 gravação ou mais')
  })

  it('counts in English from the search catalog', async () => {
    const [a, b] = fixtures.searchPage().items
    await setLocale('en')
    try {
      expect(totalLabel([a, b], false)).toBe('2 passages in 1 recording')
      expect(totalLabel([a], true)).toBe('1 passage in 1 recording or more')
    } finally {
      await setLocale('pt-BR')
    }
  })
})
