import { describe, expect, it } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { diffLines } from './summary-diff'

describe('diff de linhas do resumo', () => {
  it('marca as linhas iguais, removidas e incluídas, na ordem', () => {
    expect(diffLines('a\nb\nc\n', 'a\nx\nc\nd')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'x' },
      { kind: 'same', text: 'c' },
      { kind: 'added', text: 'd' },
    ])
  })

  it('iguais não têm diferença; vazio contra texto é tudo incluído', () => {
    expect(diffLines('a\r\nb', 'a\nb').every((line) => line.kind === 'same')).toBe(true)
    expect(diffLines('', 'um\ndois').filter((line) => line.kind === 'added')).toHaveLength(2)
  })

  it('a edição à mão da fixture muda uma linha da gerada', () => {
    const { current, generated } = fixtures.summaryState()
    const diff = diffLines(generated!.content_md!, current!.content_md!)
    expect(diff.filter((line) => line.kind === 'removed')).toEqual([
      { kind: 'removed', text: '- Três turmas de 12 gestores; a primeira, em outubro, com as lideranças da produção.' },
    ])
    expect(diff.filter((line) => line.kind === 'added')).toEqual([
      {
        kind: 'added',
        text: '- Três turmas de 12 gestores cada; a primeira, em outubro, com as lideranças da produção.',
      },
    ])
  })
})
