import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { createMemoryRouter, Link } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { describe, expect, it } from 'vitest'
import { useLeaveGuard } from './useLeaveGuard'

function Form() {
  const [text, setText] = useState('')
  const dialog = useLeaveGuard(text !== '')
  return (
    <>
      <label>
        Texto
        <input value={text} onChange={(event) => setText(event.target.value)} />
      </label>
      <Link to="?t=30">Trecho</Link>
      <Link to="/outra">Outra</Link>
      {dialog}
    </>
  )
}

function setup() {
  const router = createMemoryRouter(
    [
      { path: '/form', element: <Form /> },
      { path: '/outra', element: <h1>Outra rota</h1> },
    ],
    { initialEntries: ['/form'] },
  )
  render(<RouterProvider router={router} />)
  return router
}

describe('leave guard', () => {
  it('without changes, leaves without asking', async () => {
    setup()
    await userEvent.click(screen.getByRole('link', { name: 'Outra' }))
    expect(await screen.findByRole('heading', { name: 'Outra rota' })).toBeInTheDocument()
  })

  it('with changes, changing only the search asks nothing', async () => {
    const router = setup()
    await userEvent.type(screen.getByLabelText('Texto'), 'oi')
    await userEvent.click(screen.getByRole('link', { name: 'Trecho' }))
    expect(router.state.location.search).toBe('?t=30')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Texto')).toHaveValue('oi')
  })

  it('with changes, another route asks for confirmation; continuing stays, discarding leaves', async () => {
    setup()
    await userEvent.type(screen.getByLabelText('Texto'), 'oi')
    await userEvent.click(screen.getByRole('link', { name: 'Outra' }))
    expect(await screen.findByRole('dialog', { name: 'Descartar alterações?' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Continuar editando' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Texto')).toHaveValue('oi')

    await userEvent.click(screen.getByRole('link', { name: 'Outra' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Descartar' }))
    expect(await screen.findByRole('heading', { name: 'Outra rota' })).toBeInTheDocument()
  })
})
