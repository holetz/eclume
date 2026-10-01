import { test, expect, chamadas } from './fixtures'
import type { Page } from '@playwright/test'

type Entrada = Record<string, unknown> & { policies: Record<string, string> }

async function ultimaEntrada(page: Page): Promise<Entrada> {
  return page.evaluate(() => (window as unknown as { __mock: { estado: { ultimaEntrada: Entrada } } }).__mock.estado.ultimaEntrada)
}

test('Ctrl+, abre a aba Geral, com Aparência, Início e Avisos, e Reuniões fica só com a detecção', async ({ abrir }) => {
  const page = await abrir()
  await page.keyboard.press('Control+,')
  await expect(page.locator('[data-vista="configuracoes"]')).toBeVisible()
  await expect(page.locator('[role="tab"]')).toHaveText(['Geral', 'Reuniões', 'Áudio', 'Armazenamento', 'Pasta', 'Servidor'])
  await expect(page.locator('[data-aba="geral"]')).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('[data-painel="geral"] .kicker')).toHaveText(['Aparência', 'Início', 'Avisos'])
  await expect(page.locator('[data-painel="reunioes"]')).toBeHidden()
  await page.locator('[data-aba="reunioes"]').click()
  await expect(page.locator('[data-painel="geral"]')).toBeHidden()
  await expect(page.locator('[data-painel="reunioes"] #tema, [data-painel="reunioes"] #avisar-resumo')).toHaveCount(0)
})

test('Reuniões tem os 8 apps, o subtítulo do DS e a política de cada um', async ({ abrir }) => {
  const page = await abrir()
  await page.keyboard.press('Control+,')
  await page.locator('[data-aba="reunioes"]').click()
  await expect(page.locator('[data-aba="reunioes"]')).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('#detectar')).toBeChecked()
  const linhas = page.locator('#apps .list-row')
  await expect(linhas).toHaveCount(8)
  await expect(linhas.locator('.list-row-title')).toHaveText([
    'Microsoft Teams',
    'Zoom',
    'Google Meet',
    'Webex',
    'Slack',
    'WhatsApp',
    'Navegador',
    'Outro app',
  ])
  await expect(linhas.nth(4).locator('.list-row-sub')).toHaveText('Chamadas')
  await expect(linhas.nth(5).locator('.list-row-sub')).toHaveText('App ou aba do WhatsApp Web')
  await expect(linhas.nth(6).locator('.list-row-sub')).toHaveText('Microfone em uso, reunião não reconhecida')
  await expect(linhas.nth(7).locator('input[value="ignore"]')).toBeChecked()
  await expect(linhas.first().locator('.seg-opt')).toHaveText(['Gravar', 'Confirmar', 'Ignorar'])
})

test('Geral: o aviso do fim do processamento vem ligado e desliga na hora', async ({ abrir }) => {
  const page = await abrir()
  await page.locator('#abrir-configuracoes').click()
  await expect(page.locator('#avisar-resumo')).toBeChecked()
  await page.locator('label.switch', { hasText: 'Avisar quando uma gravação terminar de processar' }).click()
  await expect(page.locator('#avisar-resumo')).not.toBeChecked()
  expect((await ultimaEntrada(page)).notify_summary).toBe(false)
})

test('Geral: iniciar com o computador vem ligado e desliga na hora', async ({ abrir }) => {
  const page = await abrir()
  await page.locator('#abrir-configuracoes').click()
  await expect(page.locator('#iniciar-com-o-sistema')).toBeChecked()
  await page.locator('label.switch', { hasText: 'Iniciar com o computador' }).click()
  await expect(page.locator('#iniciar-com-o-sistema')).not.toBeChecked()
  expect((await ultimaEntrada(page)).autostart).toBe(false)
})

test('mudar a política, desligar a detecção e restaurar os padrões salvam na hora', async ({ abrir }) => {
  const page = await abrir()
  await page.locator('#abrir-configuracoes').click()
  await page.locator('[data-aba="reunioes"]').click()
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
    whatsapp: 'ask',
    navegador: 'ask',
    outro: 'ignore',
  })
})

