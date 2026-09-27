import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import App from '../app/App'
import { estadoBase, ponteFalsa } from '../ponte/falsa'
import { PonteContexto } from '../ponte/ponte'
import type { EstadoApp } from '../ponte/tipos'

const SERVIDOR = { url: 'https://192.168.15.199:8443', nome: 'eclume', ca_sha256: 'ab'.repeat(32) }

function abrir(estado: EstadoApp, rota = '/') {
  window.location.hash = rota
  const ponte = ponteFalsa(estado)
  render(
    <PonteContexto.Provider value={ponte}>
      <App />
    </PonteContexto.Provider>,
  )
  return ponte
}

describe('primeira execução', () => {
  beforeEach(() => {
    window.location.hash = ''
  })

  it('acha o servidor na rede e conecta pelo anúncio', async () => {
    const ponte = ponteFalsa(estadoBase({ conexao: { fase: 'sem_servidor' } }))
    ponte.descobrir = async (segundos) => {
      expect(segundos).toBe(10)
      return [{ nome: 'eclume', url: SERVIDOR.url, ca_sha256: SERVIDOR.ca_sha256 }]
    }
    render(
      <PonteContexto.Provider value={ponte}>
        <App />
      </PonteContexto.Provider>,
    )
    expect(await screen.findByRole('heading', { name: 'Encontre o seu servidor' })).toBeInTheDocument()
    expect(await screen.findByText('192.168.15.199:8443')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Conectar' }))
    expect(ponte.conectarDescoberto).toHaveBeenCalledWith(SERVIDOR.url, SERVIDOR.ca_sha256)
  })

  it('sem resposta na rede, oferece o código e o endereço', async () => {
    abrir(estadoBase({ conexao: { fase: 'sem_servidor' } }))
    expect(await screen.findByText(/Nenhum servidor respondeu/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Digitar o endereço' }))
    expect(await screen.findByRole('heading', { name: 'Digite o endereço' })).toBeInTheDocument()
  })

  it('digita o endereço e confere a impressão digital antes de confiar', async () => {
    const ponte = abrir(estadoBase({ conexao: { fase: 'sem_servidor' } }), '/servidor/endereco')
    await userEvent.type(await screen.findByLabelText('Endereço do servidor'), '192.168.15.199:8443')
    await userEvent.click(screen.getByRole('button', { name: 'Continuar' }))
    expect(ponte.conectarEndereco).toHaveBeenCalledWith('192.168.15.199:8443')

    act(() =>
      ponte.emitir(
        estadoBase({
          conexao: { fase: 'confirmar_ca', url: SERVIDOR.url, impressao: '3F9A 12C4 0B7D' },
        }),
      ),
    )
    expect(await screen.findByRole('heading', { name: 'Confira o servidor' })).toBeInTheDocument()
    expect(screen.getByLabelText('Impressão digital do certificado')).toHaveTextContent('3F9A 12C4 0B7D')
    await userEvent.click(screen.getByRole('button', { name: 'Confiar' }))
    expect(ponte.confiarCa).toHaveBeenCalled()
  })

  it('mostra o motivo quando o servidor recusa', async () => {
    const ponte = abrir(estadoBase({ conexao: { fase: 'sem_servidor' } }), '/servidor/endereco')
    ponte.conectarEndereco = async () => {
      throw 'não foi possível falar com o servidor em https://10.0.0.9'
    }
    await userEvent.type(await screen.findByLabelText('Endereço do servidor'), '10.0.0.9')
    await userEvent.click(screen.getByRole('button', { name: 'Continuar' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('não foi possível falar')
  })

  it('entra com e-mail e senha e mostra a recusa do servidor', async () => {
    const ponte = abrir(estadoBase({ conexao: { fase: 'sem_credencial', servidor: SERVIDOR } }))
    expect(await screen.findByRole('heading', { name: 'Entrar' })).toBeInTheDocument()
    expect(screen.getByText('192.168.15.199:8443')).toBeInTheDocument()
    ponte.entrar = async () => {
      throw 'Aceite o aviso de responsabilidade na web do eclume e entre de novo aqui'
    }
    await userEvent.type(screen.getByLabelText('E-mail'), 'ana@eclume.test')
    await userEvent.type(screen.getByLabelText('Senha'), 'segredo')
    await userEvent.click(screen.getByRole('button', { name: 'Entrar' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Aceite o aviso')
  })

  it('lê o código da web e pareia sem senha', async () => {
    const ponte = ponteFalsa(estadoBase({ conexao: { fase: 'sem_servidor' } }))
    const qr = `${SERVIDOR.url}/parear?codigo=K7Q4MX&ca=${SERVIDOR.ca_sha256}`
    ponte.lerCodigo = async () => qr
    window.location.hash = '/ler-codigo'
    render(
      <PonteContexto.Provider value={ponte}>
        <App />
      </PonteContexto.Provider>,
    )
    expect(await screen.findByRole('heading', { name: 'Leia o código' })).toBeInTheDocument()
    expect(screen.getByText(/O código vale 10 minutos/)).toBeInTheDocument()
    await waitFor(() => expect(ponte.parear).toHaveBeenCalledWith(qr))
  })
})
