// Organizar, Minhas configurações e Central de ajuda contra o Prism. Como no app.spec.ts, o login
// ganha os cookies de sessão que o servidor real emitiria. O mock serve o primeiro exemplo de cada
// resposta: a pré-visualização de tipo pede o exemplo "tipo" de GET /previews/{id}.
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

/** O mock só tem o exemplo "usado" do estado do código: aqui o código continua pendente. */
async function keepPairingPending(page: Page) {
  await page.route('**/api/v1/devices/pairing-codes/*', async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...(await response.json()), status: 'pending', token_id: null } })
  })
}

/** O exemplo do mock vence numa data fixa: o código criado passa a vencer daqui a 10 minutos. */
async function freshPairingCodes(page: Page) {
  await page.route('**/api/v1/devices/pairing-codes', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    const response = await route.fetch()
    const body = { ...(await response.json()), expires_at: new Date(Date.now() + 600_000).toISOString() }
    await route.fulfill({ response, json: body, headers: { ...response.headers(), date: new Date().toUTCString() } })
  })
}

/** Vai a uma tela: pela barra lateral ou, para configurações e ajuda, pelos menus do cabeçalho. */
async function navTo(page: Page, name: string) {
  const link = page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name, exact: true })
  if (await link.count()) return link.click()
  const menu = name === 'Central de ajuda' ? 'Ajuda' : 'Configurações'
  await page.getByRole('banner').getByRole('button', { name: menu, exact: true }).click()
  await page.getByRole('menuitem', { name, exact: true }).click()
}

test('campos e regras: lista, painel e testar a regra', async ({ page }) => {
  await navTo(page, 'Campos e regras')
  await expect(page.getByRole('heading', { level: 1, name: 'Campos e regras' })).toBeVisible()
  const fields = page.getByRole('list', { name: 'Campos' })
  await expect(fields.getByRole('button', { name: 'Título' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 4, name: 'Título' })).toBeVisible()
  await page.getByRole('button', { name: 'Testar numa gravação' }).click()
  const result = page.getByRole('list', { name: 'Resultado do teste' })
  await expect(result).toContainText('Revisão do contrato')
  await expect(result).toContainText('Serra Azul')
})

test('tipos de agenda: painel e pré-visualizar numa gravação', async ({ page }) => {
  await page.route('**/api/v1/previews/*', (route) =>
    route.continue({ headers: { ...route.request().headers(), prefer: 'example=tipo' } }),
  )
  await navTo(page, 'Tipos de agenda')
  await expect(page.getByRole('heading', { level: 4, name: 'Reunião de equipe' })).toBeVisible()
  await page.getByRole('button', { name: 'Pré-visualizar numa gravação' }).click()
  const dialog = page.getByRole('dialog', { name: 'Pré-visualizar numa gravação' })
  await dialog.getByLabel('Gravação').selectOption({ index: 1 })
  await dialog.getByRole('button', { name: 'Pré-visualizar' }).click()
  const preview = page.getByRole('region', { name: 'Pré-visualização' })
  await expect(preview).toContainText('Mentoria · Próximos passos na carreira')
  await expect(preview).toContainText('82%')
})

test('conexão MCP: endereço do descritor e token do assistente', async ({ page }) => {
  await navTo(page, 'Conexão MCP')
  await expect(page.getByText('https://192.168.15.199:8443/mcp', { exact: true })).toBeVisible()
  const panel = page.getByRole('region', { name: 'Novo token para um assistente' })
  await expect(panel.getByRole('checkbox', { name: 'Excluir gravações' })).not.toBeChecked()
  await expect(panel.getByRole('radio', { name: '90 dias' })).toBeChecked()
  await panel.getByRole('button', { name: 'Criar token' }).click()
  await expect(panel).toContainText(/claude mcp add --transport http eclume https:\/\/192\.168\.15\.199:8443\/mcp/)
})

test('tokens de acesso: tabela com aparelho e revogar com confirmação', async ({ page }) => {
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

test('app desktop: sem instaladores publicados no mock, avisa; o código de vínculo vira Pareado', async ({ page }) => {
  await navTo(page, 'App desktop')
  await expect(page.getByText('Os instaladores ainda não foram publicados neste servidor.')).toHaveCount(3)
  // O estado do código no mock é o exemplo "usado": a tela troca para Pareado na primeira consulta.
  await page.getByRole('button', { name: 'Gerar código de vínculo' }).click()
  await expect(page.getByRole('region', { name: 'Instalou de outro lugar?' }).locator('.alert-success')).toHaveText('Pareado')
  await expect(page.getByRole('region', { name: 'Computadores vinculados' })).toContainText('Desktop — notebook da Mariana')
})

test('app móvel: o QR aparece com os passos e a página pública de pareamento', async ({ page }) => {
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

test('central de ajuda: busca, artigo e a gaveta com "Nesta página"', async ({ page }) => {
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
