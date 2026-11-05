//! Supported desktop locales, preference resolution and native text catalog.

use eclume_detect::AppKey;
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum Locale {
    #[serde(rename = "en")]
    En,
    #[serde(rename = "pt-BR")]
    PtBr,
}

impl Locale {
    pub fn tag(self) -> &'static str {
        match self {
            Self::En => "en",
            Self::PtBr => "pt-BR",
        }
    }
}

pub fn normalize(tag: &str) -> Option<Locale> {
    let tag = tag.trim().replace('_', "-");
    match tag.split('-').next()?.to_lowercase().as_str() {
        "pt" => Some(Locale::PtBr),
        "en" => Some(Locale::En),
        _ => None,
    }
}

pub fn resolve(choice: Option<&str>, account: Option<&str>, system: Option<&str>) -> Locale {
    [choice, account, system]
        .into_iter()
        .flatten()
        .find_map(normalize)
        .unwrap_or(Locale::En)
}

/// Environment fallback until the window reports the OS language.
pub fn env_locale() -> Option<String> {
    #[cfg(unix)]
    {
        first_set(|key| std::env::var(key).ok())
    }
    #[cfg(not(unix))]
    {
        None
    }
}

/// The first non-empty of `LC_ALL`, `LC_MESSAGES` and `LANG`, as POSIX orders them: a higher one
/// overrides the rest even when it names an unsupported language (`LC_ALL=C` resolves to `en`).
#[cfg_attr(not(unix), allow(dead_code))]
fn first_set(var: impl Fn(&str) -> Option<String>) -> Option<String> {
    ["LC_ALL", "LC_MESSAGES", "LANG"]
        .into_iter()
        .filter_map(var)
        .find(|tag| !tag.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn environment_follows_posix_precedence() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |key: &str| {
                pairs
                    .iter()
                    .find(|(name, _)| *name == key)
                    .map(|(_, value)| value.to_string())
            }
        };
        assert_eq!(
            first_set(env(&[("LC_ALL", "C"), ("LANG", "pt_BR.UTF-8")])).as_deref(),
            Some("C")
        );
        assert_eq!(
            resolve(None, None, first_set(env(&[("LC_ALL", "C"), ("LANG", "pt_BR.UTF-8")])).as_deref()),
            Locale::En
        );
        assert_eq!(
            first_set(env(&[("LC_ALL", ""), ("LANG", "pt_BR.UTF-8")])).as_deref(),
            Some("pt_BR.UTF-8")
        );
        assert_eq!(first_set(env(&[])), None);
    }

    #[test]
    fn generic_app_names_follow_locale() {
        assert_eq!(Locale::En.app_label(AppKey::Navegador), "browser");
        assert_eq!(Locale::En.app_label(AppKey::Outro), "another app");
        assert_eq!(Locale::PtBr.app_label(AppKey::Navegador), "navegador");
        assert_eq!(Locale::PtBr.app_label(AppKey::Outro), "outro app");
        assert_eq!(Locale::En.app_label(AppKey::Teams), "Microsoft Teams");
    }

    #[test]
    fn normalizes_supported_language_subtags() {
        for tag in ["pt", "pt-BR", "pt-PT", " pt_BR.UTF-8 ", "PT_br"] {
            assert_eq!(normalize(tag), Some(Locale::PtBr), "{tag}");
        }
        for tag in ["en", "en-US", " EN_gb "] {
            assert_eq!(normalize(tag), Some(Locale::En), "{tag}");
        }
        for tag in ["", "  ", "fr-FR", "C", "POSIX", "C.UTF-8"] {
            assert_eq!(normalize(tag), None, "{tag}");
        }
    }

    #[test]
    fn resolves_in_preference_order() {
        assert_eq!(resolve(Some("en"), Some("pt"), Some("pt")), Locale::En);
        assert_eq!(resolve(None, Some("pt"), Some("en")), Locale::PtBr);
        assert_eq!(resolve(Some("fr"), Some("de"), Some("pt_BR")), Locale::PtBr);
        assert_eq!(resolve(Some("fr"), Some("pt"), Some("en")), Locale::PtBr);
        assert_eq!(resolve(None, None, Some("pt")), Locale::PtBr);
        assert_eq!(resolve(None, None, None), Locale::En);
        assert_eq!(resolve(Some("fr"), None, Some("POSIX")), Locale::En);
    }

    #[test]
    fn serializes_canonical_tags() {
        for locale in [Locale::En, Locale::PtBr] {
            assert_eq!(serde_json::to_value(locale).unwrap(), locale.tag());
        }
    }
}

