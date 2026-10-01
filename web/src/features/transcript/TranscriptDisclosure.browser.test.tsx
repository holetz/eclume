// Tempo de commit da transcrição longa no Chromium (npm run test:browser, no host de build): com
// 3.000 falas, um tick do áudio que não troca a fala ativa e um que troca cabem num quadro.
import { QueryClientProvider } from '@tanstack/react-query'
import { Profiler, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { createMemoryRouter } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { describe, expect, it } from 'vitest'
import { createQueryClient } from '../../app/queryClient'
import { fixtures } from '../../test/fixtures'
import { usePlayback, type PlaybackClock } from './playback'
import { PlaybackProvider } from './PlaybackProvider'
import { TranscriptDisclosure } from './TranscriptDisclosure'

const COUNT = 3000
const STEP_MS = 4000
const TICKS = 20

function longTranscript() {
  const base = fixtures.transcript()
  const segments = Array.from({ length: COUNT }, (_, index) => {
    const model = base.segments[index % base.segments.length]
    return { ...model, id: `fala-${index}`, start_ms: index * STEP_MS, end_ms: index * STEP_MS + STEP_MS - 1 }
  })
  return { ...base, segments }
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('transcrição longa no navegador', () => {
  it('tick sem troca de fala comita em menos de 8 ms e a troca em menos de 16 ms (mediana de 20)', async () => {
    let clock: PlaybackClock | null = null
    let commitMs = 0
    function GrabClock({ children }: { children: ReactNode }) {
      clock = usePlayback().clock
      return children
    }
    const transcript = longTranscript()
    const router = createMemoryRouter(
      [
        {
          path: '*',
          element: (
            <PlaybackProvider recordingId="gravacao-longa" durationMs={COUNT * STEP_MS}>
              <GrabClock>
                <Profiler id="transcricao" onRender={(_, __, actualDuration) => (commitMs += actualDuration)}>
                  <TranscriptDisclosure
                    transcript={transcript}
                    markers={[]}
                    recordingId="gravacao-longa"
                    open
                    onOpenChange={() => {}}
                  />
                </Profiler>
              </GrabClock>
            </PlaybackProvider>
          ),
        },
      ],
      { initialEntries: ['/'] },
    )
    const host = document.createElement('div')
    document.body.append(host)
    createRoot(host).render(
      <QueryClientProvider client={createQueryClient({ retry: false })}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    )
    while (document.querySelectorAll('[role="list"][aria-label="Falas"] > *').length < COUNT) await settle()
    // O <audio> sem servidor falha e renova uma vez: deixa assentar antes de medir.
    await new Promise((resolve) => setTimeout(resolve, 500))

    async function measure(ms: number) {
      commitMs = 0
      clock!.set(ms)
      await settle()
      return commitMs
    }

    const same: number[] = []
    const change: number[] = []
    for (let tick = 0; tick < TICKS; tick++) {
      const segment = 100 + tick
      change.push(await measure(segment * STEP_MS + 100))
      same.push(await measure(segment * STEP_MS + 600))
    }
    // A troca de fala comita de fato (a medida pega os commits do tick).
    expect(median(change)).toBeGreaterThan(0)
    console.info(`commit por tick: sem troca ${median(same).toFixed(2)} ms, com troca ${median(change).toFixed(2)} ms`)
    expect(median(same)).toBeLessThan(8)
    expect(median(change)).toBeLessThan(16)
  })
})
