// Verificação visual: cada vista nos dois tamanhos da janela (520 × 600, o padrão, e 380 × 420, o
// menor útil) e nos dois temas. Confere as fontes do app, nenhuma requisição externa, nenhuma
// rolagem horizontal, os cantos retos do DS e o botão de gravar no --color-rec, e grava a captura
// em capturas/<vista>-<tamanho>-<tema>.png para revisão.
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'

const CAPTURAS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'capturas')

const TAMANHOS = [
  { nome: '520x600', width: 520, height: 600 },
  { nome: '380x420', width: 380, height: 420 },
]

const TEMAS = [
  { nome: 'claro', esquema: 'light' },
  { nome: 'escuro', esquema: 'dark' },
] as const

type Vista = { nome: string; cenario: string; pronta: string; ir?: (page: Page) => Promise<void> }

const aba = (nome: string) => async (page: Page) => {
  await page.keyboard.press('Control+,')
  await page.locator(`[data-aba="${nome}"]`).click()
}

const VISTAS: Vista[] = [
  { nome: 'principal', cenario: 'fila', pronta: '#fila li' },
  { nome: 'gravando', cenario: 'marcadores', pronta: '#contagem-marcadores' },
  { nome: 'nota', cenario: 'nota', pronta: '#nota-silencio' },
  { nome: 'atualizado', cenario: 'atualizado', pronta: '#atualizado' },
  { nome: 'primeira-execucao', cenario: 'primeiraExecucao', pronta: '#bv-servidores .choice' },
  {
    nome: 'primeira-execucao-conferir',
    cenario: 'primeiraExecucao',
    pronta: '#bv-confianca',
    ir: async (page) => page.locator('#bv-servidores .choice').nth(1).click(),
  },
  {
    nome: 'importar',
    cenario: 'ocioso',
    pronta: '#importar-arquivo',
    ir: async (page) => {
      await page.keyboard.press('Control+o')
      await page.locator('#importar-escolher').click()
    },
  },
  { nome: 'config-reunioes', cenario: 'ocioso', pronta: '#apps .list-row', ir: aba('reunioes') },
  { nome: 'config-audio', cenario: 'ocioso', pronta: '#atalhos .list-row', ir: aba('audio') },
  { nome: 'config-armazenamento', cenario: 'ocioso', pronta: '#espaco-usado:not(:empty)', ir: aba('armazenamento') },
  { nome: 'config-pasta', cenario: 'ocioso', pronta: '#pasta-regras li', ir: aba('pasta') },
  { nome: 'config-servidor', cenario: 'ocioso', pronta: '#servidor-conta:not(:empty)', ir: aba('servidor') },
  {
    nome: 'atalhos',
    cenario: 'ocioso',
    pronta: '#atalhos-globais dt',
    ir: async (page) => page.keyboard.press('Control+/'),
  },
  {
    nome: 'menu-ajuda',
    cenario: 'ocioso',
    pronta: '#menu-ajuda:not([hidden])',
    ir: async (page) => page.locator('#abrir-ajuda').click(),
  },
]

/** Os seletores das peças do DS que precisam ter canto reto (os --radius-* valem 0). */
const RETOS = '.btn, .input, .alert, .choice, .badge, .code-block, .seg, .seg-opt, .tab, .menu, .list, .dropzone, .queue li'

for (const vista of VISTAS) {
  for (const tamanho of TAMANHOS) {
    for (const tema of TEMAS) {
      test(`${vista.nome} · ${tamanho.nome} · ${tema.nome}`, async ({ abrir, externas, page }) => {
        await page.setViewportSize({ width: tamanho.width, height: tamanho.height })
        await page.emulateMedia({ colorScheme: tema.esquema })
        await abrir(vista.cenario)
        // A primeira execução não passa pela principal: ela já é a vista pronta.
        if (vista.cenario !== 'primeiraExecucao') {
          await expect(page.locator('#linha-status')).not.toHaveText('Carregando…')
        }
        await vista.ir?.(page)
        await expect(page.locator(vista.pronta).first()).toBeVisible()
        await expect(page.locator('html')).toHaveAttribute('data-theme', tema.esquema)

        const medida = await page.evaluate(async (retos) => {
          await document.fonts.ready
          const visiveis = [...document.querySelectorAll<HTMLElement>(retos)].filter((e) => e.offsetParent !== null)
          const cor = (valor: string) => {
            const sonda = document.createElement('i')
            sonda.style.color = valor
            document.body.append(sonda)
            const resolvida = getComputedStyle(sonda).color
            sonda.remove()
            return resolvida
          }
          const gravar = document.querySelector<HTMLElement>('[data-vista]:not([hidden]) .btn-rec')
          return {
            familias: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replaceAll('"', '')),
            rolagem: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            arredondados: visiveis
              .filter((e) => getComputedStyle(e).borderRadius !== '0px')
              .map((e) => `${e.tagName.toLowerCase()}#${e.id}.${e.className}`),
            gravar: gravar && {
              cor: getComputedStyle(gravar).backgroundColor,
              esperada: cor('var(--color-rec)'),
              pressionado: gravar.getAttribute('aria-pressed'),
            },
          }
        }, RETOS)

        expect(medida.familias).toContain('Archivo')
        expect(medida.rolagem, 'rolagem horizontal').toBeLessThanOrEqual(0)
        expect(medida.arredondados).toEqual([])
        if (medida.gravar && medida.gravar.pressionado === 'false') {
          expect(medida.gravar.cor).toBe(medida.gravar.esperada)
        }
        await mkdir(CAPTURAS, { recursive: true })
        await page.screenshot({ path: path.join(CAPTURAS, `${vista.nome}-${tamanho.nome}-${tema.nome}.png`), fullPage: true })
        expect(externas).toEqual([])
      })
    }
  }
}

test('o tema escolhido vence o do sistema e volta a segui-lo em "Sistema"', async ({ abrir, page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await abrir()
  await page.locator('#abrir-configuracoes').click()
  await expect(page.locator('input[name="tema"][value="system"]')).toBeChecked()
  await page.locator('#tema .seg-opt', { hasText: 'Escuro' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  // A próxima consulta do estado não desfaz a escolha, e o sistema trocar não a vence.
  await page.waitForTimeout(1_200)
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.locator('#tema .seg-opt', { hasText: 'Claro' }).click()
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.locator('#tema .seg-opt', { hasText: 'Sistema' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
})
