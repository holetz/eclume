import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { fixtures } from './fixtures'
import { mockFetch } from './http'

/**
 * API of the transcribed recording page (3 speakers): transcript, summary with versions, fields,
 * markers and chat, with extra or replacement routes.
 */
export function mockTranscriptApi(extra: Parameters<typeof mockFetch>[0] = {}) {
  return mockFetch({
    'GET /api/v1/me': () => fixtures.me(),
    'GET /api/v1/recordings/:id': () => fixtures.recordingTranscribed(),
    'GET /api/v1/transcripts/:id': () => fixtures.transcript(),
    'GET /api/v1/agenda-types': () => fixtures.agendaTypePage(),
    'GET /api/v1/transcripts/:id/summaries': () => fixtures.summaryPage(),
    'GET /api/v1/collections': () => fixtures.collectionPage(),
    'GET /api/v1/people': () => fixtures.personPage(),
    'GET /api/v1/recordings/:id/summary': () => fixtures.summaryState(),
    'GET /api/v1/recordings/:id/summary/chat': () => fixtures.summaryChatPage(),
    'GET /api/v1/recordings/:id/fields': () => fixtures.recordingFieldValues(),
    'GET /api/v1/recordings/:id/markers': () => fixtures.markerPage(),
    'GET /api/v1/fields': () => fixtures.fieldPage(),
    'GET /api/v1/tags': () => fixtures.tagList(),
    ...extra,
  })
}

export const RECORDING_ID = '01928f3a-1c00-7a00-8000-000000000401'

/** Opens the collapsed transcript on the recording page. */
export async function openTranscript() {
  const summary = await screen.findByText(
    (_, element) => element?.tagName === 'SUMMARY' && Boolean(element.textContent?.startsWith('Transcrição')),
  )
  await userEvent.click(summary)
}

/** Opens the Speakers block of the recording page and returns its region. */
export async function openSpeakers() {
  const summary = await screen.findByText(
    (_, element) => element?.tagName === 'SUMMARY' && Boolean(element.textContent?.startsWith('Locutores')),
  )
  await userEvent.click(summary)
  return screen.findByRole('region', { name: 'Locutores' })
}
