import { describe, expect, it } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { diffLines } from './summary-diff'

describe('summary line diff', () => {
  it('marks the equal, removed and added lines, in order', () => {
    expect(diffLines('a\nb\nc\n', 'a\nx\nc\nd')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'x' },
      { kind: 'same', text: 'c' },
      { kind: 'added', text: 'd' },
    ])
  })

  it('equal ones have no difference; empty against text is all added', () => {
    expect(diffLines('a\r\nb', 'a\nb').every((line) => line.kind === 'same')).toBe(true)
    expect(diffLines('', 'um\ndois').filter((line) => line.kind === 'added')).toHaveLength(2)
  })

  it('the fixture hand edit changes one line of the generated one', () => {
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
