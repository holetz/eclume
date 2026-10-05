import { test, expect, chamadas } from './fixtures'
import type { Page } from '@playwright/test'

type EstadoDoMock = {
  areaDeTransferencia: string | null
  gravacaoAberta: string | null
  resumos: Record<string, string>
  ultimaEntrada: Record<string, unknown>
}

async function estado(page: Page): Promise<EstadoDoMock> {
  return page.evaluate(() => (window as unknown as { __mock: { estado: EstadoDoMock } }).__mock.estado)
}

const linha = (page: Page, chave: string) => page.locator(`#recentes-lista li[data-key="${chave}"]`)

async function quantidade(page: Page, valor: string) {
  await page.locator('#abrir-configuracoes').click()
  await page.locator('#recentes-quantidade').selectOption(valor)
  await expect.poll(async () => (await estado(page)).ultimaEntrada?.recent_count).toBe(Number(valor))
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-vista="principal"]')).toBeVisible()
}

test('o painel Recentes fica no topo com as 5 últimas, o estado, o progresso e os alertas', async ({ abrir }) => {
  const page = await abrir('recentes')
  const painel = page.locator('#recentes')
  await expect(painel).toBeVisible()
  await expect(painel.locator('.kicker')).toHaveText('Recentes')
  // No topo: antes da linha de status e do Gravar.
  const antes = await page.evaluate(() => {
    const recentes = document.querySelector('#recentes')!
    const status = document.querySelector('#linha-status')!
    return Boolean(recentes.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING)
  })
  expect(antes).toBe(true)

  await expect(page.locator('#recentes-lista li')).toHaveCount(5)
  await expect(page.locator('#recentes-alerta')).toHaveText('2 precisam de você')

  // Sem título: a data curta.
  await expect(linha(page, 'local:g1').locator('.recente-titulo')).toHaveText(/^\d{2}\/\d{2} 10:05$/)
  await expect(linha(page, 'local:g1').locator('.badge')).toHaveText('Gravando')

  const falhou = linha(page, 'local:f1')
  await expect(falhou.locator('.badge')).toHaveText('Falhou o envio')
  await expect(falhou.locator('.recente-detalhe')).toHaveText('HTTP 413: arquivo grande demais')
  await expect(falhou.getByRole('button', { name: 'Tentar agora' })).toBeVisible()

  const transcrevendo = linha(page, 'srv-t')
  await expect(transcrevendo.locator('.badge')).toHaveText('Transcrevendo')
  await expect(transcrevendo.locator('progress')).toHaveJSProperty('value', 42)
  await expect(transcrevendo.locator('.recente-progresso')).toContainText('42%')

  await expect(linha(page, 'srv-r').locator('.badge')).toHaveText('Resumo pronto')
  await expect(linha(page, 'srv-r').getByRole('button', { name: 'Copiar resumo' })).toBeVisible()
  await expect(linha(page, 'srv-r').locator('svg')).toHaveCount(1)
})

test('estado desconhecido, como aguardando locutores, vira "Precisa de você" com o link para o web', async ({ abrir }) => {
  const page = await abrir('recentes')
  const desconhecido = linha(page, 'srv-l')
  await expect(desconhecido).toHaveClass(/recente-alerta/)
  await expect(desconhecido.locator('.badge')).toHaveText('Precisa de você')
  await expect(desconhecido.locator('.badge')).toHaveClass(/badge-warning/)
  await expect(desconhecido.locator('.recente-detalhe')).toContainText('awaiting_speakers')
  await expect(desconhecido.locator('.recente-detalhe')).toContainText('resolva no web')
  await desconhecido.getByRole('button', { name: 'Abrir no web' }).click()
  await expect.poll(async () => (await estado(page)).gravacaoAberta).toBe('srv-l')
  expect(await chamadas(page)).toContainEqual({ comando: 'open_recording', args: { recordingId: 'srv-l' } })
})

