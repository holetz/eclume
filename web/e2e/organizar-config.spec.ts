// Organizar, Minhas configurações and Central de ajuda against Prism. As in app.spec.ts, the login
// gets the session cookies the real server would set. The mock serves the first example of each
// response: the type preview asks for the "tipo" example of GET /previews/{id}.
import { expect, test, type Page } from '@playwright/test'

test.beforeEach(async ({ page, baseURL }) => {
  await page.route(/\/api\/v1\/auth\/login$/, async (route) => {
    const response = await route.fetch()
    if (response.status() === 204) {
      await page.context().addCookies([
        { name: 'eclume_session', value: 'e2e', url: baseURL! },
        { name: 'eclume_csrf', value: 'csrf-e2e', url: baseURL! },
      ])
    }
    await route.fulfill({ response })
  })
  await freshPairingCodes(page)
  await page.goto('/entrar')
  await page.getByLabel('E-mail').fill('mariana.couto@example.com')
  await page.getByLabel('Senha').fill('senha-de-teste')
  await page.getByRole('button', { name: 'Entrar' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Biblioteca' })).toBeVisible()
})

/** The mock only has the "usado" example of the code state: here the code stays pending. */
async function keepPairingPending(page: Page) {
  await page.route('**/api/v1/devices/pairing-codes/*', async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...(await response.json()), status: 'pending', token_id: null } })
  })
}

/** The mock example expires on a fixed date: the created code now expires 10 minutes from now. */
async function freshPairingCodes(page: Page) {
  await page.route('**/api/v1/devices/pairing-codes', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    const response = await route.fetch()
    const body = { ...(await response.json()), expires_at: new Date(Date.now() + 600_000).toISOString() }
    await route.fulfill({ response, json: body, headers: { ...response.headers(), date: new Date().toUTCString() } })
  })
}

/** Goes to a screen: through the sidebar or, for settings and help, through the header menus. */
async function navTo(page: Page, name: string) {
  const link = page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name, exact: true })
  if (await link.count()) return link.click()
  const menu = name === 'Central de ajuda' ? 'Ajuda' : 'Configurações'
  await page.getByRole('banner').getByRole('button', { name: menu, exact: true }).click()
  await page.getByRole('menuitem', { name, exact: true }).click()
}

test('custom fields: list, panel and testing the rule', async ({ page }) => {
  await navTo(page, 'Campos personalizados')
  await expect(page.getByRole('heading', { level: 1, name: 'Campos personalizados' })).toBeVisible()
  const fields = page.getByRole('list', { name: 'Campos' })
  // The title comes from the agenda types and the tags from the Tags screen: the list has only the user's fields.
  await expect(fields.getByRole('button', { name: 'Título' })).toHaveCount(0)
  await expect(fields.getByRole('button', { name: 'Cliente' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 4, name: 'Cliente' })).toBeVisible()
  await page.getByRole('button', { name: 'Testar numa gravação' }).click()
  const result = page.getByRole('list', { name: 'Resultado do teste' })
  await expect(result).toContainText('Revisão do contrato')
  await expect(result).toContainText('Serra Azul')
})

test('agenda types: panel and preview on a recording', async ({ page }) => {
  await page.route('**/api/v1/previews/*', (route) =>
    route.continue({ headers: { ...route.request().headers(), prefer: 'example=tipo' } }),
  )
  await navTo(page, 'Tipos de agenda')
  // The fallback type opens first, at the top of the list.
  await expect(page.getByRole('heading', { level: 4, name: /^Geral/ })).toBeVisible()
  await page.getByRole('button', { name: 'Pré-visualizar numa gravação' }).click()
  const dialog = page.getByRole('dialog', { name: 'Pré-visualizar numa gravação' })
  await dialog.getByLabel('Gravação').selectOption({ index: 1 })
  await dialog.getByRole('button', { name: 'Pré-visualizar' }).click()
  const preview = page.getByRole('region', { name: 'Pré-visualização' })
  await expect(preview).toContainText('Mentoria · Próximos passos na carreira')
  await expect(preview).toContainText('82%')
})