/// Native desktop text catalog.
pub struct Texts {
    pub idle: &'static str,
    pub recording: &'static str,
    pub syncing: &'static str,
    pub record: &'static str,
    pub ignore: &'static str,
    pub app_browser: &'static str,
    pub app_other: &'static str,
    pub copy: &'static str,
    pub open: &'static str,
    pub recent_empty: &'static str,
    pub copy_summary: &'static str,
    pub open_web: &'static str,
    pub retry: &'static str,
    pub ask_record: &'static str,
    pub stop_recording: &'static str,
    pub start_recording: &'static str,
    pub new_note: &'static str,
    pub add_marker: &'static str,
    pub import_file: &'static str,
    pub show_app: &'static str,
    pub open_library: &'static str,
    pub quit: &'static str,
    pub note_time: &'static str,
    pub no_microphone: &'static str,
    pub automatic: &'static str,
    pub automatic_app: &'static str,
    pub meeting_detected: &'static str,
    pub markers_one: &'static str,
    pub markers_other: &'static str,
    pub unsynced_one: &'static str,
    pub unsynced_other: &'static str,
    pub summary_copied: &'static str,
    pub summary_clipboard: &'static str,
    pub copy_failed: &'static str,
    pub detected_title: &'static str,
    pub detected_body: &'static str,
    pub recording_body: &'static str,
    pub meeting_ended: &'static str,
    pub meeting_ended_body: &'static str,
    pub note_saved: &'static str,
    pub note_saved_body: &'static str,
    pub note_discarded: &'static str,
    pub no_speech: &'static str,
    pub busy_title: &'static str,
    pub busy_body: &'static str,
    pub mic_lost: &'static str,
    pub mic_lost_body: &'static str,
    pub recording_stopped: &'static str,
    pub stopped_body: &'static str,
    pub sources_ended: &'static str,
    pub recording_failed: &'static str,
    pub untitled: &'static str,
    pub summary_ready: &'static str,
    pub summary_ready_body: &'static str,
    pub summary_failed: &'static str,
    pub summary_failed_body: &'static str,
    pub no_summary: &'static str,
    pub no_summary_body: &'static str,
    pub transcription_failed: &'static str,
    pub transcription_failed_body: &'static str,
    pub needs_you: &'static str,
    pub needs_you_body: &'static str,
    pub reason_missing: &'static str,
    pub processed_one: &'static str,
    pub processed_other: &'static str,
    pub processed_body: &'static str,
    pub in_progress: &'static str,
    pub recent: &'static str,
    pub recent_one: &'static str,
    pub recent_other: &'static str,
    pub recent_attention: &'static str,
    pub recent_state: &'static str,
    pub note_failed: &'static str,
    pub updated: &'static str,
    pub update_notes: &'static str,
    pub tooltip: &'static str,
    pub busy_received: &'static str,
    pub busy_preprocessing: &'static str,
    pub busy_transcription: &'static str,
    pub busy_speakers: &'static str,
    pub busy_agenda_type: &'static str,
    pub busy_fields: &'static str,
    pub busy_summary: &'static str,
    pub device_pending: &'static str,
    pub device_uploaded: &'static str,
    pub device_failed: &'static str,
    pub reason_no_provider: &'static str,
    pub reason_no_auto_fields: &'static str,
    pub reason_no_types: &'static str,
    pub reason_set_by_user: &'static str,
    pub reason_no_agenda_type: &'static str,
    pub reason_before_pipeline: &'static str,
    pub reason_worker_without_preprocess: &'static str,
    pub reason_summary_deleted: &'static str,
    pub reason_cancelled: &'static str,
    pub reason_unnamed_speakers: &'static str,
    pub reason_continued_by_user: &'static str,
    pub reason_naming_not_required: &'static str,
    pub state_queued: &'static str,
    pub state_awaiting_speakers: &'static str,
    pub state_ready: &'static str,
    pub state_cancelled: &'static str,
}

