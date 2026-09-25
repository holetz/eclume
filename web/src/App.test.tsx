import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import App from './App.tsx'

describe('App', () => {
  it('abre o shell com a navegação principal', () => {
    render(<App />)
    expect(screen.getByRole('navigation', { name: 'Principal' })).toBeInTheDocument()
  })
})
