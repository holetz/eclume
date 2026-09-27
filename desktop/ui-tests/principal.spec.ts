import { test, expect } from './fixtures'

test('a vista principal carrega com as fontes do app e sem requisição externa', async ({ abrir, externas }) => {
  const page = await abrir()
  await expect(page.locator('[data-vista="principal"]')).toBeVisible()
  await expect(page.locator('.brand')).toHaveText('eclume')
  await expect(page.locator('#abrir-configuracoes svg')).toBeVisible()
  await expect(page.locator('#linha-status')).not.toHaveText('Carregando…')

  const familias = await page.evaluate(async () => {
    await document.fonts.ready
    return [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replaceAll('"', ''))
  })
  expect(familias).toContain('Archivo')
  expect(externas).toEqual([])
})

test('o tema acompanha o sistema', async ({ abrir }) => {
  const page = await abrir()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  const fundo = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  expect(fundo).toBe('rgb(30, 28, 25)')
})
