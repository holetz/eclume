import { test, expect, chamadas } from './fixtures'

test('o ícone de ajuda abre o menu do DS com a versão', async ({ abrir }) => {
  const page = await abrir()
  await expect(page.locator('#menu-ajuda')).toBeHidden()
  await page.locator('#abrir-ajuda').click()
  await expect(page.locator('#menu-ajuda')).toBeVisible()
  await expect(page.locator('#abrir-ajuda')).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('#menu-ajuda [role=menuitem]')).toHaveText([
    'Primeiros passos',
    'Permissões de microfone',
    'Pasta sincronizada',
    /Atalhos de teclado\s*Ctrl\+\//,
    /Abrir a central de ajuda\s*↗/,
    /Relatar um problema…\s*Anexe o eclume\.log/,
  ])
  await expect(page.locator('#ajuda-versao')).toHaveText('eclume 0.2.0 · atualizado')
  await expect(page.locator('#ajuda-versao')).toHaveAttribute('aria-disabled', 'true')

  await page.keyboard.press('Escape')
  await expect(page.locator('#menu-ajuda')).toBeHidden()
  await page.locator('#abrir-ajuda').click()
  await page.locator('[data-vista="principal"] .brand').click()
  await expect(page.locator('#menu-ajuda')).toBeHidden()
})

test('os itens abrem a ajuda do servidor e a pasta de logs', async ({ abrir }) => {
  const page = await abrir()
  for (const id of ['#ajuda-primeiros-passos', '#ajuda-permissoes', '#ajuda-pasta', '#ajuda-central', '#ajuda-problema']) {
    await page.locator('#abrir-ajuda').click()
    await page.locator(id).click()
    await expect(page.locator('#menu-ajuda')).toBeHidden()
  }
  const feitas = (await chamadas(page)).filter((c) => c.comando === 'open_help' || c.comando === 'open_log_dir')
  expect(feitas).toEqual([
    { comando: 'open_help', args: { article: 'primeiros-passos' } },
    { comando: 'open_help', args: { article: 'permissoes-de-microfone' } },
    { comando: 'open_help', args: { article: 'pasta-sincronizada' } },
    { comando: 'open_help', args: { article: null } },
    { comando: 'open_log_dir', args: null },
  ])
})

test('Atalhos de teclado pelo menu e por Ctrl+/: globais da config e os da janela', async ({ abrir }) => {
  const page = await abrir()
  await page.locator('#abrir-ajuda').click()
  await page.locator('#ajuda-atalhos').click()
  const folha = page.locator('[data-vista="atalhos"]')
  await expect(folha).toBeVisible()
  await expect(folha.locator('#atalhos-globais dt')).toHaveText(['Iniciar ou parar a gravação', 'Nova nota', 'Adicionar marcador'])
  await expect(folha.locator('#atalhos-globais > div').nth(1).locator('.kbd')).toHaveText(['Ctrl', 'Alt', 'N'])
  await expect(folha.locator('#atalhos-janela dt')).toHaveText(['Importar arquivo', 'Configurações', 'Atalhos de teclado'])
  await expect(folha.locator('#atalhos-janela > div').nth(1).locator('.kbd')).toHaveText(['Ctrl', ','])

  await page.locator('#atalhos-fechar').click()
  await expect(page.locator('[data-vista="principal"]')).toBeVisible()
  await page.keyboard.press('Control+/')
  await expect(folha).toBeVisible()
  await page.locator('#atalhos-mudar').click()
  await expect(page.locator('[data-painel="audio"]')).toBeVisible()
})

test('Ctrl+, abre as configurações e Ctrl+O a importação, de qualquer vista', async ({ abrir }) => {
  const page = await abrir()
  await page.keyboard.press('Control+/')
  await page.keyboard.press('Control+,')
  await expect(page.locator('[data-vista="configuracoes"]')).toBeVisible()
  await page.keyboard.press('Control+o')
  await expect(page.locator('[data-vista="importar"]')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-vista="principal"]')).toBeVisible()
})
