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
  },
  "settings": {
    "title": "Settings",
    "back": "Back",
    "tabs": {
      "general": "General",
      "meetings": "Meetings",
      "audio": "Audio",
      "storage": "Storage",
      "folder": "Folder",
      "server": "Server"
    },
    "appearance": "Appearance",
    "theme": "Theme",
    "themeHint": "Light, dark or follow the system",
    "themeSystem": "System",
    "themeLight": "Light",
    "themeDark": "Dark",
    "recentWindow": "Recent recordings in the window",
    "recentWindowHint": "Status, alerts and Copy summary at the top of the main window",
    "hide": "Hide",
    "recentTray": "Recent recordings in the tray menu",
    "recentTrayHint": "Title, status and actions in the icon menu next to the clock",
    "startup": "Startup",
    "startWithSystem": "Start with the computer",
    "startupHint": "eclume opens automatically in the tray when you sign in to your computer, so you never miss a meeting.",
    "notifications": "Notifications",
    "notifySummary": "Notify when a recording finishes processing",
    "notificationsHint": "For all recordings in the account: summary ready (with \"Copy\"), ready without a summary or failed.",
    "detect": "Detect meetings",
    "detectHint": "eclume watches which app uses the microphone. Recording always appears in the tray.",
    "meetingStarts": "When a meeting starts in",
    "restoreDefaults": "Restore defaults",
    "meetingStopHint": "Automatic recording stops when the meeting ends. A recording you start continues until you stop it.",
    "sources": "Sources",
    "microphone": "Microphone",
    "systemAudio": "System audio",
    "sourcesHint": "Captures the other people on the call through the speakers or headphones. Both sources become one file; \"None\" leaves one out.",
    "test": {
      "mic": "Speak to test",
      "system": "Play something to test"
    },
    "transcription": "Transcription",
    "transcriptionLanguage": "Transcription language",
    "accountDefault": "Account default",
    "languages": {
      "auto": "Detect automatically",
      "pt": "Portuguese",
      "es": "Spanish",
      "en": "English"
    },
    "transcriptionHint": "Applies to future meetings and notes you upload. Choose the account default on the web, under Account.",
    "shortcutsTitle": "Shortcuts anywhere on the computer",
    "voiceNotes": "Voice notes",
    "silence": "Stop after silence",
    "silenceHint": "Ends the note when you stop speaking",
    "never": "Never",
    "retentionTitle": "After the server confirms a recording",
    "deleteLocal": "Delete the local copy",
    "deleteLocalHint": "Frees up space immediately",
    "keepDays": "Keep for a few days",
    "keepDaysHint": "Default · up to 3650 days",
    "daysLabel": "Days",
    "days": "days",
    "keepForever": "Keep forever",
    "keepForeverHint": "Nothing is deleted from this computer",
    "retentionHint": "Recordings that have not been uploaded are never deleted.",
    "localFolder": "Local folder",
    "showFolder": "Show",
    "retry": "Retry failed uploads",
    "folderEnable": "Sync summaries to a folder",
    "folderHint": "Each recording’s summary becomes a Markdown file and its transcript a JSONL file in a folder on this computer. Applies to your entire library, including recordings made elsewhere.",
    "folderDestination": "Destination folder",
    "noneFemale": "None",
    "folderChoose": "Choose folder…",
    "folderTranscripts": "Include transcripts (.jsonl)",
    "folder": {
      "off": "Off",
      "choose": "Choose a folder to start",
      "syncing": "Syncing…",
      "waiting": "Waiting for the first cycle",
      "synced": "Synced at {time} · {loaded} in the last cycle",
      "recordings": {
        "zero": "0 recordings read",
        "one": "1 recording read",
        "other": "{count} recordings read"
      }
    },
    "folderNow": "Sync now",
    "folderLayout": "How the folder is organized",
    "folderRules": {
      "collectionsTitle": "Collections become subfolders, each divided by month.",
      "example": "Example:",
      "examplePath": "Clients/2026-09/",
      "collectionsBody": ". A recording in several collections appears in each; those without a collection go in",
      "uncollected": "sem-colecao",
      "collectionsEnd": ". Organize collections in eclume on the web.",
      "nameTitle": "Names that sort by date.",
      "nameBody": ": date, time and recording reference (the same \"ref.\" as eclume on the web). The title goes inside the file, rather than in its name.",
      "filesTitle": "Summary and transcript side by side.",
      "summaryPrefix": "The summary is a",
      "transcriptPrefix": "with properties at the top; the transcript is a",
      "filesEnd": "with the same name.",
      "obsidianTitle": "Obsidian vault.",
      "obsidianPrefix": "Open the folder as a vault: Obsidian reads",
      "obsidianMiddle": "and ignores",
      "obsidianEnd": ", so transcripts do not clutter search or the graph.",
      "agentTitle": "Agent workspace folder.",
      "agentPrefix": "The app maintains an",
      "agentEnd": "at the root explaining to an agent (such as Claude Code) how to read and search the files.",
      "mirrorTitle": "It is a mirror.",
      "mirrorBody": "eclume overwrites the files it generated; edit a copy. Your own files in the folder are never touched."
    },
    "folderHelp": "Learn more in help",
    "signIn": "Sign in with email and password",
    "signOut": "Sign out",
    "serverAddress": "Server address",
    "advanced": "Advanced",
    "advancedHint": "For servers with a separate API or their own certificate",
    "apiAddress": "API address",
    "apiPlaceholder": "Same as the server",
    "extraCa": "Extra certificate authority",
    "remove": "Remove",
    "choose": "Choose…",
    "caHint": "PEM file. Only needed when the server uses its own certificate.",
    "save": "Save",
    "testConnection": "Test connection",
    "locale": {
      "title": "Language",
      "automatic": "Automatic (account, then system)",
      "en": "English",
      "ptBR": "Portugu\u00eas (Brasil)"
    },
    "mode": {
      "portal": "Through the system shortcut portal. Confirm the combinations if asked.",
      "system": "In this session (Wayland), create a system shortcut for each command below.",
      "created": "In this session (Wayland), GNOME shortcuts call eclume.",
      "create": "In this session (Wayland), create GNOME shortcuts so eclume can receive keyboard commands."
    },
    "connection": {
      "empty": "Connected · no uploads yet",
      "upload": "Connected · last upload {time}"
    },
    "shortcutBackground": "Works with eclume in the background",
    "capture": "Press the combination…",
    "cancel": "Cancel",
    "change": "Change",
    "gnome": {
      "remove": "Remove GNOME shortcuts",
      "create": "Create GNOME shortcuts",
      "creating": "Creating shortcuts…",
      "removing": "Removing shortcuts…",
      "created": "Shortcuts created in GNOME.",
      "removed": "Shortcuts removed from GNOME."
    },
    "modifierRequired": "Use Ctrl, Alt, Shift or ⌘ with the key.",
    "systemDefault": "System default",
    "none": "None",
    "followOutput": "Follow the current output",
    "stop": "Stop",
    "account": {
      "personal": "Connected with a personal token",
      "empty": "No account on this computer",
      "replaceToken": "Sign in with email and password to replace the token with your account",
      "signInHint": "Sign in to upload recordings",
      "connected": "Connected to {server}"
    },
    "invalidDays": "Use 1 to 3650 days.",
    "retrySuccess": "Failed uploads will be retried.",
    "serverSaved": "Server settings saved.",
    "testing": "Testing…",
    "apps": {
      "teams": {
        "title": "Microsoft Teams",
        "subtitle": "App or browser tab"
      },
      "zoom": {
        "title": "Zoom",
        "subtitle": "App or browser tab"
      },
      "meet": {
        "title": "Google Meet",
        "subtitle": "Browser tab"
      },
      "webex": {
        "title": "Webex",
        "subtitle": "App or browser tab"
      },
      "slack": {
        "title": "Slack",
        "subtitle": "Calls"
      },
      "whatsapp": {
        "title": "WhatsApp",
        "subtitle": "App or WhatsApp Web tab"
      },
      "navegador": {
        "title": "Browser",
        "subtitle": "Microphone in use, meeting not recognized"
      },
      "outro": {
        "title": "Other app",
        "subtitle": "Dictation, voice recorders, games"
      }
    },
    "policy": {
      "auto": "Record",
      "ask": "Confirm",
      "ignore": "Ignore"
    },
    "accountDefaultNamed": "Account default: {name}",
    "systemDefaultNamed": "System default · {name}",
    "disconnectedMic": "{name} (disconnected)",
    "disconnectedOutput": "{name} (disconnected)",
    "shortcut": {
      "record": "Start or stop recording",
      "note": "New note",
      "marker": "Add marker"
    },
    "registration": {
      "in_use": "In use by another app",
      "unavailable": "Unavailable in this session",
      "system": "Create the shortcut in the system"
    },
    "storageUsed": {
      "zero": "0 recordings · {size} on this computer",
      "one": "1 recording · {size} on this computer",
      "other": "{count} recordings · {size} on this computer"
    }
  }
};
