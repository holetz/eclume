// Commit time of the long transcript in Chromium (npm run test:browser, on the build host): with
// 3,000 segments, an audio tick that does not change the active segment and one that does fit in a frame.
import { QueryClientProvider } from '@tanstack/react-query'
import { Profiler, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { createMemoryRouter } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { describe, expect, it } from 'vitest'
import { server } from 'vitest/browser'
import { createQueryClient } from '../../app/queryClient'
import { startI18n } from '../../i18n'
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

describe('long transcript in the browser', () => {
  it('a tick without a segment change commits in under 8 ms and the change in under 16 ms (median of 20)', async ({ skip }) => {
    // The threshold is Chromium's (the engine most users have); the other engines run the list
    // in the render tests and in the E2E smoke.
    skip(server.browser !== 'chromium', 'a medida de commit é contrato só no Chromium')
    // The browser project has no setup file: start the catalogs, in pt-BR like the unit tests, so the
    // list carries its label and not the bare key.
    await startI18n('pt-BR')
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
    // The <audio> with no server fails and renews once: let it settle before measuring.
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
    // The segment change does commit (the measure catches the tick's commits).
    expect(median(change)).toBeGreaterThan(0)
    console.info(`commit por tick: sem troca ${median(same).toFixed(2)} ms, com troca ${median(change).toFixed(2)} ms`)
    expect(median(same)).toBeLessThan(8)
    expect(median(change)).toBeLessThan(16)
  })
})
