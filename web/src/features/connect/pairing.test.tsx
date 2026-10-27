import { QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '../../app/queryClient'
import { fixtures } from '../../test/fixtures'
import { json, mockFetch } from '../../test/http'
import { anchorFrom, formatCountdown, useCreatePairingCode } from './pairing'
import { PairingCode } from './PairingCode'

// The response leaves at 14:02:18 on the server's clock; the code expires at 14:12:00 (the fixture).
const SERVER_DATE = 'Sun, 27 Sep 2026 14:02:18 GMT'

function Harness() {
  const create = useCreatePairingCode()
  const { mutate } = create
  useEffect(() => mutate(), [mutate])
  return create.data ? (
    <PairingCode pairing={create.data} onRegenerate={() => create.mutate()} regenerating={create.isPending} />
  ) : null
}

function renderHarness() {
  return render(
    <QueryClientProvider client={createQueryClient({ retry: false })}>
      <Harness />
    </QueryClientProvider>,
  )
}

function mockPairing(statuses: () => ReturnType<typeof fixtures.pairingCodeUsed>) {
  const devices = fixtures.tokenPage()
  devices.items = [
    { ...devices.items[0], id: '01928f3a-1c00-7a00-8000-000000000704', name: 'Pixel 8 · Mariana', platform: 'android' },
  ]
  return mockFetch({
    'POST /api/v1/devices/pairing-codes': () => json(fixtures.pairingCodeCreated(), 201, { Date: SERVER_DATE }),
    'GET /api/v1/devices/pairing-codes/:id': statuses,
    'GET /api/v1/tokens': () => devices,
  })
}

const pending = () => ({ ...fixtures.pairingCodeUsed(), status: 'pending' as const, token_id: null })

async function advance(ms: number) {
  await act(() => vi.advanceTimersByTimeAsync(ms))
}

beforeEach(() => {
  vi.useFakeTimers()
  // The computer's clock is 40 minutes fast: the countdown must not depend on it.
  vi.setSystemTime(new Date('2026-09-27T14:42:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('countdown anchor and format', () => {
  it('measures time by the response Date header and falls back to the local clock without it', () => {
    expect(anchorFrom('2026-09-27T14:12:00Z', SERVER_DATE, 500)).toEqual({ expiresInMs: 582_000, at: 500 })
    expect(anchorFrom('2026-09-27T14:52:00Z', null, 0).expiresInMs).toBe(600_000)
  })

  it('does not go past 10 minutes when the response Date lags behind', () => {
    expect(anchorFrom('2026-09-27T14:12:01.400Z', 'Sun, 27 Sep 2026 14:01:59 GMT', 0).expiresInMs).toBe(600_000)
  })

  it('formats as m:ss rounding down', () => {
    expect(formatCountdown(582_000)).toBe('9:42')
    expect(formatCountdown(600_900)).toBe('10:00')
    expect(formatCountdown(60_000)).toBe('1:00')
    expect(formatCountdown(999)).toBe('0:00')
    expect(formatCountdown(0)).toBe('0:00')
  })
})

describe('pairing code', () => {
  it('shows the code, counts by the server clock and switches to Pareado with the device name', async () => {
    let polls = 0
    const http = mockPairing(() => (++polls < 2 ? pending() : fixtures.pairingCodeUsed()))
    renderHarness()
    await advance(0)
    expect(screen.getByText('K7Q-4MX')).toBeInTheDocument()
    expect(screen.getByText('Vale por 9:42')).toBeInTheDocument()
    await advance(1000)
    expect(screen.getByText('Vale por 9:41')).toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'Validade do código' })).toHaveTextContent('')

    await advance(3000)
    await advance(0)
    expect(screen.getByText('Pareado: Pixel 8 · Mariana')).toBeInTheDocument()
    expect(screen.queryByText('K7Q-4MX')).not.toBeInTheDocument()
    const polled = http.requests('GET /api/v1/devices/pairing-codes/:id').length
    await advance(9000)
    expect(http.requests('GET /api/v1/devices/pairing-codes/:id')).toHaveLength(polled)
    const tokens = http.requests('GET /api/v1/tokens')
    expect(new URL(tokens[0].url).searchParams.get('kind')).toBe('device')
  })

  it('warns in the last minute, expires at zero, stops polling and generates another', async () => {
    const http = mockPairing(pending)
    renderHarness()
    await advance(0)
    await advance(522_000)
    expect(screen.getByText('Vale por 1:00')).toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'Validade do código' })).toHaveTextContent('Falta 1 minuto')

    await advance(60_000)
    expect(screen.getByRole('button', { name: 'Gerar outro' })).toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'Validade do código' })).toHaveTextContent('Código vencido')
    const polled = http.requests('GET /api/v1/devices/pairing-codes/:id').length
    await advance(9000)
    expect(http.requests('GET /api/v1/devices/pairing-codes/:id')).toHaveLength(polled)

    await act(async () => screen.getByRole('button', { name: 'Gerar outro' }).click())
    await advance(0)
    expect(http.requests('POST /api/v1/devices/pairing-codes')).toHaveLength(2)
    expect(screen.getByText('Vale por 9:42')).toBeInTheDocument()
  })
})