pub const EN: Texts = Texts {
    idle: "Idle",
    recording: "Recording",
    syncing: "Syncing",
    record: "Record",
    ignore: "Not now",
    app_browser: "browser",
    app_other: "another app",
    copy: "Copy",
    open: "Open",
    recent_empty: "No recent recordings",
    copy_summary: "Copy summary",
    open_web: "Open on web",
    retry: "Try now",
    ask_record: "Record the meeting in {app}",
    stop_recording: "Stop recording",
    start_recording: "Start recording",
    new_note: "New note",
    add_marker: "Add marker",
    import_file: "Import file…",
    show_app: "Open eclume",
    open_library: "Open the web library",
    quit: "Quit",
    note_time: "Note {time}",
    no_microphone: "no microphone",
    automatic: "automatic",
    automatic_app: "{app} (automatic)",
    meeting_detected: "meeting in {app} detected",
    markers_one: "{count} marker",
    markers_other: "{count} markers",
    unsynced_one: "{count} recording to sync",
    unsynced_other: "{count} recordings to sync",
    summary_copied: "Summary copied",
    summary_clipboard: "The Markdown summary is on the clipboard.",
    copy_failed: "Could not copy the summary",
    detected_title: "Meeting detected",
    detected_body: "{app} is using the microphone. Record?",
    recording_body: "{app} · stop from the tray icon",
    meeting_ended: "Meeting ended",
    meeting_ended_body: "{duration} · uploading to the server",
    note_saved: "Note saved",
    note_saved_body: "{duration} · processing on the server",
    note_discarded: "Note discarded",
    no_speech: "no speech detected",
    busy_title: "A recording is already in progress",
    busy_body: "Stop the current recording to record a note.",
    mic_lost: "Microphone lost",
    mic_lost_body: "recording without your voice, trying to reconnect",
    recording_stopped: "Recording stopped",
    stopped_body: "{duration} saved · {reason}",
    sources_ended: "the audio sources disconnected",
    recording_failed: "recording failed",
    untitled: "Recording",
    summary_ready: "Summary ready",
    summary_ready_body: "{name} · copy to share",
    summary_failed: "Summary failed",
    summary_failed_body: "{name} · open to generate again",
    no_summary: "Ready without a summary",
    no_summary_body: "{name} · {reason}",
    transcription_failed: "Transcription failed",
    transcription_failed_body: "{name} · open to see why",
    needs_you: "Needs you",
    needs_you_body: "{name} · name the speakers to continue with the summary",
    reason_missing: "no reason provided",
    processed_one: "{count} recording processed",
    processed_other: "{count} recordings processed",
    processed_body: "Open the library to see summaries and failures",
    in_progress: "In progress",
    recent: "Recent",
    recent_one: "Recent · {count} needs you",
    recent_other: "Recent · {count} need you",
    recent_attention: "{title} · {attention} ({state})",
    recent_state: "{title} · {state}",
    note_failed: "Could not record the note",
    updated: "eclume updated to {version}",
    update_notes: "See what is new in the eclume window.",
    tooltip: "{app} — {status}",
    busy_received: "Uploading",
    busy_preprocessing: "Preprocessing",
    busy_transcription: "Transcribing",
    busy_speakers: "Checking speakers",
    busy_agenda_type: "Detecting the type",
    busy_fields: "Filling fields",
    busy_summary: "Summarizing",
    device_pending: "Waiting to upload",
    device_uploaded: "Uploaded",
    device_failed: "Upload failed",
    reason_no_provider: "no agent configured; ask your administrator",
    reason_no_auto_fields: "no field is filled automatically",
    reason_no_types: "only the default type exists: it was kept",
    reason_set_by_user: "you chose the type",
    reason_no_agenda_type: "the recording has no agenda type",
    reason_before_pipeline: "recording made before automatic processing",
    reason_worker_without_preprocess: "the processor of this recording does not preprocess",
    reason_summary_deleted: "the summary was deleted",
    reason_cancelled: "the transcription was cancelled",
    reason_unnamed_speakers: "some speakers have no person; name them all to go on with the type, the fields and the summary",
    reason_continued_by_user: "you went on without naming every speaker",
    reason_naming_not_required: "the account no longer requires speaker names",
    state_queued: "Queued",
    state_awaiting_speakers: "Awaiting speakers",
    state_ready: "Ready",
    state_cancelled: "Cancelled",
};

