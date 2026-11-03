// Proof of the library and the recording (holetz/eclume#37) on staging (holetz/eclume#91), in the
// real browser and with the disposable account of `staging.sh up`: import of an M4A through the modal
// with the metadata date, the event in the right week, the pipeline up to the summary, the edit, the
// chat, the DOCX and the deletion.
//   ECLUME_PROOF_URL (default https://127.0.0.1:18444), ECLUME_E2E_EMAIL, ECLUME_E2E_PASSWORD and
//   ECLUME_E2E_AUDIO (an M4A with creation_time 2026-09-21T12:00:00Z). Refuses the production URL.
// Runs with playwright.real.config.ts; the screenshots, light and dark, stay in test-results/prod/.
import { readFileSync } from 'node:fs'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

const EMAIL = process.env.ECLUME_E2E_EMAIL ?? ''
const PASSWORD = process.env.ECLUME_E2E_PASSWORD ?? ''
const AUDIO = process.env.ECLUME_E2E_AUDIO ?? ''
const SHOTS = 'test-results/prod'
// ECLUME_PROVA_URL is the deprecated pt-BR name, still read.
const URL_BASE = process.env.ECLUME_PROOF_URL ?? process.env.ECLUME_PROVA_URL ?? 'https://127.0.0.1:18444'
const WEEK = '/?visao=semana&data=2026-09-21'

// O creation_time do M4A é 12:00 UTC: 09:00 em Brasília, na segunda 21/09/2026.
test.use({ timezoneId: 'America/Sao_Paulo', baseURL: URL_BASE })

/** A produção (192.168.15.199:8443 ou ECLUME_PUBLIC_URL) não recebe provas que escrevem (#91). */
function ehProducao(url: string): boolean {
  const alvos = ['https://192.168.15.199:8443', process.env.ECLUME_PUBLIC_URL].filter((a): a is string => !!a)
  return alvos.some((a) => new URL(a).host === new URL(url).host)
}

