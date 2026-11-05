import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import App from '../app/App'
import { baseState, fakeBridge } from '../bridge/fake'
import { BridgeContext } from '../bridge/bridge'
import type { AppState } from '../bridge/types'

const SERVER = { url: 'https://192.0.2.10:8443', nome: 'eclume', ca_sha256: 'ab'.repeat(32) }

function openApp(state: AppState, route = '/') {
  window.location.hash = route
  const bridge = fakeBridge(state)
  render(
    <BridgeContext.Provider value={bridge}>
      <App />
    </BridgeContext.Provider>,
  )
  return bridge
}

describe('first run', () => {
  beforeEach(() => {
    window.location.hash = ''
  })

  it('finds the server on the network and connects through the announcement', async () => {
    const bridge = fakeBridge(baseState({ conexao: { fase: 'sem_servidor' } }))
    bridge.discover = async (seconds) => {
      expect(seconds).toBe(10)
      return [{ nome: 'eclume', url: SERVER.url, ca_sha256: SERVER.ca_sha256 }]
    }
    render(
      <BridgeContext.Provider value={bridge}>
        <App />
      </BridgeContext.Provider>,
    )
    expect(await screen.findByRole('heading', { name: 'Encontre o seu servidor' })).toBeInTheDocument()
    expect(await screen.findByText('192.0.2.10:8443')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Conectar' }))
    expect(bridge.connectDiscovered).toHaveBeenCalledWith(SERVER.url, SERVER.ca_sha256)
  })

  it('with no answer on the network, offers the code and the address', async () => {
    openApp(baseState({ conexao: { fase: 'sem_servidor' } }))
    expect(await screen.findByText(/Nenhum servidor respondeu/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Digitar o endereço' }))
    expect(await screen.findByRole('heading', { name: 'Digite o endereço' })).toBeInTheDocument()
  })

  it('types the address and checks the fingerprint before trusting', async () => {
    const bridge = openApp(baseState({ conexao: { fase: 'sem_servidor' } }), '/server/address')
    await userEvent.type(await screen.findByLabelText('Endereço do servidor'), '192.0.2.10:8443')
    await userEvent.click(screen.getByRole('button', { name: 'Continuar' }))
    expect(bridge.connectAddress).toHaveBeenCalledWith('192.0.2.10:8443')

    act(() =>
      bridge.emit(
        baseState({
          conexao: { fase: 'confirmar_ca', url: SERVER.url, impressao: '3F9A 12C4 0B7D' },
        }),
      ),
    )
    expect(await screen.findByRole('heading', { name: 'Confira o servidor' })).toBeInTheDocument()
    expect(screen.getByLabelText('Impressão digital do certificado')).toHaveTextContent('3F9A 12C4 0B7D')
    await userEvent.click(screen.getByRole('button', { name: 'Confiar' }))
    expect(bridge.trustCa).toHaveBeenCalled()
  })

  it('shows the reason when the server refuses', async () => {
    const bridge = openApp(baseState({ conexao: { fase: 'sem_servidor' } }), '/server/address')
    bridge.connectAddress = async () => {
      throw 'não foi possível falar com o servidor em https://10.0.0.9'
    }
    await userEvent.type(await screen.findByLabelText('Endereço do servidor'), '10.0.0.9')
    await userEvent.click(screen.getByRole('button', { name: 'Continuar' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('não foi possível falar')
  })

  it('signs in with e-mail and password and shows the server refusal', async () => {
    const bridge = openApp(baseState({ conexao: { fase: 'sem_credencial', servidor: SERVER } }))
    expect(await screen.findByRole('heading', { name: 'Entrar' })).toBeInTheDocument()
    expect(screen.getByText('192.0.2.10:8443')).toBeInTheDocument()
    bridge.signIn = async () => {
      throw 'Aceite o aviso de responsabilidade na web do eclume e entre de novo aqui'
    }
    await userEvent.type(screen.getByLabelText('E-mail'), 'ana@eclume.test')
    await userEvent.type(screen.getByLabelText('Senha'), 'segredo')
    await userEvent.click(screen.getByRole('button', { name: 'Entrar' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Aceite o aviso')
  })

  it('without a reason, the sign-in screen shows no warning', async () => {
    openApp(baseState({ conexao: { fase: 'sem_credencial', servidor: SERVER } }))
    expect(await screen.findByRole('heading', { name: 'Entrar' })).toBeInTheDocument()
    expect(document.querySelector('.alert-warning')).toBeNull()
  })

  it('shows why the credential was erased above the form', async () => {
    const reason = 'O certificado guardado deste servidor tinha um certificado a mais'
    openApp(baseState({ conexao: { fase: 'sem_credencial', servidor: SERVER, motivo: reason } }))
    expect(await screen.findByRole('heading', { name: 'Entrar' })).toBeInTheDocument()
    const warning = screen.getByText(reason)
    expect(warning.closest('.alert-warning')).not.toBeNull()
  })

  it('reads the web code and pairs without a password', async () => {
    const bridge = fakeBridge(baseState({ conexao: { fase: 'sem_servidor' } }))
    const qr = `${SERVER.url}/parear?codigo=K7Q4MX&ca=${SERVER.ca_sha256}`
    bridge.scanCode = async () => qr
    window.location.hash = '/scan-code'
    render(
      <BridgeContext.Provider value={bridge}>
        <App />
      </BridgeContext.Provider>,
    )
    expect(await screen.findByRole('heading', { name: 'Leia o código' })).toBeInTheDocument()
    expect(screen.getByText(/O código vale 10 minutos/)).toBeInTheDocument()
    await waitFor(() => expect(bridge.pair).toHaveBeenCalledWith(qr))
  })
})
