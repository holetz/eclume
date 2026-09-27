import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import App from './App.tsx'

describe('App', () => {
  it('mostra a marca', () => {
    render(<App />)
    expect(screen.getByText('eclume')).toBeInTheDocument()
  })
})