test('tags: the catalog with the agent badge and the settings', async ({ page }) => {
  await navTo(page, 'Tags')
  await expect(page.getByRole('heading', { level: 1, name: 'Tags' })).toBeVisible()
  const tags = page.getByRole('list', { name: 'Tags' })
  await expect(tags).toContainText('cliente-metalurgica')
  await expect(tags).toContainText('Criada pelo agente')
})

test('MCP connection: descriptor address and assistant token', async ({ page }) => {
  await navTo(page, 'Conexão MCP')
  await expect(page.getByText('https://192.168.15.199:8443/mcp', { exact: true })).toBeVisible()
  const panel = page.getByRole('region', { name: 'Novo token para um assistente' })
  await expect(panel.getByRole('checkbox', { name: 'Excluir gravações' })).not.toBeChecked()
  await expect(panel.getByRole('radio', { name: '90 dias' })).toBeChecked()
  await panel.getByRole('button', { name: 'Criar token' }).click()
  await expect(panel).toContainText(/claude mcp add --transport http eclume https:\/\/192\.168\.15\.199:8443\/mcp/)
})

test('access tokens: table with device and revoke with confirmation', async ({ page }) => {
  await navTo(page, 'Tokens de acesso')
  const table = page.getByRole('table')
  await expect(table.getByText('Aparelho · Windows')).toBeVisible()
  await expect(table.getByText('transcripts:read, people:read')).toBeVisible()
  await page.getByRole('button', { name: 'Revogar lumea — importador' }).click()
  const dialog = page.getByRole('dialog', { name: 'Revogar lumea — importador?' })
  await expect(dialog).toContainText('Quem usa este token perde o acesso.')
  await dialog.getByRole('button', { name: 'Cancelar' }).click()
  await expect(dialog).toHaveCount(0)
})

test('desktop app: with no installers published in the mock, warns; the pairing code turns Pareado', async ({ page }) => {
  await navTo(page, 'App desktop')
  await expect(page.getByText('Os instaladores ainda não foram publicados neste servidor.')).toHaveCount(3)
  // The code state in the mock is the "usado" example: the screen switches to Pareado on the first poll.
  await page.getByRole('button', { name: 'Gerar código de vínculo' }).click()
  await expect(page.getByRole('region', { name: 'Instalou de outro lugar?' }).locator('.alert-success')).toHaveText('Pareado')
  await expect(page.getByRole('region', { name: 'Computadores vinculados' })).toContainText('Desktop — notebook da Mariana')
})

test('mobile app: the QR shows with the steps and the public pairing page', async ({ page }) => {
  await keepPairingPending(page)
  await navTo(page, 'App móvel')
  const qr = page.getByRole('img', { name: 'Código QR para parear o celular' })
  await expect(qr).toBeVisible()
  await expect(page.getByText('Toque em Ler um código')).toBeVisible()
  await expect(page.getByText(/Sem câmera\? Digite/)).toContainText('K7Q-4MX')

  await page.goto('/parear?codigo=K7Q4MX')
  await expect(page.getByRole('heading', { name: 'Parear o celular' })).toBeVisible()
  await expect(page.getByText('K7Q-4MX')).toBeVisible()
})

test('help center: search, article and the drawer with "Nesta página"', async ({ page }) => {
  await navTo(page, 'Central de ajuda')
  await expect(page.getByRole('heading', { level: 1, name: 'Central de ajuda' })).toBeVisible()
  await page.getByLabel('Buscar na ajuda').fill('token')
  await page.getByRole('link', { name: 'Crie um token de acesso' }).first().click()
  await expect(page).toHaveURL(/\/ajuda\/criar-token$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Crie um token de acesso' })).toBeVisible()

  await navTo(page, 'Pessoas')
  await expect(page.getByRole('heading', { level: 1, name: 'Pessoas' })).toBeVisible()
  await page.keyboard.press('?')
  const drawer = page.getByRole('dialog', { name: 'Ajuda' })
  await expect(drawer).toContainText('Nesta página · Pessoas')
  await expect(drawer.getByRole('link', { name: 'Como funcionam as sugestões por voz' })).toBeVisible()
})