pub const PT_BR: Texts = Texts {
    idle: "Ocioso",
    recording: "Gravando",
    syncing: "Sincronizando",
    record: "Gravar",
    ignore: "Agora não",
    app_browser: "navegador",
    app_other: "outro app",
    copy: "Copiar",
    open: "Abrir",
    recent_empty: "Nenhuma gravação recente",
    copy_summary: "Copiar resumo",
    open_web: "Abrir no web",
    retry: "Tentar agora",
    ask_record: "Gravar a reunião do {app}",
    stop_recording: "Parar gravação",
    start_recording: "Iniciar gravação",
    new_note: "Nova nota",
    add_marker: "Adicionar marcador",
    import_file: "Importar arquivo…",
    show_app: "Abrir o eclume",
    open_library: "Abrir a biblioteca na web",
    quit: "Sair",
    note_time: "Nota {time}",
    no_microphone: "sem microfone",
    automatic: "automático",
    automatic_app: "{app} (automático)",
    meeting_detected: "reunião no {app} detectada",
    markers_one: "{count} marcador",
    markers_other: "{count} marcadores",
    unsynced_one: "{count} gravação a sincronizar",
    unsynced_other: "{count} gravações a sincronizar",
    summary_copied: "Resumo copiado",
    summary_clipboard: "O resumo em Markdown está na área de transferência.",
    copy_failed: "Não foi possível copiar o resumo",
    detected_title: "Reunião detectada",
    detected_body: "{app} está usando o microfone. Gravar?",
    recording_body: "{app} · pare pelo ícone da bandeja",
    meeting_ended: "Reunião encerrada",
    meeting_ended_body: "{duration} · enviando ao servidor",
    note_saved: "Nota salva",
    note_saved_body: "{duration} · processando no servidor",
    note_discarded: "Nota descartada",
    no_speech: "não ouvimos voz",
    busy_title: "Já há uma gravação em andamento",
    busy_body: "Pare a gravação atual para gravar uma nota.",
    mic_lost: "Microfone perdido",
    mic_lost_body: "gravando sem a sua voz, tentando reconectar",
    recording_stopped: "A gravação parou",
    stopped_body: "{duration} salvos · {reason}",
    sources_ended: "as fontes de áudio caíram",
    recording_failed: "falha ao gravar",
    untitled: "Gravação",
    summary_ready: "Resumo pronto",
    summary_ready_body: "{name} · copie para compartilhar",
    summary_failed: "O resumo falhou",
    summary_failed_body: "{name} · abra para gerar de novo",
    no_summary: "Pronta sem resumo",
    no_summary_body: "{name} · {reason}",
    transcription_failed: "A transcrição falhou",
    transcription_failed_body: "{name} · abra para ver o motivo",
    needs_you: "Precisa de você",
    needs_you_body: "{name} · nomeie os locutores para seguir com o resumo",
    reason_missing: "sem motivo informado",
    processed_one: "{count} gravação processada",
    processed_other: "{count} gravações processadas",
    processed_body: "Abra a biblioteca para ver os resumos e as falhas",
    in_progress: "Em andamento",
    recent: "Recentes",
    recent_one: "Recentes · {count} precisa de você",
    recent_other: "Recentes · {count} precisam de você",
    recent_attention: "{title} · {attention} ({state})",
    recent_state: "{title} · {state}",
    note_failed: "Não deu para gravar a nota",
    updated: "eclume atualizado para {version}",
    update_notes: "Veja as novidades na janela do eclume.",
    tooltip: "{app} — {status}",
    busy_received: "Enviando",
    busy_preprocessing: "Pré-processando",
    busy_transcription: "Transcrevendo",
    busy_speakers: "Conferindo locutores",
    busy_agenda_type: "Detectando o tipo",
    busy_fields: "Preenchendo campos",
    busy_summary: "Resumindo",
    device_pending: "Aguardando envio",
    device_uploaded: "Enviada",
    device_failed: "Falhou o envio",
    reason_no_provider: "nenhum agente configurado; fale com quem administra",
    reason_no_auto_fields: "nenhum campo com preenchimento automático",
    reason_no_types: "só o tipo padrão está cadastrado: ficou ele",
    reason_set_by_user: "o tipo foi escolhido por você",
    reason_no_agenda_type: "a gravação não tem tipo de agenda",
    reason_before_pipeline: "gravação anterior ao processamento automático",
    reason_worker_without_preprocess: "o processador desta gravação não faz pré-processamento",
    reason_summary_deleted: "o resumo foi excluído",
    reason_cancelled: "a transcrição foi cancelada",
    reason_unnamed_speakers:
        "há locutores sem pessoa; nomeie todos para seguir com o tipo, os campos e o resumo",
    reason_continued_by_user: "você seguiu sem nomear todos os locutores",
    reason_naming_not_required: "a conta deixou de exigir os nomes dos locutores",
    state_queued: "Na fila",
    state_awaiting_speakers: "Aguardando locutores",
    state_ready: "Pronta",
    state_cancelled: "Cancelada",
};

