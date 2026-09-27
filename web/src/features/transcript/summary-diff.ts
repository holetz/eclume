// Comparação de duas versões do resumo por linha (LCS), no cliente: a gerada contra a atual, ou o
// rascunho contra a versão que mudou enquanto a pessoa editava.

export interface DiffLine {
  kind: 'same' | 'removed' | 'added'
  text: string
}

function lines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
}

/** As linhas de `before` e `after` alinhadas pela maior subsequência comum: iguais, removidas e incluídas. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = lines(before)
  const b = lines(after)
  // lengths[i][j] = LCS de a[i..] e b[j..].
  const lengths = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i][j] = a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1])
    }
  }
  const result: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      result.push({ kind: 'same', text: a[i] })
      i++
      j++
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      result.push({ kind: 'removed', text: a[i++] })
    } else {
      result.push({ kind: 'added', text: b[j++] })
    }
  }
  while (i < a.length) result.push({ kind: 'removed', text: a[i++] })
  while (j < b.length) result.push({ kind: 'added', text: b[j++] })
  return result
}