test('Armazenamento: retenção em três escolhas, pasta local, espaço e tentar de novo', async ({ abrir }) => {
  const page = await abrir()
  await page.locator('#abrir-configuracoes').click()
  await page.locator('[data-aba="armazenamento"]').click()
  await expect(page.locator('[data-painel="armazenamento"]')).toBeVisible()
  await expect(page.locator('[data-painel="geral"]')).toBeHidden()
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

test('Servidor: a conta com Sair, o endereço, a CA extra pelo diálogo e Testar conexão', async ({ abrir }) => {
  const page = await abrir()
  await page.locator('#abrir-configuracoes').click()
  await page.locator('[data-aba="servidor"]').click()
  await expect(page.locator('#servidor-conta')).toHaveText('ana@exemplo.com.br')
  await expect(page.locator('#servidor-conta-sub')).toHaveText('Conectado ao eclume em 192.168.15.199')
  await expect(page.locator('#servidor-entrar')).toBeHidden()
  await expect(page.locator('#servidor-endereco')).toHaveValue('https://192.168.15.199:8443')
  // Colar PAT saiu da tela.
  await expect(page.locator('#servidor-token')).toHaveCount(0)

  await page.locator('#servidor-testar').click()
  await expect(page.locator('#servidor-conexao')).toHaveText('Conectado · último envio 10:38')
  await expect(page.locator('#servidor-conexao')).toHaveAttribute('data-status', 'synced')

  await page.locator('#servidor-endereco').fill('sem-esquema')
  await page.locator('#servidor-salvar').click()
  await expect(page.locator('#config-aviso.alert-error')).toContainText('endereço inválido')

  await page.locator('[data-painel="servidor"] .disclosure summary').click()
  await expect(page.locator('#servidor-ca')).toHaveText('Nenhuma')
  await page.locator('#servidor-ca-escolher').click()
  await expect(page.locator('#servidor-ca')).toHaveText('/home/ana/caddy-root.pem')
  await page.locator('#servidor-endereco').fill('https://eclume.local:8443')
  await page.locator('#servidor-salvar').click()
  await expect(page.locator('#config-aviso.alert-success')).toContainText('Configurações do servidor salvas.')
  const entrada = await ultimaEntrada(page)
  expect(entrada.web_url).toBe('https://eclume.local:8443')
  expect(entrada.ca_path).toBe('/home/ana/caddy-root.pem')
  expect(entrada.api_url).toBeNull()
  expect(entrada.pat).toBeUndefined()

  await page.locator('#servidor-sair').click()
  await expect(page.locator('[data-vista="primeira-execucao"]')).toBeVisible()
  expect((await chamadas(page)).map((c) => c.comando)).toContain('sign_out')
})

test('Servidor com o PAT antigo: segue conectado e oferece entrar com e-mail e senha', async ({ abrir }) => {
  const page = await abrir('pat')
  await expect(page.locator('#conta-nome')).toHaveText('Conectado com um token pessoal')
  await page.locator('#conta-acao').click()
  await expect(page.locator('[data-aba="servidor"]')).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('#servidor-conta')).toHaveText('Conectado com um token pessoal')
  await expect(page.locator('#servidor-sair')).toBeVisible()
  await page.locator('#servidor-entrar').click()
  await expect(page.locator('[data-vista="primeira-execucao"]')).toBeVisible()
  await expect(page.locator('#bv-voltar')).toBeVisible()
  await page.locator('#bv-voltar').click()
  await expect(page.locator('[data-vista="principal"]')).toBeVisible()
})

test('Áudio: microfone por nome, saída do sistema e parada por silêncio salvam na hora', async ({ abrir }) => {
  const page = await abrir()
  await page.locator('#abrir-configuracoes').click()
  await page.locator('[data-aba="audio"]').click()
  await expect(page.locator('[data-painel="audio"]')).toBeVisible()
  await expect(page.locator('#microfone option')).toHaveText([
    'Padrão do sistema · Microfone embutido',
    'Microfone embutido',
    'Jabra Evolve2 65',
    'Nenhum',
  ])
  await expect(page.locator('#microfone')).toHaveValue('')
  await expect(page.locator('#audio-sistema option')).toHaveText([
    'Seguir a saída em uso',
    'Alto-falantes embutidos',
    'Jabra Evolve2 65',
    'Nenhum',
  ])
  await expect(page.locator('#audio-sistema')).toHaveValue('follow')
  await expect(page.locator('input[name="silencio"][value="4"]')).toBeChecked()

  await page.locator('#microfone').selectOption('Jabra Evolve2 65')
  await expect.poll(async () => (await ultimaEntrada(page)).mic).toBe('Jabra Evolve2 65')

  await page.locator('#audio-sistema').selectOption('bluez_output.jabra')
  await expect.poll(async () => (await ultimaEntrada(page)).system_source).toBe('bluez_output.jabra')

  await page.locator('#silencio .seg-opt', { hasText: 'Nunca' }).click()
  await expect(page.locator('input[name="silencio"][value="0"]')).toBeChecked()
  expect((await ultimaEntrada(page)).note_silence_s).toBe(0)
  await page.locator('#silencio .seg-opt', { hasText: '8 s' }).click()
  await expect.poll(async () => (await ultimaEntrada(page)).note_silence_s).toBe(8)

  await expect(page.locator('#idioma')).toHaveValue('')
  await expect(page.locator('#idioma option')).toHaveText([
    'Padrão da conta: Português',
    'Detectar automaticamente',
    'Português',
    'Español',
    'English',
  ])
  await page.locator('#idioma').selectOption('es')
  await expect.poll(async () => (await ultimaEntrada(page)).language).toBe('es')
  await expect(page.locator('#idioma')).toHaveValue('es')
  await page.locator('#idioma').selectOption('auto')
  await expect.poll(async () => (await ultimaEntrada(page)).language).toBe('auto')
  await page.locator('#idioma').selectOption('')
  await expect.poll(async () => (await ultimaEntrada(page)).language).toBe('')
})

test('Áudio: "Nenhum" em cada fonte desliga o teste dela, e as duas em "Nenhum" são recusadas', async ({ abrir }) => {
  const page = await abrir()
  await page.locator('#abrir-configuracoes').click()
  await page.locator('[data-aba="audio"]').click()
  await expect(page.locator('#testar-mic')).toBeEnabled()
  await expect(page.locator('#testar-sistema')).toBeEnabled()

  await page.locator('#audio-sistema').selectOption('none')
  await expect.poll(async () => (await ultimaEntrada(page)).system_source).toBe('none')
  await expect(page.locator('#testar-sistema')).toBeDisabled()
  await expect(page.locator('#testar-mic')).toBeEnabled()

  await page.locator('#microfone').selectOption('none')
  await expect(page.locator('#config-aviso')).toContainText('Escolha ao menos uma fonte de áudio')
  await expect(page.locator('#microfone')).toHaveValue('')

  await page.locator('#audio-sistema').selectOption('follow')
  await expect.poll(async () => (await ultimaEntrada(page)).system_source).toBe('follow')
  await page.locator('#microfone').selectOption('none')
  await expect.poll(async () => (await ultimaEntrada(page)).mic).toBe('none')
  await expect(page.locator('#testar-mic')).toBeDisabled()
  await expect(page.locator('#testar-sistema')).toBeEnabled()
})

test('Áudio: o teste do microfone mostra o medidor, vira "Parar" e volta ao fim', async ({ abrir }) => {
  const page = await abrir()
  await page.locator('#abrir-configuracoes').click()
  await page.locator('[data-aba="audio"]').click()
  await expect(page.locator('#medidor-teste i')).toHaveCount(16)
  await page.locator('#testar-mic').click()
  await expect(page.locator('#testar-mic')).toHaveText('Parar')
  await expect(page.locator('#testar-sistema')).toHaveText('Toque algo para testar')
  await expect(page.locator('#medidor-teste i:not([data-quiet])')).toHaveCount(6)
  await expect(page.locator('#testar-mic')).toHaveText('Fale para testar')
  await expect(page.locator('#medidor-teste i[data-quiet]')).toHaveCount(16)
  expect((await chamadas(page)).filter((c) => c.comando === 'source_test')).toEqual([
    { comando: 'source_test', args: { source: 'mic' } },
  ])
})

test('Áudio: o teste do sistema para antes do fim com "Parar"', async ({ abrir }) => {
  const page = await abrir()
  await page.locator('#abrir-configuracoes').click()
  await page.locator('[data-aba="audio"]').click()
  await page.locator('#testar-sistema').click()
  await expect(page.locator('#testar-sistema')).toHaveText('Parar')
  await expect(page.locator('#medidor-teste i:not([data-quiet])')).toHaveCount(6)
  await page.locator('#testar-sistema').click()
  await expect(page.locator('#testar-sistema')).toHaveText('Toque algo para testar')
  await expect(page.locator('#medidor-teste i[data-quiet]')).toHaveCount(16)
  const testes = (await chamadas(page)).filter((c) => ['source_test', 'source_test_stop'].includes(c.comando))
  expect(testes).toEqual([
    { comando: 'source_test', args: { source: 'system' } },
    { comando: 'source_test_stop', args: null },
  ])
})

test('Áudio no Wayland sem portal: cria e remove os atalhos do GNOME', async ({ abrir }) => {
  const page = await abrir('wayland')
  await page.locator('#abrir-configuracoes').click()
  await page.locator('[data-aba="audio"]').click()
  await expect(page.locator('#atalhos-modo')).toHaveText(
    'Nesta sessão (Wayland), o eclume não ouve o teclado sozinho: crie os atalhos no GNOME.',
  )
  const linhas = page.locator('#atalhos .list-row')
  await expect(linhas.locator('.list-row-sub')).toHaveText(Array(3).fill('Crie o atalho no sistema'))
  await expect(linhas.locator('.atalho-comando')).toHaveCount(0)

  await page.locator('#atalhos-gnome', { hasText: 'Criar atalhos no GNOME' }).click()
  await expect(page.locator('#config-aviso')).toContainText('Atalhos criados no GNOME.')
  await expect(linhas.locator('.list-row-sub')).toHaveText(Array(3).fill('Funciona com o eclume em segundo plano'))
  await expect(page.locator('#atalhos-modo')).toHaveText('Nesta sessão (Wayland), os atalhos são do GNOME e chamam o eclume.')
  expect((await chamadas(page)).filter((c) => c.comando === 'system_shortcuts')).toEqual([
    { comando: 'system_shortcuts', args: { install: true } },
  ])

  await page.locator('#atalhos-gnome', { hasText: 'Remover atalhos do GNOME' }).click()
  await expect(page.locator('#config-aviso')).toContainText('Atalhos removidos do GNOME.')
  await expect(page.locator('#atalhos-gnome')).toHaveText('Criar atalhos no GNOME')
})

test('Áudio: atalhos com o estado do registro e troca pela próxima combinação', async ({ abrir }) => {
  const page = await abrir('atalhoEmUso')
  await page.locator('#abrir-configuracoes').click()
  await page.locator('[data-aba="audio"]').click()
  await expect(page.locator('#microfone')).toHaveValue('Headset antigo')
  await expect(page.locator('#microfone option:checked')).toHaveText('Headset antigo (desconectado)')

  await expect(page.locator('#atalhos-modo')).toBeHidden()
  await expect(page.locator('#atalhos-gnome')).toBeHidden()
  const linhas = page.locator('#atalhos .list-row')
  await expect(linhas.locator('.list-row-title')).toHaveText(['Iniciar ou parar a gravação', 'Nova nota', 'Adicionar marcador'])
  await expect(linhas.locator('kbd')).toHaveText(['Ctrl+Alt+R', 'Ctrl+Alt+N', 'Ctrl+Alt+M'])
  await expect(linhas.nth(1).locator('.list-row-sub')).toHaveText('Em uso por outro app')
  await expect(linhas.nth(1).locator('.list-row-sub')).toHaveAttribute('data-problema', '')

  const marcador = page.locator('#atalhos [data-atalho="marker"]')
  await marcador.getByRole('button', { name: 'Alterar' }).click()
  await expect(marcador.locator('kbd')).toHaveText('Pressione a combinação…')
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-vista="configuracoes"]')).toBeVisible()
  await expect(marcador.locator('kbd')).toHaveText('Ctrl+Alt+M')

  await marcador.getByRole('button', { name: 'Alterar' }).click()
  await page.keyboard.press('j')
  await expect(page.locator('#config-aviso')).toContainText('Use Ctrl, Alt, Shift ou ⌘')
  await page.keyboard.press('Control+Alt+KeyJ')
  await expect(marcador.locator('kbd')).toHaveText('Ctrl+Alt+J')
  const entrada = await ultimaEntrada(page)
  expect(entrada.shortcuts).toEqual({ record: 'Ctrl+Alt+R', note: 'Ctrl+Alt+N', marker: 'Ctrl+Alt+J' })
})

