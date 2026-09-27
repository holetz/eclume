import { test, expect, chamadas } from './fixtures'
import type { Page } from '@playwright/test'

type Entrada = Record<string, unknown> & { policies: Record<string, string> }

async function ultimaEntrada(page: Page): Promise<Entrada> {
  return page.evaluate(() => (window as unknown as { __mock: { estado: { ultimaEntrada: Entrada } } }).__mock.estado.ultimaEntrada)
}

test('Ctrl+, abre Reuniões com os 7 apps, o subtítulo do DS e a política de cada um', async ({ abrir }) => {
  const page = await abrir()
  await page.keyboard.press('Control+,')
  await expect(page.locator('[data-vista="configuracoes"]')).toBeVisible()
  await expect(page.locator('[data-aba="reunioes"]')).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('#detectar')).toBeChecked()
  const linhas = page.locator('#apps .list-row')
  await expect(linhas).toHaveCount(7)
  await expect(linhas.locator('.list-row-title')).toHaveText([
    'Microsoft Teams',
    'Zoom',
    'Google Meet',
    'Webex',
    'Slack',
    'Navegador',
    'Outro app',
  ])
  await expect(linhas.nth(4).locator('.list-row-sub')).toHaveText('Chamadas')
  await expect(linhas.nth(5).locator('.list-row-sub')).toHaveText('Microfone em uso, reunião não reconhecida')
  await expect(linhas.nth(6).locator('input[value="ignore"]')).toBeChecked()
  await expect(linhas.first().locator('.seg-opt')).toHaveText(['Gravar', 'Perguntar', 'Ignorar'])
})

test('mudar a política, desligar a detecção e restaurar os padrões salvam na hora', async ({ abrir }) => {
  const page = await abrir()
  await page.locator('#abrir-configuracoes').click()
  const zoom = page.locator('#apps .list-row[data-app="zoom"]')
  await zoom.locator('.seg-opt', { hasText: 'Gravar' }).click()
  await expect(zoom.locator('input[value="auto"]')).toBeChecked()
  expect((await ultimaEntrada(page)).policies.zoom).toBe('auto')

  await page.locator('.switch', { hasText: 'Detectar reuniões' }).click()
  await expect(page.locator('#detectar')).not.toBeChecked()
  expect((await ultimaEntrada(page)).detection_enabled).toBe(false)

  await page.locator('#restaurar-padroes').click()
  await expect(zoom.locator('input[value="ask"]')).toBeChecked()
  const entrada = await ultimaEntrada(page)
  expect(entrada.policies).toEqual({
    teams: 'ask',
    zoom: 'ask',
    meet: 'ask',
    webex: 'ask',
    slack: 'ask',
    navegador: 'ask',
    outro: 'ignore',
  })
})

test('Armazenamento: retenção em três escolhas, pasta local, espaço e tentar de novo', async ({ abrir }) => {
  const page = await abrir()
  await page.locator('#abrir-configuracoes').click()
  await page.locator('[data-aba="armazenamento"]').click()
  await expect(page.locator('[data-painel="armazenamento"]')).toBeVisible()
  await expect(page.locator('[data-painel="reunioes"]')).toBeHidden()
  await expect(page.locator('input[name="retencao"][value="dias"]')).toBeChecked()
  await expect(page.locator('#retencao-dias')).toHaveValue('7')
  await expect(page.locator('#pasta-local')).toHaveText('/home/ana/.local/share/eclume/gravacoes')
  await expect(page.locator('#espaco-usado')).toHaveText('3 gravações · 41 MB neste computador')

  await page.locator('.choice', { hasText: 'Manter para sempre' }).click()
  await expect(page.locator('#retencao-dias')).toBeDisabled()
  expect((await ultimaEntrada(page)).retention_days).toBeNull()

  await page.locator('.choice', { hasText: 'Apagar a cópia local' }).click()
  expect((await ultimaEntrada(page)).retention_days).toBe(0)

  await page.locator('.choice', { hasText: 'Manter por alguns dias' }).click()
  await page.locator('#retencao-dias').fill('30')
  await page.locator('#retencao-dias').press('Enter')
  await expect.poll(async () => (await ultimaEntrada(page)).retention_days).toBe(30)

  await page.locator('#retencao-dias').fill('4000')
  await page.locator('#retencao-dias').press('Enter')
  await expect(page.locator('#config-aviso')).toContainText('Use de 1 a 3650 dias.')

  await page.locator('#mostrar-pasta').click()
  await page.locator('#tentar-de-novo').click()
  await expect(page.locator('#config-aviso')).toContainText('As falhas vão ser enviadas de novo.')
  const comandos = (await chamadas(page)).map((c) => c.comando)
  expect(comandos).toContain('open_data_dir')
  expect(comandos).toContain('sync_now')
})

test('Servidor pelo link da conta: salva endereço e token, recusa endereço inválido', async ({ abrir }) => {
  const page = await abrir('vazio')
  await page.locator('#conta-acao').click()
  await expect(page.locator('[data-aba="servidor"]')).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('#servidor-endereco')).toHaveValue('https://192.168.15.199:8443')
  await expect(page.locator('#servidor-token-estado')).toContainText('Sem token')
  await expect(page.locator('#servidor-esquecer')).toBeHidden()

  await page.locator('#servidor-endereco').fill('sem-esquema')
  await page.locator('#servidor-salvar').click()
  await expect(page.locator('#config-aviso.alert-error')).toContainText('endereço inválido')

  await page.locator('#servidor-endereco').fill('https://eclume.local:8443')
  await page.locator('#servidor-token').fill('eclp_segredo')
  await page.locator('#servidor-salvar').click()
  await expect(page.locator('#config-aviso.alert-success')).toContainText('Configurações do servidor salvas.')
  await expect(page.locator('#servidor-token')).toHaveValue('')
  await expect(page.locator('#servidor-token-estado')).toHaveText('Conectado com um token pessoal.')
  const entrada = await ultimaEntrada(page)
  expect(entrada.web_url).toBe('https://eclume.local:8443')
  expect(entrada.pat).toBe('eclp_segredo')
  expect(entrada.api_url).toBeNull()

  await page.locator('#config-voltar').click()
  await expect(page.locator('[data-vista="principal"]')).toBeVisible()
})
