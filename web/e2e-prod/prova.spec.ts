// Proof of the user web (holetz/eclume#38) on staging (holetz/eclume#91), in a real browser and with
// the disposable account of `staging.sh up`: ECLUME_PROOF_URL (default https://127.0.0.1:18444),
// ECLUME_PROD_EMAIL and ECLUME_PROD_PASSWORD (deploy/prove-web-prod.sh fills them). Refuses the
// production URL: only the read-only admin.spec.ts runs there.
// Creates only what it undoes: a temporary field (deleted at the end) and a read-only token (revoked).
// The generated link codes expire on their own in 10 minutes. Screenshots in test-results/prod/.
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

// ECLUME_PROVA_URL is the deprecated pt-BR name, still read.
const URL_BASE = process.env.ECLUME_PROOF_URL ?? process.env.ECLUME_PROVA_URL ?? 'https://127.0.0.1:18444'
const EMAIL = process.env.ECLUME_PROD_EMAIL
const PASSWORD = process.env.ECLUME_PROD_PASSWORD
const SHOTS = 'test-results/prod'
test.use({ baseURL: URL_BASE })

/** A produção (192.168.15.199:8443 ou ECLUME_PUBLIC_URL) não recebe provas que escrevem (#91). */
function ehProducao(url: string): boolean {
  const alvos = ['https://192.168.15.199:8443', process.env.ECLUME_PUBLIC_URL].filter((a): a is string => !!a)
  return alvos.some((a) => new URL(a).host === new URL(url).host)
}

const STAMP = new Date().toISOString().slice(0, 16).replace('T', ' ')

/** "9:42" em segundos. */
function seconds(countdown: string): number {
  const [m, s] = countdown.split(':').map(Number)
  return m * 60 + s
}

async function countdown(page: Page, prefix: string): Promise<number> {
  const text = await page.getByText(new RegExp(`^${prefix} \\d+:\\d{2}$`)).first().textContent()
  return seconds(text!.replace(prefix, '').trim())
}

/** Apaga pela API o que a prova criou, quando um passo falhou antes da limpeza pela tela. */
async function apiDelete(page: Page, url: string) {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'eclume_csrf')?.value ?? ''
  await page.request.delete(url, { headers: { 'X-CSRF-Token': csrf } })
}