test('Copiar resumo põe o Markdown na área de transferência pelo Tauri e confirma na linha', async ({ abrir }) => {
  const page = await abrir('recentes')
  const pronto = linha(page, 'srv-r')
  await pronto.getByRole('button', { name: 'Copiar resumo' }).click()
  await expect(pronto.getByRole('button', { name: 'Copiado' })).toBeVisible()
  await expect(pronto.getByRole('status')).toHaveText('Resumo copiado em Markdown.')
  expect(await chamadas(page)).toContainEqual({ comando: 'copy_summary', args: { recordingId: 'srv-r' } })
  expect((await estado(page)).areaDeTransferencia).toBe('# Comitê de crédito\n\n- Aprovado o limite da cooperativa')
  // O retorno some depois de alguns segundos.
  await expect(pronto.getByRole('button', { name: 'Copiar resumo' })).toBeVisible({ timeout: 5_000 })
})

test('Copiar resumo que falha mostra o erro na linha e não copia nada', async ({ abrir }) => {
  const page = await abrir('recentes')
  await page.evaluate(() => {
    ;(window as unknown as { __mock: { estado: EstadoDoMock } }).__mock.estado.resumos = {}
  })
  const pronto = linha(page, 'srv-r')
  await pronto.getByRole('button', { name: 'Copiar resumo' }).click()
  await expect(pronto.locator('.recente-detalhe')).toHaveText('O resumo ainda não está pronto')
  await expect(pronto.getByRole('button', { name: 'Copiar resumo' })).toBeVisible()
  expect((await estado(page)).areaDeTransferencia).toBeNull()
})

test('Tentar agora pede o envio de novo', async ({ abrir }) => {
  const page = await abrir('recentes')
  await linha(page, 'local:f1').getByRole('button', { name: 'Tentar agora' }).click()
  await expect.poll(async () => (await chamadas(page)).some((c) => c.comando === 'sync_now')).toBe(true)
})

test('a quantidade vem da configuração, e Ocultar some com o painel', async ({ abrir }) => {
  const page = await abrir('recentes')
  await quantidade(page, '10')
  await expect(page.locator('#recentes-lista li')).toHaveCount(7)
  await expect(page.locator('#recentes-alerta')).toHaveText('3 precisam de você')
  await expect(linha(page, 'srv-s').locator('.badge')).toHaveText('O resumo falhou')
  await expect(linha(page, 'srv-q').locator('.badge')).toHaveText('Na fila')
  await expect(linha(page, 'srv-q').locator('.recente-detalhe')).toHaveText('2ª na fila')

  await quantidade(page, '3')
  await expect(page.locator('#recentes-lista li')).toHaveCount(3)
  await expect(page.locator('#recentes-alerta')).toHaveText('1 precisa de você')

  await quantidade(page, '0')
  await expect(page.locator('#recentes')).toBeHidden()
})

test('sem gravações, o painel diz que não há nenhuma e não mostra alerta', async ({ abrir }) => {
  const page = await abrir()
  await expect(page.locator('#recentes')).toBeVisible()
  await expect(page.locator('#recentes-lista li')).toHaveCount(0)
  await expect(page.locator('#recentes-vazio')).toHaveText('Nenhuma gravação ainda.')
  await expect(page.locator('#recentes-alerta')).toBeHidden()
})

test('a principal pede uma leitura das recentes ao abrir', async ({ abrir }) => {
  const page = await abrir('recentes')
  await expect.poll(async () => (await chamadas(page)).some((c) => c.comando === 'recent_refresh')).toBe(true)
})

for (const [largura, altura] of [
  [520, 600],
  [380, 420],
]) {
  test(`o painel cabe em ${largura} × ${altura} sem rolagem horizontal`, async ({ abrir }) => {
    const page = await abrir('recentes')
    await page.setViewportSize({ width: largura, height: altura })
    await expect(page.locator('#recentes-lista li')).toHaveCount(5)
    const transborda = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
    expect(transborda).toBe(false)
    const titulo = linha(page, 'srv-l').locator('.recente-titulo')
    await expect(titulo).toHaveCSS('text-overflow', 'ellipsis')
  })
}
