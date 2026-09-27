import { test, expect, chamadas } from './fixtures'

test('sem conta, abre na primeira execução com o servidor do instalador e entra por senha', async ({ abrir }) => {
  const page = await abrir('primeiraExecucao')
  const vista = page.locator('[data-vista="primeira-execucao"]')
  await expect(vista).toBeVisible()
  await expect(page.locator('[data-vista="principal"]')).toBeHidden()
  await expect(vista.locator('h4')).toHaveText('Bem-vindo')

  const opcoes = page.locator('#bv-servidores .choice')
  await expect(opcoes).toHaveCount(2)
  await expect(opcoes.first().locator('strong')).toHaveText('eclume em 192.168.15.199')
  await expect(opcoes.first().locator('small')).toHaveText('Veio com este instalador · Usar outro')
  await expect(opcoes.nth(1).locator('strong')).toHaveText('Escritório em 10.0.0.2')
  await expect(opcoes.nth(1).locator('small')).toContainText('Encontrado na rede')
  await expect(opcoes.first().locator('input')).toBeChecked()
  // A CA do instalador vem com a impressão digital: nada a conferir.
  await expect(page.locator('#bv-confianca')).toBeHidden()
  await expect(page.locator('#bv-entrar')).toBeEnabled()

  await page.locator('#bv-email').fill('ana@exemplo.com.br')
  await page.locator('#bv-senha').fill('errada')
  await page.locator('#bv-entrar').click()
  await expect(page.locator('#bv-aviso')).toHaveText('E-mail ou senha incorretos')

  await page.locator('#bv-senha').fill('segredo')
  await page.locator('#bv-entrar').click()
  await expect(page.locator('[data-vista="principal"]')).toBeVisible()
  await expect(page.locator('#conta-nome')).toHaveText('ana@exemplo.com.br')
  await expect(page.locator('#conta-acao')).toHaveText('Sair')

  const feitas = await chamadas(page)
  expect(feitas).toContainEqual({
    comando: 'prepare_server',
    args: {
      url: 'https://192.168.15.199:8443',
      caSha256: '98e209f5457514b7b12ec349d22b3b0d93c03c3f10e52350ea5f9e0b3d97792f',
    },
  })
  expect(feitas).toContainEqual({ comando: 'sign_in', args: { email: 'ana@exemplo.com.br', password: 'segredo' } })
})

test('servidor achado sem impressão digital pede para conferir antes de entrar', async ({ abrir }) => {
  const page = await abrir('primeiraExecucao')
  await page.locator('#bv-servidores .choice').nth(1).click()
  const confianca = page.locator('#bv-confianca')
  await expect(confianca).toBeVisible()
  await expect(page.locator('#bv-impressao')).toHaveText(/^3F:9A:1C:6E:0B:7D:.*:7B:9D$/)
  await expect(page.locator('#bv-entrar')).toBeDisabled()
  await expect(page.locator('#bv-parear')).toBeDisabled()
  await page.locator('#bv-confiar').click()
  await expect(confianca).toBeHidden()
  await expect(page.locator('#bv-entrar')).toBeEnabled()
})

test('Avançado: endereço digitado e código de pareamento', async ({ abrir }) => {
  const page = await abrir('semServidor')
  await expect(page.locator('#bv-procurando')).toHaveText('Nenhum servidor na rede. Digite o endereço em Avançado.')
  await expect(page.locator('#bv-avancado')).toHaveAttribute('open', '')
  await expect(page.locator('#bv-entrar')).toBeDisabled()

  await page.locator('#bv-endereco').fill('eclume local')
  await page.locator('#bv-usar-endereco').click()
  await expect(page.locator('#bv-aviso')).toContainText('Endereço inválido')

  // Só o host vale: o https:// entra sozinho.
  await page.locator('#bv-endereco').fill('eclume.local:8443/')
  await page.locator('#bv-usar-endereco').click()
  const digitado = page.locator('#bv-servidores .choice')
  await expect(digitado).toHaveCount(1)
  await expect(digitado.locator('small')).toContainText('Endereço digitado')
  await page.locator('#bv-confiar').click()

  await page.locator('#bv-parear').click()
  await expect(page.locator('#bv-aviso')).toContainText('código de 6 caracteres')
  await page.locator('#bv-codigo').fill('AAA-AAA')
  await page.locator('#bv-parear').click()
  await expect(page.locator('#bv-aviso')).toHaveText('Código inválido ou vencido')
  await page.locator('#bv-codigo').fill('k7q-4mx')
  await page.locator('#bv-parear').click()
  await expect(page.locator('[data-vista="principal"]')).toBeVisible()
  await expect(page.locator('#conta-servidor')).toHaveText('eclume em eclume.local')

  const feitas = await chamadas(page)
  expect(feitas).toContainEqual({ comando: 'prepare_server', args: { url: 'https://eclume.local:8443', caSha256: null } })
  expect(feitas).toContainEqual({ comando: 'pair', args: { code: 'k7q-4mx' } })
})

test('"Crie uma na web" abre o cadastro do servidor escolhido', async ({ abrir }) => {
  const page = await abrir('primeiraExecucao')
  await expect(page.locator('#bv-entrar')).toBeEnabled()
  await page.locator('#bv-cadastro').click()
  await expect
    .poll(async () => (await chamadas(page)).find((c) => c.comando === 'open_signup')?.args)
    .toEqual({ url: 'https://192.168.15.199:8443' })
})

test('CA trocada: volta à primeira execução com o aviso e sem as teclas da janela', async ({ abrir }) => {
  const page = await abrir('caMudou')
  await expect(page.locator('[data-vista="primeira-execucao"]')).toBeVisible()
  await expect(page.locator('#bv-aviso')).toHaveText('O certificado do servidor mudou')
  await page.keyboard.press('Control+,')
  await expect(page.locator('[data-vista="configuracoes"]')).toBeHidden()
  await expect(page.locator('#bv-voltar')).toBeHidden()
})
