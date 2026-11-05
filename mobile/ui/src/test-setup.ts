import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// Without `globals`, Testing Library does not unmount by itself between the tests.
afterEach(cleanup)
