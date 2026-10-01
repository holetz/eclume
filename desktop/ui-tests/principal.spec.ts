import { test, expect, chamadas } from './fixtures'

test('a vista principal carrega com as fontes do app e sem requisição externa', async ({ abrir, externas }) => {
  const page = await abrir()
  await expect(page.locator('[data-vista="principal"]')).toBeVisible()
  await expect(page.locator('[data-vista="principal"] .brand')).toHaveText('eclume')
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

test('ocioso: status, gravar, fila e conta', async ({ abrir }) => {
  const page = await abrir()
  await expect(page.locator('#linha-status')).toHaveText('Ocioso, atento a reuniões')
  await expect(page.locator('#gravar')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('#gravar')).toHaveText('Iniciar gravação')
  await expect(page.locator('#pergunta')).toBeHidden()
  await expect(page.locator('#fila li')).toHaveCount(3)
  await expect(page.locator('#fila li').first()).toContainText('Hoje, 09:00 · 54 min')
  await expect(page.locator('#fila li').first().locator('.badge')).toHaveText('Enviada')
  await expect(page.locator('#fila-resumo')).toHaveText('3 de 3 enviadas')
  await expect(page.locator('#conta-nome')).toHaveText('ana@exemplo.com.br')
  await expect(page.locator('#conta-servidor')).toHaveText('eclume em 192.168.15.199')
  await expect(page.locator('#conta-versao')).toHaveText('v0.2.0')
  await expect(page.locator('#conta-acao')).toHaveText('Sair')
})

test('gravar alterna o botão e a linha de status', async ({ abrir }) => {
  const page = await abrir()
  await page.locator('#gravar').click()
  await expect(page.locator('#gravar')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('#gravar')).toHaveText('Parar gravação')
  await expect(page.locator('#linha-status')).toHaveAttribute('data-status', 'recording')
  await expect(page.locator('#linha-status')).toHaveText(/^Gravando · 0:0\d$/)
})

test('gravação automática mostra o app e o tempo', async ({ abrir }) => {
  const page = await abrir('gravando')
  await expect(page.locator('#linha-status')).toHaveText(/^Gravando Microsoft Teams · 12:0\d$/)
  await expect(page.locator('#fila li').first().locator('.badge')).toHaveText('Gravando')
})

test('pergunta de reunião com Gravar e Agora não', async ({ abrir }) => {
  const page = await abrir('pergunta')
  await expect(page.locator('#pergunta')).toBeVisible()
  await expect(page.locator('#pergunta .alert-warning')).toContainText('Zoom está usando o microfone. Gravar?')
  await page.locator('#pergunta-agora-nao').click()
  await expect(page.locator('#pergunta')).toBeHidden()
  const feitas = await chamadas(page)
  expect(feitas).toContainEqual({ comando: 'answer_meeting', args: { record: false } })
})

test('fila com as etiquetas do vocabulário, nota, importação e o erro visível', async ({ abrir }) => {
  const page = await abrir('fila')
  const linhas = page.locator('#fila li')
  await expect(linhas.locator('.badge')).toHaveText(['Enviando', 'Enviada', 'Falhou o envio', 'Aguardando envio'])
  await expect(linhas.nth(1)).toContainText('Hoje, 08:18 · Nota · 1 min')
  await expect(linhas.nth(2).locator('.badge')).toHaveClass(/badge-danger/)
  await expect(linhas.nth(2).locator('.fila-erro')).toBeVisible()
  await expect(linhas.nth(2).locator('.fila-erro')).toHaveText('HTTP 413: arquivo grande demais')
  await expect(linhas.nth(3)).toContainText('kickoff-guion · 47 min')
  await expect(page.locator('#fila-resumo')).toHaveText('1 de 4 enviadas')
})

test('enviada com a transcrição na fila do servidor diz por que espera', async ({ abrir }) => {
  const page = await abrir('espera')
  const linhas = page.locator('#fila li')
  await expect(linhas.nth(0).locator('.fila-espera')).toHaveText('Atrás de 2 gravações suas que chegaram antes.')
  await expect(linhas.nth(1).locator('.fila-espera')).toHaveText(
    'O processador está fora do ar; sua gravação está guardada e entra quando ele voltar.',
  )
  await expect(linhas.nth(2).locator('.fila-espera')).toHaveCount(0)
})

test('fila vazia com o aviso do envio', async ({ abrir }) => {
  const page = await abrir('vazio')
  await expect(page.locator('#linha-status')).toHaveText('Tudo enviado')
  await expect(page.locator('#fila-vazia')).toBeVisible()
  await expect(page.locator('#aviso')).toContainText('o servidor respondeu 503')
})

test('"Sair" na conta apaga a credencial e volta à primeira execução', async ({ abrir }) => {
  const page = await abrir()
  await page.locator('#conta-acao').click()
  await expect(page.locator('[data-vista="primeira-execucao"]')).toBeVisible()
  expect((await chamadas(page)).map((c) => c.comando)).toContain('sign_out')
})

test('erro de um comando aparece e some no próximo que dá certo', async ({ abrir }) => {
  const page = await abrir('gravando')
  await page.locator('#nova-nota').click()
  await expect(page.locator('#aviso.alert-error')).toContainText('Já há uma gravação em andamento')
  await page.locator('#gravar').click()
  await expect(page.locator('#aviso')).toBeHidden()
})

test('depois de uma atualização: "Atualizado para X" com as notas até fechar', async ({ abrir }) => {
  const page = await abrir('atualizado')
  const aviso = page.locator('#atualizado')
  await expect(aviso).toBeVisible()
  await expect(aviso).toHaveClass(/alert-success/)
  await expect(page.locator('#atualizado-titulo')).toHaveText('Atualizado para 0.2.0')
  await expect(page.locator('#atualizado-notas')).toHaveText('Nova nota, Importar arquivo e entrar com e-mail e senha')
  await page.locator('#atualizado-fechar').click()
  await expect(aviso).toBeHidden()
  expect((await chamadas(page)).map((c) => c.comando)).toContain('dismiss_update_notice')
})

test('sem atualização, nada de aviso', async ({ abrir }) => {
  const page = await abrir()
  await expect(page.locator('#linha-status')).not.toHaveText('Carregando…')
  await expect(page.locator('#atualizado')).toBeHidden()
})
