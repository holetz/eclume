import { test, expect, calls } from './fixtures'

test("without an account, first run uses the installer server and signs in by password", async ({ open }) => {
  const page = await open('firstRun')
  const view = page.locator('[data-view="first-run"]')
  await expect(view).toBeVisible()
  await expect(page.locator('[data-view="home"]')).toBeHidden()
  await expect(view.locator('h4')).toHaveText('Bem-vindo')

  const options = page.locator('#first-run-servers .choice')
  await expect(options).toHaveCount(2)
  await expect(options.first().locator('strong')).toHaveText('eclume em 192.0.2.10')
  await expect(options.first().locator('small')).toHaveText('Veio com este instalador · Usar outro')
  await expect(options.nth(1).locator('strong')).toHaveText('Escritório em 10.0.0.2')
  await expect(options.nth(1).locator('small')).toContainText('Encontrado na rede')
  await expect(options.first().locator('input')).toBeChecked()
  // The installer CA comes with its fingerprint: nothing to check.
  await expect(page.locator('#first-run-trust')).toBeHidden()
  await expect(page.locator('#first-run-sign-in')).toBeEnabled()

  await page.locator('#first-run-email').fill('ana@exemplo.com.br')
  await page.locator('#first-run-password').fill('errada')
  await page.locator('#first-run-sign-in').click()
  await expect(page.locator('#first-run-notice')).toHaveText('E-mail ou senha incorretos')

  await page.locator('#first-run-password').fill('segredo')
  await page.locator('#first-run-sign-in').click()
  await expect(page.locator('[data-view="home"]')).toBeVisible()
  await expect(page.locator('#account-name')).toHaveText('ana@exemplo.com.br')
  await expect(page.locator('#account-action')).toHaveText('Sair')

  const made = await calls(page)
  expect(made).toContainEqual({
    command: 'prepare_server',
    args: {
      url: 'https://192.0.2.10:8443',
      caSha256: '98e209f5457514b7b12ec349d22b3b0d93c03c3f10e52350ea5f9e0b3d97792f',
    },
  })
  expect(made).toContainEqual({ command: 'sign_in', args: { email: 'ana@exemplo.com.br', password: 'segredo' } })
})

test("a server announced on the network requires checking its fingerprint before sign-in", async ({ open }) => {
  const page = await open('firstRun')
  await page.locator('#first-run-servers .choice').nth(1).click()
  const trust = page.locator('#first-run-trust')
  await expect(trust).toBeVisible()
  // The mDNS announcement includes the fingerprint but is unauthenticated: the person checks it.
  await expect(page.locator('#first-run-fingerprint')).toHaveText(/^98:E2:09:F5:.*:79:2F$/)
  await expect(page.locator('#first-run-sign-in')).toBeDisabled()
  await expect(page.locator('#first-run-pair')).toBeDisabled()
  await page.locator('#first-run-trust-continue').click()
  await expect(trust).toBeHidden()
  await expect(page.locator('#first-run-sign-in')).toBeEnabled()
  expect(await calls(page)).toContainEqual({
    command: 'confirm_server',
    args: { url: 'https://10.0.0.2', caSha256: '98e209f5457514b7b12ec349d22b3b0d93c03c3f10e52350ea5f9e0b3d97792f' },
  })
})

test("Advanced: typed address and pairing code", async ({ open }) => {
  const page = await open('noServer')
  await expect(page.locator('#first-run-searching')).toHaveText('Nenhum servidor na rede. Digite o endereço em Avançado.')
  await expect(page.locator('#first-run-advanced')).toHaveAttribute('open', '')
  await expect(page.locator('#first-run-sign-in')).toBeDisabled()

  await page.locator('#first-run-address').fill('eclume local')
  await page.locator('#first-run-use-address').click()
  await expect(page.locator('#first-run-notice')).toContainText('Endereço inválido')

  // A bare host is valid: https:// is added automatically.
  await page.locator('#first-run-address').fill('eclume.local:8443/')
  await page.locator('#first-run-use-address').click()
  const typed = page.locator('#first-run-servers .choice')
  await expect(typed).toHaveCount(1)
  await expect(typed.locator('small')).toContainText('Endereço digitado')
  await page.locator('#first-run-trust-continue').click()

  await page.locator('#first-run-pair').click()
  await expect(page.locator('#first-run-notice')).toContainText('código de 6 caracteres')
  await page.locator('#first-run-code').fill('AAA-AAA')
  await page.locator('#first-run-pair').click()
  await expect(page.locator('#first-run-notice')).toHaveText('Código inválido ou vencido')
  await page.locator('#first-run-code').fill('k7q-4mx')
  await page.locator('#first-run-pair').click()
  await expect(page.locator('[data-view="home"]')).toBeVisible()
  await expect(page.locator('#account-server')).toHaveText('eclume em eclume.local')

  const made = await calls(page)
  expect(made).toContainEqual({ command: 'prepare_server', args: { url: 'https://eclume.local:8443', caSha256: null } })
  expect(made).toContainEqual({ command: 'pair', args: { code: 'k7q-4mx' } })
})

test("Create one on the web opens sign-up on the selected server", async ({ open }) => {
  const page = await open('firstRun')
  await expect(page.locator('#first-run-sign-in')).toBeEnabled()
  await page.locator('#first-run-signup').click()
  await expect
    .poll(async () => (await calls(page)).find((c) => c.command === 'open_signup')?.args)
    .toEqual({ url: 'https://192.0.2.10:8443' })
})

test("a changed CA returns to first run with a notice and disables window keys", async ({ open }) => {
  const page = await open('caChanged')
  await expect(page.locator('[data-view="first-run"]')).toBeVisible()
  await expect(page.locator('#first-run-notice')).toHaveText('O certificado do servidor mudou')
  await page.keyboard.press('Control+,')
  await expect(page.locator('[data-view="settings"]')).toBeHidden()
  await expect(page.locator('#first-run-back')).toBeHidden()
})
