import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import App from './App.tsx'

describe('App', () => {
  it('mostra o nome do produto', () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: 'eclume' })).toBeInTheDocument()
  })
})