impl Locale {
    pub fn texts(self) -> &'static Texts {
        match self {
            Self::En => &EN,
            Self::PtBr => &PT_BR,
        }
    }

    /// Name of a meeting app in this locale: brand names stay, the generic ones are translated.
    pub fn app_label(self, key: AppKey) -> &'static str {
        match key {
            AppKey::Navegador => self.texts().app_browser,
            AppKey::Outro => self.texts().app_other,
            _ => key.label(),
        }
    }
}

/// Substitute named placeholders without interpreting inserted values as placeholders.
pub fn fill(text: &str, vars: &[(&str, &str)]) -> String {
    let mut result = String::new();
    let mut rest = text;
    while let Some(start) = rest.find('{') {
        result.push_str(&rest[..start]);
        let Some(end) = rest[start..].find('}') else {
            result.push_str(&rest[start..]);
            return result;
        };
        let end = start + end;
        let name = &rest[start + 1..end];
        if let Some((_, value)) = vars.iter().find(|(key, _)| *key == name) {
            result.push_str(value);
        } else {
            result.push_str(&rest[start..=end]);
        }
        rest = &rest[end + 1..];
    }
    result.push_str(rest);
    result
}

#[cfg(test)]
mod catalog_tests {
    use super::*;
    #[test]
    fn catalogs_are_complete() {
        for texts in [&EN, &PT_BR] {
            assert!(!texts.idle.is_empty(), "idle");
            assert!(!texts.recording.is_empty(), "recording");
            assert!(!texts.syncing.is_empty(), "syncing");
            assert!(!texts.record.is_empty(), "record");
            assert!(!texts.ignore.is_empty(), "ignore");
            assert!(!texts.copy.is_empty(), "copy");
            assert!(!texts.open.is_empty(), "open");
            assert!(!texts.recent_empty.is_empty(), "recent_empty");
            assert!(!texts.copy_summary.is_empty(), "copy_summary");
            assert!(!texts.open_web.is_empty(), "open_web");
            assert!(!texts.retry.is_empty(), "retry");
            assert!(!texts.ask_record.is_empty(), "ask_record");
            assert!(!texts.stop_recording.is_empty(), "stop_recording");
            assert!(!texts.start_recording.is_empty(), "start_recording");
            assert!(!texts.new_note.is_empty(), "new_note");
            assert!(!texts.add_marker.is_empty(), "add_marker");
            assert!(!texts.import_file.is_empty(), "import_file");
            assert!(!texts.show_app.is_empty(), "show_app");
            assert!(!texts.open_library.is_empty(), "open_library");
            assert!(!texts.quit.is_empty(), "quit");
            assert!(!texts.note_time.is_empty(), "note_time");
            assert!(!texts.no_microphone.is_empty(), "no_microphone");
            assert!(!texts.automatic.is_empty(), "automatic");
            assert!(!texts.automatic_app.is_empty(), "automatic_app");
            assert!(!texts.meeting_detected.is_empty(), "meeting_detected");
            assert!(!texts.markers_one.is_empty(), "markers_one");
            assert!(!texts.markers_other.is_empty(), "markers_other");
            assert!(!texts.unsynced_one.is_empty(), "unsynced_one");
            assert!(!texts.unsynced_other.is_empty(), "unsynced_other");
            assert!(!texts.summary_copied.is_empty(), "summary_copied");
            assert!(!texts.summary_clipboard.is_empty(), "summary_clipboard");
            assert!(!texts.copy_failed.is_empty(), "copy_failed");
            assert!(!texts.detected_title.is_empty(), "detected_title");
            assert!(!texts.detected_body.is_empty(), "detected_body");
            assert!(!texts.recording_body.is_empty(), "recording_body");
            assert!(!texts.meeting_ended.is_empty(), "meeting_ended");
            assert!(!texts.meeting_ended_body.is_empty(), "meeting_ended_body");
            assert!(!texts.note_saved.is_empty(), "note_saved");
            assert!(!texts.note_saved_body.is_empty(), "note_saved_body");
            assert!(!texts.note_discarded.is_empty(), "note_discarded");
            assert!(!texts.no_speech.is_empty(), "no_speech");
            assert!(!texts.busy_title.is_empty(), "busy_title");
            assert!(!texts.busy_body.is_empty(), "busy_body");
            assert!(!texts.mic_lost.is_empty(), "mic_lost");
            assert!(!texts.mic_lost_body.is_empty(), "mic_lost_body");
            assert!(!texts.recording_stopped.is_empty(), "recording_stopped");
            assert!(!texts.stopped_body.is_empty(), "stopped_body");
            assert!(!texts.sources_ended.is_empty(), "sources_ended");
            assert!(!texts.recording_failed.is_empty(), "recording_failed");
            assert!(!texts.untitled.is_empty(), "untitled");
            assert!(!texts.summary_ready.is_empty(), "summary_ready");
            assert!(!texts.summary_ready_body.is_empty(), "summary_ready_body");
            assert!(!texts.summary_failed.is_empty(), "summary_failed");
            assert!(!texts.summary_failed_body.is_empty(), "summary_failed_body");
            assert!(!texts.no_summary.is_empty(), "no_summary");
            assert!(!texts.no_summary_body.is_empty(), "no_summary_body");
            assert!(
                !texts.transcription_failed.is_empty(),
                "transcription_failed"
            );
            assert!(
                !texts.transcription_failed_body.is_empty(),
                "transcription_failed_body"
            );
            assert!(!texts.needs_you.is_empty(), "needs_you");
            assert!(!texts.needs_you_body.is_empty(), "needs_you_body");
            assert!(!texts.reason_missing.is_empty(), "reason_missing");
            assert!(!texts.processed_one.is_empty(), "processed_one");
            assert!(!texts.processed_other.is_empty(), "processed_other");
            assert!(!texts.processed_body.is_empty(), "processed_body");
            assert!(!texts.in_progress.is_empty(), "in_progress");
            assert!(!texts.recent.is_empty(), "recent");
            assert!(!texts.recent_one.is_empty(), "recent_one");
            assert!(!texts.recent_other.is_empty(), "recent_other");
            assert!(!texts.recent_attention.is_empty(), "recent_attention");
            assert!(!texts.recent_state.is_empty(), "recent_state");
            assert!(!texts.note_failed.is_empty(), "note_failed");
            assert!(!texts.updated.is_empty(), "updated");
            assert!(!texts.update_notes.is_empty(), "update_notes");
            assert!(!texts.tooltip.is_empty(), "tooltip");
            assert!(!texts.busy_received.is_empty(), "busy_received");
            assert!(!texts.busy_preprocessing.is_empty(), "busy_preprocessing");
            assert!(!texts.busy_transcription.is_empty(), "busy_transcription");
            assert!(!texts.busy_speakers.is_empty(), "busy_speakers");
            assert!(!texts.busy_agenda_type.is_empty(), "busy_agenda_type");
            assert!(!texts.busy_fields.is_empty(), "busy_fields");
            assert!(!texts.busy_summary.is_empty(), "busy_summary");
            assert!(!texts.device_pending.is_empty(), "device_pending");
            assert!(!texts.device_uploaded.is_empty(), "device_uploaded");
            assert!(!texts.device_failed.is_empty(), "device_failed");
            assert!(!texts.reason_no_provider.is_empty(), "reason_no_provider");
            assert!(
                !texts.reason_no_auto_fields.is_empty(),
                "reason_no_auto_fields"
            );
            assert!(!texts.reason_no_types.is_empty(), "reason_no_types");
            assert!(!texts.reason_set_by_user.is_empty(), "reason_set_by_user");
            assert!(
                !texts.reason_no_agenda_type.is_empty(),
                "reason_no_agenda_type"
            );
            assert!(
                !texts.reason_before_pipeline.is_empty(),
                "reason_before_pipeline"
            );
            assert!(
                !texts.reason_worker_without_preprocess.is_empty(),
                "reason_worker_without_preprocess"
            );
            assert!(
                !texts.reason_summary_deleted.is_empty(),
                "reason_summary_deleted"
            );
            assert!(!texts.reason_cancelled.is_empty(), "reason_cancelled");
            assert!(
                !texts.reason_unnamed_speakers.is_empty(),
                "reason_unnamed_speakers"
            );
            assert!(
                !texts.reason_continued_by_user.is_empty(),
                "reason_continued_by_user"
            );
            assert!(
                !texts.reason_naming_not_required.is_empty(),
                "reason_naming_not_required"
            );
            assert!(!texts.state_queued.is_empty(), "state_queued");
            assert!(
                !texts.state_awaiting_speakers.is_empty(),
                "state_awaiting_speakers"
            );
            assert!(!texts.state_ready.is_empty(), "state_ready");
            assert!(!texts.state_cancelled.is_empty(), "state_cancelled");
        }
    }
    #[test]
    fn reasons_match_web_english() {
        assert_eq!(
            EN.reason_no_provider,
            "no agent configured; ask your administrator"
        );
        assert_eq!(EN.reason_no_agenda_type, "the recording has no agenda type");
        assert_eq!(EN.reason_unnamed_speakers, "some speakers have no person; name them all to go on with the type, the fields and the summary");
        assert_eq!(EN.reason_cancelled, "the transcription was cancelled");
    }
    #[test]
    fn fill_preserves_inserted_placeholders() {
        assert_eq!(
            fill(
                "{name} · {reason}",
                &[("name", "{reason}"), ("reason", "done")]
            ),
            "{reason} · done"
        );
    }
}