test('Sincronização: vem desligada, escolhe a pasta, liga e explica coleções, Obsidian e agente', async ({ abrir }) => {
  const page = await abrir()
  await page.locator('#abrir-configuracoes').click()
  await page.locator('[data-aba="pasta"]').click()
  await expect(page.locator('[data-painel="pasta"]')).toBeVisible()
  await expect(page.locator('#pasta-ligar')).not.toBeChecked()
  await expect(page.locator('#pasta-transcricoes')).toBeChecked()
  await expect(page.locator('#pasta-caminho')).toHaveText('Nenhuma')
  await expect(page.locator('#pasta-estado')).toHaveText('Desligada')
  await expect(page.locator('#pasta-agora')).toBeDisabled()

  // O texto explica o que vai para a pasta e como ela serve ao Obsidian e a agentes.
  const como = page.locator('#pasta-como')
  await expect(como).toContainText('Coleções viram subpastas, e cada uma se divide por mês')
  await expect(como).toContainText('2026-09-18_1100_01928f3a.md')
  await expect(como).toContainText('O título fica dentro do arquivo')
  await expect(como).toContainText('sem-colecao')
  await expect(como).toContainText('Vault do Obsidian')
  await expect(como).toContainText('AGENTS.md')
  await expect(como).toContainText('É um espelho')

  // Ligar sem pasta é recusado e a chave volta.
  await page.locator('label.switch', { hasText: 'Sincronizar resumos numa pasta' }).click()
  await expect(page.locator('#config-aviso.alert-error')).toContainText('Escolha a pasta dos resumos')
  await expect(page.locator('#pasta-ligar')).not.toBeChecked()

  await page.locator('#pasta-escolher').click()
  await expect(page.locator('#pasta-caminho')).toHaveText('/home/ana/Obsidian/eclume')
  expect((await ultimaEntrada(page)).mirror_dir).toBe('/home/ana/Obsidian/eclume')
  await expect(page.locator('#pasta-estado')).toHaveText('Desligada')

  await page.locator('label.switch', { hasText: 'Sincronizar resumos numa pasta' }).click()
  await expect(page.locator('#pasta-ligar')).toBeChecked()
  expect((await ultimaEntrada(page)).mirror_enabled).toBe(true)
  await expect(page.locator('#pasta-estado')).toHaveText('Aguardando o primeiro ciclo')
  await expect(page.locator('#pasta-agora')).toBeEnabled()

  await page.locator('label.switch', { hasText: 'Incluir as transcrições' }).click()
  await expect(page.locator('#pasta-transcricoes')).not.toBeChecked()
  expect((await ultimaEntrada(page)).mirror_transcripts).toBe(false)
})

test('Sincronização: "Sincronizar agora" pede um ciclo e o estado mostra o resultado; a ajuda abre o artigo', async ({ abrir }) => {
  const page = await abrir()
  await page.locator('#abrir-configuracoes').click()
  await page.locator('[data-aba="pasta"]').click()
  await page.locator('#pasta-escolher').click()
  await page.locator('label.switch', { hasText: 'Sincronizar resumos numa pasta' }).click()
  await page.locator('#pasta-agora').click()
  await expect(page.locator('#pasta-estado')).toContainText('12 gravações lidas no último ciclo')
  await expect(page.locator('#pasta-estado')).toHaveAttribute('data-status', 'synced')
  await page.locator('#pasta-ajuda').click()
  const feitas = (await chamadas(page)).filter((c) => c.comando === 'mirror_sync_now' || c.comando === 'open_help')
  expect(feitas).toEqual([
    { comando: 'mirror_sync_now', args: null },
    { comando: 'open_help', args: { article: 'pasta-sincronizada' } },
  ])
})