test('organizar, configurações e ajuda no staging', async ({ page }) => {
  expect(ehProducao(URL_BASE), `${URL_BASE} é a produção: esta prova escreve; use o staging`).toBe(false)
  test.skip(!EMAIL || !PASSWORD, 'exige ECLUME_PROD_EMAIL e ECLUME_PROD_PASSWORD')
  test.setTimeout(6 * 60_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  // 1. Entra pela tela.
  await page.goto('/entrar')
  await page.getByLabel('E-mail').fill(EMAIL!)
  await page.getByLabel('Senha').fill(PASSWORD!)
  await page.getByRole('button', { name: 'Entrar' }).click()
  await expect(page.locator('#conteudo')).toBeVisible()

  // 2. Campo temporário: salva, testa a regra nas últimas gravações e exclui.
  const fieldName = `Prova web ${STAMP}`
  let fieldId: string | null = null
  try {
    await page.goto('/config/campos')
    await page.getByRole('button', { name: 'Novo campo' }).click()
    const form = page.getByRole('form', { name: 'Novo campo' })
    await form.getByLabel('Nome').fill(fieldName)
    await form.getByLabel('Como identificar').fill(
      'O nome curto da empresa ou do cliente citado na conversa. Deixe vazio quando nenhum for citado.',
    )
    const saved = page.waitForResponse((r) => r.url().endsWith('/api/v1/fields') && r.request().method() === 'POST')
    await form.getByRole('button', { name: 'Salvar' }).click()
    fieldId = (await (await saved).json()).id
    const editor = page.getByRole('form', { name: `Editar ${fieldName}` })
    await editor.getByRole('button', { name: 'Testar numa gravação' }).click()
    const rows = page.getByRole('list', { name: 'Resultado do teste' }).getByRole('listitem')
    await expect(rows.first()).toBeVisible({ timeout: 4 * 60_000 })
    expect(await rows.count()).toBeLessThanOrEqual(3)
    await page.screenshot({ path: `${SHOTS}/campos-testar.png` })
    await editor.getByRole('button', { name: 'Excluir campo' }).click()
    await page.getByRole('dialog', { name: `Excluir ${fieldName}?` }).getByRole('button', { name: 'Excluir campo' }).click()
    await expect(page.getByRole('list', { name: 'Campos' }).getByText(fieldName)).toHaveCount(0)
    fieldId = null
  } finally {
    if (fieldId) await apiDelete(page, `/api/v1/fields/${fieldId}`)
  }

  // 3. App desktop: o código de vínculo começa perto de 10:00 e desce.
  await page.goto('/app-desktop')
  await page.getByRole('button', { name: 'Gerar código de vínculo' }).click()
  const first = await countdown(page, 'Vale por')
  expect(first).toBeGreaterThanOrEqual(9 * 60 + 55)
  expect(first).toBeLessThanOrEqual(10 * 60)
  await page.waitForTimeout(2500)
  expect(await countdown(page, 'Vale por')).toBeLessThan(first)
  await page.screenshot({ path: `${SHOTS}/app-desktop.png` })

  // 4. App móvel: o QR, lido no próprio navegador, é o pair_url com o código da tela.
  await page.goto('/app-movel')
  const qr = page.getByRole('img', { name: 'Código QR para parear o celular' })
  await expect(qr).toBeVisible()
  const display = (await page.getByText(/^Sem câmera\? Digite/).locator('strong').textContent())!.trim()
  await page.addScriptTag({ path: path.resolve('node_modules/jsqr/dist/jsQR.js') })
  const decoded = await qr.evaluate(async (svg) => {
    const image = new Image()
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 400
    const context = canvas.getContext('2d')!
    context.drawImage(image, 0, 0, 400, 400)
    const { data, width, height } = context.getImageData(0, 0, 400, 400)
    type JsQr = (d: Uint8ClampedArray, w: number, h: number) => { data: string } | null
    return (window as unknown as { jsQR: JsQr }).jsQR(data, width, height)?.data ?? null
  })
  expect(decoded).not.toBeNull()
  expect(decoded!.startsWith(`${URL_BASE}/parear?codigo=`)).toBe(true)
  expect(new URL(decoded!).searchParams.get('codigo')).toBe(display.replace('-', ''))
  expect(await countdown(page, 'Válido por')).toBeGreaterThanOrEqual(9 * 60 + 55)
  await page.screenshot({ path: `${SHOTS}/app-movel.png` })

  // 5. Conexão MCP: o endereço é o do descritor; um token só de leitura, criado e revogado.
  const server = await (await page.request.get('/api/v1/server')).json()
  await page.goto('/config/mcp')
  await expect(page.locator('ol.steps .code-block span').first()).toHaveText(server.mcp_url)
  const panel = page.getByRole('region', { name: 'Novo token para um assistente' })
  const tokenName = `Prova web ${STAMP}`
  await panel.getByLabel('Nome').fill(tokenName)
  for (const group of ['Ler e editar resumos', 'Editar campos e tags']) {
    await panel.getByText(group, { exact: true }).click()
  }
  const created = page.waitForResponse((r) => r.url().endsWith('/api/v1/tokens') && r.request().method() === 'POST')
  await panel.getByRole('button', { name: 'Criar token' }).click()
  const token = await (await created).json()
  try {
    expect(token.token.scopes.sort()).toEqual(['recordings:read', 'transcripts:read'])
    await expect(panel).toContainText(`claude mcp add --transport http eclume ${server.mcp_url}`)
    await page.screenshot({ path: `${SHOTS}/mcp.png` })

    await page.goto('/tokens')
    await page.getByRole('button', { name: `Revogar ${tokenName}` }).click()
    await page.getByRole('dialog', { name: `Revogar ${tokenName}?` }).getByRole('button', { name: 'Revogar' }).click()
    await expect(page.getByRole('row', { name: new RegExp(tokenName) })).toContainText('Revogado em')
    await page.screenshot({ path: `${SHOTS}/tokens.png` })
  } finally {
    await apiDelete(page, `/api/v1/tokens/${token.token.id}`)
  }

  // 6. Central de ajuda: busca e artigo.
  await page.goto('/ajuda')
  await page.getByLabel('Buscar na ajuda').fill('token')
  await page.getByRole('link', { name: 'Crie um token de acesso' }).first().click()
  await expect(page.getByRole('heading', { level: 1, name: 'Crie um token de acesso' })).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/ajuda-artigo.png` })

  // 7. A gaveta em Pessoas, pelo atalho "?".
  await page.goto('/pessoas')
  await expect(page.getByRole('heading', { level: 1, name: 'Pessoas' })).toBeVisible()
  await page.keyboard.press('?')
  const drawer = page.getByRole('dialog', { name: 'Ajuda' })
  await expect(drawer).toContainText('Nesta página · Pessoas')
  expect(await drawer.getByRole('list', { name: 'Artigos sobre Pessoas' }).getByRole('link').count()).toBeGreaterThan(0)
  await page.screenshot({ path: `${SHOTS}/pessoas-gaveta.png` })

  expect(errors).toEqual([])
})
