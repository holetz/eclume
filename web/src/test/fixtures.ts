// Fixtures do contrato (contracts/fixtures/), tipadas pelo schema gerado. Os testes usam os
// mesmos exemplos que o mock server serve.
import type { Schemas } from '../api/client'
import adminHealth from '../../../contracts/fixtures/admin-health.json'
import adminMe from '../../../contracts/fixtures/admin-me.json'
import adminSettings from '../../../contracts/fixtures/admin-settings.json'
import adminUserPage from '../../../contracts/fixtures/admin-user-page.json'
import agentProviderPage from '../../../contracts/fixtures/agent-provider-page.json'
import collectionPage from '../../../contracts/fixtures/collection-page.json'
import meViaPat from '../../../contracts/fixtures/me-via-pat.json'
import partUrls from '../../../contracts/fixtures/part-urls.json'
import person from '../../../contracts/fixtures/person.json'
import personPage from '../../../contracts/fixtures/person-page.json'
import recordingPage from '../../../contracts/fixtures/recording-page.json'
import recordingQueued from '../../../contracts/fixtures/recording-queued.json'
import recordingTranscribed from '../../../contracts/fixtures/recording-transcribed.json'
import secretList from '../../../contracts/fixtures/secret-list.json'
import signupInfo from '../../../contracts/fixtures/signup-info.json'
import signupRequest from '../../../contracts/fixtures/signup-request.json'
import searchPage from '../../../contracts/fixtures/search-page.json'
import speakerLinked from '../../../contracts/fixtures/speaker-linked.json'
import summaryDone from '../../../contracts/fixtures/summary-done.json'
import summaryPage from '../../../contracts/fixtures/summary-page.json'
import summaryQueued from '../../../contracts/fixtures/summary-queued.json'
import summaryTemplatePage from '../../../contracts/fixtures/summary-template-page.json'
import tagList from '../../../contracts/fixtures/tag-list.json'
import tokenCreated from '../../../contracts/fixtures/token-created.json'
import tokenPage from '../../../contracts/fixtures/token-page.json'
import transcript from '../../../contracts/fixtures/transcript-3-locutores.json'
import transcriptPage from '../../../contracts/fixtures/transcript-page.json'
import uploadCreated from '../../../contracts/fixtures/upload-created.json'
import uploadDeduplicated from '../../../contracts/fixtures/upload-deduplicated.json'
import uploadInProgress from '../../../contracts/fixtures/upload-in-progress.json'
import voiceprint from '../../../contracts/fixtures/voiceprint.json'

type Transcript = import('../api/schema.gen').operations['getTranscript']['responses'][200]['content']['application/json']

/** Cópia profunda, para um teste poder alterar a fixture sem afetar os outros. */
function fresh<T>(value: unknown): () => T {
  return () => structuredClone(value) as T
}

export const fixtures = {
  me: fresh<Schemas['Me']>({
    ...meViaPat,
    auth: { method: 'session', scopes: [], token_id: null },
  }),
  signupInfo: fresh<Schemas['SignupInfo']>(signupInfo),
  signupRequest: fresh<Schemas['SignupRequest']>(signupRequest),
  recordingPage: fresh<Schemas['RecordingPage']>(recordingPage),
  recordingQueued: fresh<Schemas['Recording']>(recordingQueued),
  recordingTranscribed: fresh<Schemas['Recording']>(recordingTranscribed),
  transcript: fresh<Transcript>(transcript),
  transcriptPage: fresh<Schemas['TranscriptPage']>(transcriptPage),
  speakerLinked: fresh<Transcript['speakers'][number]>(speakerLinked),
  summaryPage: fresh<Schemas['SummaryPage']>(summaryPage),
  summaryQueued: fresh<Schemas['Summary']>(summaryQueued),
  summaryDone: fresh<Schemas['Summary']>(summaryDone),
  summaryTemplatePage: fresh<Schemas['SummaryTemplatePage']>(summaryTemplatePage),
  tokenPage: fresh<Schemas['TokenPage']>(tokenPage),
  tokenCreated: fresh<Schemas['TokenCreated']>(tokenCreated),
  uploadCreated: fresh<Schemas['Upload']>(uploadCreated),
  uploadDeduplicated: fresh<Schemas['Upload']>(uploadDeduplicated),
  uploadInProgress: fresh<Schemas['Upload']>(uploadInProgress),
  partUrls: fresh<Schemas['PartUrls']>(partUrls),
  adminSettings: fresh<Schemas['AdminSettings']>(adminSettings),
  adminHealth: fresh<Schemas['AdminHealth']>(adminHealth),
  agentProviderPage: fresh<Schemas['AgentProviderPage']>(agentProviderPage),
  secretList: fresh<Schemas['SecretList']>(secretList),
  adminMe: fresh<Schemas['AdminAccount']>(adminMe),
  adminUserPage: fresh<Schemas['AdminUserPage']>(adminUserPage),
  person: fresh<Schemas['Person']>(person),
  personPage: fresh<Schemas['PersonPage']>(personPage),
  searchPage: fresh<Schemas['SearchPage']>(searchPage),
  collectionPage: fresh<Schemas['CollectionPage']>(collectionPage),
  tagList: fresh<Schemas['TagList']>(tagList),
  voiceprint: fresh<Schemas['Voiceprint']>(voiceprint),
}
