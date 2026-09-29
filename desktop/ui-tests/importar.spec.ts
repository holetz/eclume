import { test, expect, chamadas } from './fixtures'
import type { Page } from '@playwright/test'

type Mock = {
  estado: { importacao: Record<string, unknown> }
  emitir: (evento: string, payload?: unknown) => void
}

async function ajustar(page: Page, campos: Record<string, unknown>) {
  await page.evaluate((c) => {
    Object.assign((window as unknown as { __mock: Mock }).__mock.estado.importacao, c)
  }, campos)
}

async function pedido(page: Page) {
  return page.evaluate(() => (window as unknown as { __mock: Mock }).__mock.estado.importacao.pedido)
}

test('Importar arquivo… abre o seletor do sistema e a vista mostra nome, duração e data lida do arquivo', async ({ abrir }) => {
  const page = await abrir()
  await page.locator('#importar').click()
  await expect(page.locator('[data-vista="importar"]')).toBeVisible()
  expect((await chamadas(page)).map((c) => c.comando)).toContain('pick_import_file')
  await expect(page.locator('[data-vista="principal"]')).toBeHidden()
  await expect(page.locator('#importar-nome')).toHaveText('kickoff-guion.m4a · 47:12')
  await expect(page.locator('#importar-data')).toHaveValue('2026-09-19T14:02')
  await expect(page.locator('#importar-origem')).toHaveText('Gravado em · lida do arquivo. Mude se estiver errada.')

  await page.locator('#importar-confirmar').click()
  await expect(page.locator('[data-vista="principal"]')).toBeVisible()
  const feito = (await pedido(page)) as { path: string; recordedAt: number; recordedAtSource: string }
  expect(feito.path).toBe('/home/ana/kickoff-guion.m4a')
  expect(feito.recordedAtSource).toBe('file_metadata')
  expect(feito.recordedAt).toBe(new Date(2026, 8, 19, 14, 2).getTime())
})

test('arquivo arrastado abre a importação; data mudada vai como user', async ({ abrir }) => {
  const page = await abrir()
  await ajustar(page, { segurar: true })
  await page.evaluate(() => (window as unknown as { __mock: Mock }).__mock.emitir('import-dropped', '/home/ana/gravador.wav'))
  await expect(page.locator('[data-vista="importar"]')).toBeVisible()
  await expect(page.locator('#importar-nome')).toHaveText('gravador.wav · 1:30')
  await expect(page.locator('#importar-origem')).toHaveText('Gravado em · data de modificação do arquivo; confira.')

  await page.locator('#importar-data').fill('2026-09-20T08:15')
  await page.locator('#importar-confirmar').click()
  await expect(page.locator('#importar-andamento')).toBeVisible()
  await expect(page.locator('#importar-porcento')).toHaveText('50%')
  await expect(page.locator('#importar-confirmar')).toBeDisabled()
  const feito = (await pedido(page)) as { recordedAt: number; recordedAtSource: string }
  expect(feito.recordedAtSource).toBe('user')
  expect(feito.recordedAt).toBe(new Date(2026, 8, 20, 8, 15).getTime())

  await page.locator('#importar-cancelar').click()
  await expect(page.locator('[data-vista="principal"]')).toBeVisible()
  expect((await chamadas(page)).map((c) => c.comando)).toContain('cancel_import')
})

test('arquivo sem áudio e falha na conversão aparecem como erro', async ({ abrir }) => {
  const page = await abrir()
  await page.evaluate(() => (window as unknown as { __mock: Mock }).__mock.emitir('import-dropped', '/home/ana/tela.mp4'))
  await expect(page.locator('#importar-erro')).toContainText('tela.mp4 não tem áudio.')
  await expect(page.locator('#importar-arquivo')).toBeHidden()

  await ajustar(page, { falha: 'disco cheio' })
  await page.locator('#importar-escolher').click()
  await expect(page.locator('#importar-erro')).toBeHidden()
  await page.locator('#importar-confirmar').click()
  await expect(page.locator('#importar-erro')).toContainText('disco cheio')
  await expect(page.locator('#importar-confirmar')).toBeEnabled()
  await expect(page.locator('#importar-andamento')).toBeHidden()
})

test('desistir no seletor do sistema fica na janela principal', async ({ abrir }) => {
  const page = await abrir()
  await ajustar(page, { escolhido: null })
  await page.locator('#importar').click()
  await expect.poll(async () => (await chamadas(page)).map((c) => c.comando)).toContain('pick_import_file')
  await expect(page.locator('[data-vista="principal"]')).toBeVisible()
  await expect(page.locator('[data-vista="importar"]')).toBeHidden()
})

test('Ctrl+O abre a importação e Esc volta', async ({ abrir }) => {
  const page = await abrir()
  await page.keyboard.press('Control+o')
  await expect(page.locator('[data-vista="importar"]')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-vista="principal"]')).toBeVisible()
  await page.locator('#importar').click()
  await page.locator('#importar-fechar').click()
  await expect(page.locator('[data-vista="principal"]')).toBeVisible()
})
