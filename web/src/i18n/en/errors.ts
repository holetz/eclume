import type { Schemas } from '../../api/client'

type ProblemCode = Schemas['ProblemCode']

/** One message per API problem `code`; the `satisfies` makes a new contract code fail `tsc` until it has a text. */
const codes = {
  unauthorized: 'Your session has expired. Sign in again.',
  insufficient_scope: 'Your access does not include this action.',
  forbidden: 'You do not have permission for this action.',
  session_required: 'This action can only be done in the browser, with your session.',
  notice_required: 'Accept the privacy notice to continue.',
  not_found: 'Not found. It may have been deleted.',
  method_not_allowed: 'This action is not available here.',
  validation_failed: 'Check the form fields.',
  conflict: 'This conflicts with the current state. Reload the page and try again.',
  hash_mismatch: 'The file arrived different from what was sent. Try importing it again.',
  upload_expired: 'The upload expired. Start the import again.',
  upload_completing: 'The upload is still being completed. Wait a moment and try again.',
  rate_limited: 'Too many requests in a row. Wait a moment and try again.',
  email_taken: 'This e-mail is already registered.',
  signup_closed: 'Signup is closed on this server.',
  summary_changed: 'The summary changed in the meantime. Reload it and try again.',
  summary_missing: 'The recording has no summary yet.',
  transcript_missing: 'The recording has no transcript yet.',
  chat_busy: 'An adjustment is already in progress. Wait for it to finish.',
  invalid_pairing_code: 'The pairing code is invalid or has expired.',
  invalid_reset_link: 'The password reset link is invalid or has expired.',
  payload_too_large: 'The content is larger than the server accepts.',
  unsupported_media_type: 'This file type is not supported.',
  internal_error: 'The server did not answer. Try again in a moment.',
  quota_exceeded: 'Your account reached a usage limit. Contact the administration.',
  audio_deleted: 'The audio of this recording was deleted.',
  tag_exists: 'A tag with this name already exists.',
  skill_exists: 'A skill with this name already exists.',
  builtin_field: 'A built-in field cannot be changed this way.',
  fallback_agenda_type: 'The fallback agenda type cannot be removed.',
  not_auto: 'This value was not filled in automatically.',
  too_many_files: 'Too many files at once.',
  action_not_proposed: 'The agent did not propose this action.',
  action_expired: 'This action expired. Ask the agent again.',
  action_cancelled: 'This action was cancelled.',
  error: 'Something went wrong.',
} as const satisfies Record<ProblemCode, string>

const errors = {
  code: codes,
  validation: {
    fields: 'Check the fields: {{fields}}.',
    form: 'Check the form fields.',
  },
  quota: {
    file_bytes: 'The file is larger than your account allows ({{limit}}).',
    storage_bytes: 'Your storage reached its limit of {{limit}}. Delete old recordings to import more.',
    open_uploads: 'Your account uploads up to {{limit}} files at a time. Wait for one upload to finish and try again.',
    agent_requests_24h: 'You reached the limit of {{limit}} agent requests in 24 hours. Try again later.',
    other: 'Your account reached a usage limit. Contact the administration.',
  },
  size: {
    gigabytes: '{{value}} GB',
    megabytes: '{{value}} MB',
  },
  http: 'The server answered with an error (HTTP {{status}}).',
  network: 'No connection to the server. Check the network and try again.',
  generic: 'Something went wrong.',
} as const

export default errors
