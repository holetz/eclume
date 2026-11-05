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
  },
  "help": {
    "title": "Help",
    "firstSteps": "First steps",
    "permissions": "Microphone permissions",
    "folder": "Synced folder",
    "shortcuts": "Keyboard shortcuts",
    "center": "Open the help center",
    "problem": "Report a problem…",
    "attachLog": "Attach eclume.log",
    "close": "Close",
    "global": "Anywhere on this computer",
    "window": "In this window",
    "change": "Change shortcuts in settings",
    "import": "Import file",
    "settings": "Settings",
    "version": "eclume {version} · up to date",
    "shortcut": {
      "record": "Start / stop recording",
      "note": "New voice note",
      "marker": "Add marker"
    }
  },
  "home": {
    "settings": "Settings",
    "loading": "Loading…",
    "startRecording": "Start recording",
    "automatic": "Started automatically. Stops when the meeting ends.",
    "import": "Import file…",
    "policySettings": "Change in settings",
    "policy": {
      "record": "Record",
      "ask": "Ask",
      "ignore": "Ignore"
    },
    "meetingDetected": "Meeting detected",
    "notNow": "Not now",
    "uploadQueue": "Upload queue",
    "today": "Today, {time}",
    "yesterday": "Yesterday, {time}",
    "recording": "Recording{origin}{elapsed}",
    "meeting": "Meeting in {app}",
    "updated": "Updated to {version}",
    "policyTitle": "Meetings in {app}",
    "prompt": "{app} is using the microphone. Record?",
    "detecting": "Idle, watching for meetings",
    "allUploaded": "Everything uploaded",
    "interrupted": "interrupted",
    "gotIt": "Got it",
    "error": "Something went wrong",
    "notice": "Notice",
    "upload": "Upload",
    "stopRecording": "Stop recording",
    "tokenAccount": "Connected with a personal token",
    "signOut": "Sign out",
    "server": "Server",
    "uploading": {
      "one": "Uploading 1 recording",
      "other": "Uploading {count} recordings"
    },
    "idleQueue": {
      "one": "Idle · 1 recording queued",
      "other": "Idle · {count} recordings queued"
    },
    "queueSummary": {
      "one": "{uploaded} of {count} uploaded",
      "other": "{uploaded} of {count} uploaded"
    }
  },
  "recent": {
    "label": "Recent recordings",
    "title": "Recent",
    "empty": "No recordings yet.",
    "summaryReady": "Summary ready",
    "noSummary": "Ready without a summary",
    "summaryFailed": "Summary failed",
    "transcriptionFailed": "Transcription failed",
    "needsYou": "Needs you",
    "uploadFailed": "Upload failed; the app will retry automatically.",
    "retrySummary": "Open on the web to generate the summary again.",
    "seeReason": "Open on the web to see why.",
    "transientFailure": "Temporary failure; the server will retry.",
    "recording": "Recording",
    "summaryCopied": "Summary copied as Markdown.",
    "copied": "Copied",
    "copySummary": "Copy summary",
    "uploading": "Uploading…",
    "tryNow": "Try now",
    "openWeb": "Open on the web",
    "noResponse": "No response from the server; retrying.",
    "alertCount": {
      "one": "1 needs you",
      "other": "{count} need you"
    },
    "resolveWeb": "{stage}{state}{reason} · resolve on the web.",
    "progress": "Transcription {percent}%"
  },
  "note": {
    "marker": "Marker",
    "placeholder": "Short note (optional)",
    "new": "New note",
    "stopAfter": " · stops after {seconds} s of silence",
    "recording": "Recording a note{stop}",
    "silence": "Silence · stops in {seconds} s",
    "stop": "Stop note · {time}",
    "markerLabel": "Marker note at {time}",
    "label": "Note",
    "markerCount": {
      "one": "1 marker",
      "other": "{count} markers"
    }
  },
  "firstRun": {
    "title": "Welcome",
    "back": "Back",
    "searching": "Looking for the server on the network…",
    "server": "Server",
    "trustTitle": "Check with your server administrator",
    "fingerprintPrefix": "The certificate fingerprint for ",
    "fingerprintSuffix": " is:",
    "trustContinue": "Trust and continue",
    "email": "Email",
    "password": "Password",
    "signIn": "Sign in",
    "noAccount": "No account?",
    "signUp": "Create one on the web",
    "advanced": "Advanced",
    "advancedHint": "Sign in with a code or enter the address",
    "pairingCode": "Pairing code",
    "pairingPlaceholder": "K7Q-4MX",
    "pair": "Sign in with the code",
    "pairingHint": "Generate the code on the web, under My settings › Desktop app. Valid for 10 minutes.",
    "address": "Server address",
    "addressPlaceholder": "server.local:8443",
    "useAddress": "Use this address",
    "searchAgain": "Search the network again",
    "serverLabel": "{name} on {host}",
    "origins": {
      "installer": "Came with this installer",
      "network": "Found on the network",
      "typed": "Entered address"
    },
    "useAnother": "Use another",
    "noServers": "No server on the network. Enter the address under Advanced.",
    "missingCode": "Enter the 6-character code shown on the web.",
    "invalidAddress": "Invalid address: enter the server host, with or without https.",
    "chooseServer": "Choose the server before creating an account."
  },
  "import": {
    "title": "Import a file",
    "close": "Close",
    "drop": "Drop audio or video here",
    "or": "or",
    "choose": "choose a file",
    "converting": "Converting to Opus…",
    "confirm": "Add to upload queue",
    "cancel": "Cancel",
    "errorTitle": "Could not import",
    "dateOrigin": {
      "fileMtime": "Recorded on · file modification date; please check.",
      "metadata": "Recorded on · read from the file. Change it if incorrect."
    },
    "noAudio": "{name} has no audio."
  }
};
