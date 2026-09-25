import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App.tsx'
import { problem, mockFetch } from './test/http'

describe('App', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sem sessão, abre o login', async () => {
    mockFetch({ 'GET /api/v1/me': () => problem('unauthorized', 401) })
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Entrar' })).toBeInTheDocument()
  })
})
