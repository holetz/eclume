// Both locale files must carry the same keys.
export default {
  "common": {
    "close": "Close",
    "cancel": "Cancel",
    "save": "Save",
    "automatic": "Automatic"
  },
  "vocabulary": {
    "step": {
      "received": "Audio received",
      "preprocessing": "Preprocessing",
      "transcription": "Transcription",
      "speakers": "Speakers",
      "agenda_type": "Agenda type",
      "fields": "Fields",
      "summary": "Summary"
    },
    "busy": {
      "received": "Uploading",
      "preprocessing": "Preprocessing",
      "transcription": "Transcribing",
      "speakers": "Checking speakers",
      "agenda_type": "Detecting the type",
      "fields": "Filling fields",
      "summary": "Summarizing"
    },
    "stepState": {
      "pending": "waiting",
      "active": "in progress",
      "done": "done",
      "skipped": "skipped",
      "failed": "failed",
      "waiting": "waiting for you"
    },
    "reason": {
      "no_provider": "no agent configured; ask your administrator",
      "no_auto_fields": "no field is filled automatically",
      "no_types": "only the default type exists: it was kept",
      "set_by_user": "you chose the type",
      "no_agenda_type": "the recording has no agenda type",
      "before_pipeline": "recording made before automatic processing",
      "worker_without_preprocess": "the processor of this recording does not preprocess",
      "summary_deleted": "the summary was deleted",
      "cancelled": "the transcription was cancelled",
      "unnamed_speakers": "some speakers have no person; name them all to go on with the type, the fields and the summary",
      "continued_by_user": "you went on without naming every speaker",
      "naming_not_required": "the account no longer requires speaker names"
    },
    "device": {
      "recording": "Recording",
      "pending": "Waiting to upload",
      "uploading": "Uploading",
      "uploaded": "Uploaded",
      "interrupted": "Interrupted",
      "failed": "Upload failed"
    },
    "queue": {
      "offline": "The processor is down; your recording is saved and goes in when it is back.",
      "offlineSince": "The processor has been down since {time}; your recording is saved and goes in when it is back.",
      "accountNext": "Your account's turn: this is your next recording to enter the queue.",
      "quotaAt": "Your transcription minutes for the last 24 h are used up; the recording goes in at {time}.",
      "quotaLater": "Your transcription minutes for the last 24 h are used up; the recording goes in when the window frees up.",
      "position": "#{position} in the queue",
      "starts": "starts in {eta} (estimate)",
      "waiting": "Waiting for its turn in the transcription queue.",
      "dayTime": "{date} at {time}",
      "lessThanMinute": "less than 1 min",
      "minutes": "about {minutes} min",
      "hours": "about {hours} h",
      "hoursMinutes": "about {hours} h {minutes} min",
      "accountAhead": {
        "one": "Behind 1 recording of yours that arrived earlier.",
        "other": "Behind {count} recordings of yours that arrived earlier."
      }
    },
    "server": {
      "na_fila": "Queued",
      "em_andamento": "In progress",
      "aguardando_locutores": "Awaiting speakers",
      "pronta": "Ready",
      "falhou": "Failed",
      "cancelada": "Cancelled"
    }
  }
};