async function shoot(page: Page, name: string) {
  for (const [scheme, suffix] of [
    ['light', 'claro'],
    ['dark', 'escuro'],
  ] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme)
    await page.screenshot({ path: `${SHOTS}/producao-${name}-${suffix}.png` })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

/** Pelo painel de admin (mesmo e-mail e senha): há agente ligado para resumos e chat. */
async function expectAgents(request: APIRequestContext) {
  const login = await request.post('/api/v1/admin/auth/login', { data: { email: EMAIL, password: PASSWORD } })
  expect(login.status(), 'a conta de admin tem a mesma senha? (docs/project/deploy-producao.md)').toBe(204)
  const providers = (await (await request.get('/api/v1/admin/agent-providers')).json()).items as {
    enabled: boolean
    used_for: string[]
  }[]
  const serves = (purpose: string) => providers.some((p) => p.enabled && p.used_for.includes(purpose))
  expect(serves('summaries') && serves('chat'), 'Admin → Agentes sem provider para resumos e chat').toBe(true)
}

test('biblioteca e gravação no staging: import com data, pipeline, edição, chat, DOCX e exclusão', async ({
  page,
  request,
}) => {
  // Só na prova no staging: o e2e-real.sh roda os outros cenários sem estas variáveis.
  test.skip(!EMAIL, 'só com ECLUME_E2E_EMAIL (prova no staging)')
  expect(ehProducao(URL_BASE), `${URL_BASE} é a produção: esta prova escreve; use o staging`).toBe(false)
  test.setTimeout(15 * 60_000)
  expect(PASSWORD && AUDIO, 'defina ECLUME_E2E_PASSWORD e ECLUME_E2E_AUDIO').toBeTruthy()
  await expectAgents(request)

  await page.goto('/entrar')
  await page.getByLabel('E-mail').fill(EMAIL)
  await page.getByLabel('Senha').fill(PASSWORD)
  await page.getByRole('button', { name: 'Entrar' }).click()
  const notice = page.getByRole('button', { name: 'Aceitar e continuar' })
  await expect(page.getByRole('navigation', { name: 'Principal' }).or(notice)).toBeVisible()
  if (await notice.isVisible()) {
    await page.locator('.check').click()
    await notice.click()
  }

  // Import pelo modal: a data vem dos metadados do M4A, lida antes da conversão.
  await page.goto(WEEK)
  await expect(page.getByText('21–27 de setembro de 2026')).toBeVisible()
  await page.getByRole('button', { name: 'Importar arquivos' }).click()
  const dialog = page.getByRole('dialog', { name: 'Importar arquivos' })
  await dialog.getByLabel(/Solte áudio ou vídeo aqui/).setInputFiles({
    name: 'eclume-prova.m4a',
    mimeType: 'audio/mp4',
    buffer: readFileSync(AUDIO),
  })
  await expect(dialog.getByLabel('Início da gravação de eclume-prova.m4a')).toHaveValue('2026-09-21T09:00')
  await expect(dialog.getByText('Dos metadados do arquivo')).toBeVisible()
  await shoot(page, 'importar')
  await dialog.getByRole('button', { name: 'Enviar 1 arquivo' }).click()
  const open = dialog.getByRole('link', { name: 'Abrir' })
  await expect(open).toBeVisible({ timeout: 3 * 60_000 })
  const href = (await open.getAttribute('href'))!
  await dialog.getByRole('button', { name: 'Fechar' }).last().click()

  // O evento aparece na semana certa, na segunda às 09:00.
  const event = page.locator(`a.cal-event[href="${href}"]`)
  await expect(event).toBeVisible()
  await expect(event).toHaveAttribute('aria-label', /, 09:00, /)
  await expect(event.locator('xpath=..')).toHaveAttribute('aria-label', 'segunda, 21 de setembro')

  // O pipeline anda até o resumo; a página relê sozinha.
  await event.click()
  await expect(page.getByRole('list', { name: 'Processamento' }).getByText('Resumo pronto')).toBeVisible({
    timeout: 8 * 60_000,
  })
  const summary = page.getByRole('region', { name: 'Resumo', exact: true })
  await expect(summary.locator('.doc')).toBeVisible({ timeout: 2 * 60_000 })
  await shoot(page, 'gravacao')

  // Edição à mão: vira a versão "Editado por você".
  await summary.getByRole('button', { name: 'Editar' }).click()
  const editor = page.getByRole('region', { name: 'Editando o resumo' })
  const text = editor.getByRole('textbox', { name: 'Resumo em Markdown' })
  await text.fill(`${await text.inputValue()}\n\nRevisado na prova de produção.`)
  await editor.getByRole('button', { name: 'Salvar' }).click()
  await expect(summary.getByText(/Editado por você · versão \d+/)).toBeVisible()

  // Chat: o agente trabalha no resumo e cria a versão "Ajustado pelo chat".
  const chat = page.getByRole('complementary', { name: 'Ajustar o resumo' })
  await chat
    .getByRole('textbox', { name: 'Pedido de ajuste' })
    .fill('Diga quem fala primeiro na reunião e acrescente isso no início do resumo.')
  await chat.getByRole('button', { name: 'Enviar' }).click()
  await expect(summary.getByText(/Ajustado pelo chat · versão \d+/)).toBeVisible({ timeout: 4 * 60_000 })
  await shoot(page, 'gravacao-chat')

  // DOCX: transcrição e resumo, baixado por fetch.
  await page.getByRole('button', { name: 'Exportar' }).click()
  const download = page.waitForEvent('download')
  await page.getByRole('menuitem', { name: /Transcrição e resumo/ }).click()
  const docx = await download
  expect(docx.suggestedFilename()).toMatch(/\.docx$/)
  expect(
    readFileSync((await docx.path())!)
      .subarray(0, 2)
      .toString(),
  ).toBe('PK')

  // Exclusão: volta à semana, sem a gravação da prova.
  await page.getByRole('button', { name: 'Excluir', exact: true }).click()
  await page.getByRole('dialog', { name: 'Excluir a gravação?' }).getByRole('button', { name: 'Excluir' }).click()
  await expect(page.getByText('Gravação excluída.')).toBeVisible()
  await expect(page).toHaveURL(/visao=semana&data=2026-09-21/)
  await expect(page.locator(`a.cal-event[href="${href}"]`)).toHaveCount(0)
  await shoot(page, 'biblioteca')
})
