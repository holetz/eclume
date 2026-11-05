import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach } from 'vitest'
import { setLocale } from './i18n'

Object.defineProperty(navigator, 'languages', { value: ['pt-BR'], configurable: true })
beforeEach(() => setLocale('pt-BR'))

// Without `globals`, Testing Library does not unmount by itself between the tests.
afterEach(cleanup)
