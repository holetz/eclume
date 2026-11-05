//! Eclume's network and the sync, without a network: the state machine, the probe and a full sync
//! pass through the scripted transport.

mod common;

use std::path::Path;
use std::sync::{Arc, Mutex};

use common::{json, temp_dirs, Script, CA_SHA256};
use eclume_mobile_core::config::Server;
use eclume_mobile_core::network::{probe, Network, NetworkState, Probe, Progress};
use eclume_mobile_core::sync::{
    delete_synced, download_apk, fetch_agenda_types, fetch_manifest, fetch_steps, fetch_titles,
    is_newer, retain, synced_bytes, synchronize, uploader, Meter,
};
use eclume_recorder::{now_ms, Queue, Source, Status};
use eclume_sync::transport::HttpResponse;

const URL: &str = "https://eclume.test:8443";

fn server() -> Server {
    Server {
        url: URL.into(),
        name: "eclume".into(),
        ca_sha256: CA_SHA256.into(),
    }
}

#[test]
fn on_network_only_with_unmetered_wifi_and_probe_ok() {
    let mut network = Network::default();
    assert_eq!(network.state(), NetworkState::Away);
    // On mobile data, the probe does not even run.
    assert!(!network.needs_probe(0, true));

    assert!(network.wifi_changed(true));
    assert!(network.needs_probe(0, true));
    assert_eq!(network.state(), NetworkState::Away);
    network.record_probe(1_000, Probe::Ok);
    assert_eq!(network.state(), NetworkState::OnNetwork);
    assert!(network.on_network());
    // Visible, it repeats every 60 s; in the background, it does not.
    assert!(!network.needs_probe(30_000, true));
    assert!(network.needs_probe(61_000, true));
    assert!(!network.needs_probe(61_000, false));

    let progress = Progress {
        i: 1,
        n: 2,
        pct: 64,
        bytes_s: 18_000_000,
    };
    network.sync_progress(progress);
    assert_eq!(network.state(), NetworkState::Syncing(progress));
    network.sync_finished();

    network.record_probe(62_000, Probe::NoAnswer);
    assert_eq!(network.state(), NetworkState::Away);
    network.record_probe(63_000, Probe::CaChanged);
    assert_eq!(network.state(), NetworkState::CaMismatch);
    assert!(!network.on_network());

    // Switching networks invalidates the probe.
    network.record_probe(64_000, Probe::Ok);
    assert!(network.wifi_changed(false));
    assert_eq!(network.state(), NetworkState::Away);
    assert!(!network.wifi_changed(false));
    network.wifi_changed(true);
    assert!(network.needs_probe(64_001, false));

    network.credential_lost();
    assert_eq!(network.state(), NetworkState::NoCredential);
    assert!(!network.can_probe());
    network.credential_restored();
    assert!(network.can_probe());
}

#[test]
fn network_state_keeps_its_wire_names() {
    let json = |state: NetworkState| serde_json::to_value(state).unwrap();
    assert_eq!(json(NetworkState::Away)["estado"], "away");
    assert_eq!(json(NetworkState::OnNetwork)["estado"], "on_network");
    assert_eq!(json(NetworkState::NoCredential)["estado"], "sem_credencial");
}

#[test]
fn probe_checks_the_fingerprint() {
    let script = Script::default();
    let info = |ca: &str| {
        json(
            200,
            serde_json::json!({"name": "eclume", "url": URL, "ca_sha256": ca}),
        )
    };
    script.reply("GET", "/api/v1/server", info(CA_SHA256));
    assert_eq!(probe(Arc::new(script.clone()), &server()), Probe::Ok);
    script.reply("GET", "/api/v1/server", info(&"11".repeat(32)));
    assert_eq!(probe(Arc::new(script.clone()), &server()), Probe::CaChanged);
    script.reply("GET", "/api/v1/server", common::failure("tempo esgotado"));
    assert_eq!(probe(Arc::new(script.clone()), &server()), Probe::NoAnswer);
    script.reply(
        "GET",
        "/api/v1/server",
        common::failure("invalid peer certificate: UnknownIssuer"),
    );
    assert_eq!(probe(Arc::new(script), &server()), Probe::CaChanged);
}

/// A `pending` recording with a file of `bytes` bytes.
fn recording(queue: &Queue, dir: &Path, id: &str, bytes: usize) {
    std::fs::create_dir_all(dir).unwrap();
    let path = dir.join(format!("{id}.ogg"));
    std::fs::write(&path, vec![7_u8; bytes]).unwrap();
    queue
        .begin(id, &dir.join(format!("{id}.ogg.part")), now_ms() - 60_000)
        .unwrap();
    queue
        .finish(id, &path, now_ms(), 60_000, bytes as i64)
        .unwrap();
    queue.set_source(id, Source::Mobile).unwrap();
}

fn upload_script(script: &Script) {
    script.reply(
        "POST",
        "/api/v1/uploads",
        json(
            201,
            serde_json::json!({
                "id": "up-1", "status": "in_progress", "part_size": 6, "part_count": 2,
                "parts_received": [], "recording_id": null,
                "parts": [
                    {"part_number": 1, "url": format!("{URL}/api/v1/uploads/up-1/parts/1"), "headers": {}},
                    {"part_number": 2, "url": format!("{URL}/api/v1/uploads/up-1/parts/2"), "headers": {}}
                ]
            }),
        ),
    );
    for n in [1, 2] {
        script.reply(
            "PUT",
            &format!("/api/v1/uploads/up-1/parts/{n}"),
            Ok(HttpResponse {
                status: 200,
                headers: vec![("etag".into(), format!("\"e{n}\""))],
                body: Vec::new(),
            }),
        );
    }
    script.reply(
        "POST",
        "/api/v1/uploads/up-1/complete",
        json(
            201,
            serde_json::json!({"id": "rec-remoto", "status": "queued"}),
        ),
    );
}

#[test]
fn sync_uploads_with_progress_and_retention_deletes_only_the_confirmed() {
    let (dirs, _guard) = temp_dirs("sync");
    let script = Script::default();
    upload_script(&script);
    let queue = Arc::new(Mutex::new(Queue::open(&dirs.queue()).unwrap()));
    recording(&queue.lock().unwrap(), &dirs.recordings(), "g1", 10);
    let meter = Arc::new(Meter::default());
    let up = uploader(
        Arc::new(script.clone()),
        Arc::clone(&meter),
        &server(),
        "eclp_dispositivo",
        Arc::clone(&queue),
        "eclume-android/0.1.0",
        "Pixel 8",
    )
    .unwrap();

    let report = synchronize(&queue, &up, &meter).unwrap();
    assert_eq!(report.synced, 1);
    let progress = meter.progress();
    assert_eq!((progress.i, progress.n, progress.pct), (1, 1, 100));
    assert!(!meter.credential_refused());
    let creation = script.request("POST", "/api/v1/uploads").unwrap();
    let body: serde_json::Value = serde_json::from_slice(&creation.body).unwrap();
    assert_eq!(body["source"], "mobile");
    assert_eq!(body["capture"]["device_name"], "Pixel 8");
    assert_eq!(body["capture"]["client_version"], "eclume-android/0.1.0");
    let rec = queue.lock().unwrap().get("g1").unwrap().unwrap();
    assert_eq!(rec.status, Status::Synced);
    assert_eq!(rec.remote_id.as_deref(), Some("rec-remoto"));

    // The 7-day retention still keeps what was just uploaded; "Excluir sincronizadas" deletes it
    // right away.
    assert_eq!(retain(&queue, now_ms(), 7).unwrap(), 0);
    assert_eq!(synced_bytes(&queue).unwrap(), 10);
    assert_eq!(retain(&queue, now_ms() + 8 * 86_400_000, 7).unwrap(), 1);
    assert!(!rec.path.exists());
    assert_eq!(delete_synced(&queue).unwrap(), (0, 0));
}

/// The Wi-Fi drops after the first part: the second does not go out, the recording goes back to
/// the queue without spending an attempt and, on the next Wi-Fi, only the missing part uploads.
#[test]
fn wifi_dropping_midway_interrupts_and_resumes_from_the_missing_parts() {
    let (dirs, _guard) = temp_dirs("sync-interrompido");
    let script = Script::default();
    upload_script(&script);
    let meter = Arc::new(Meter::default());
    {
        let meter = Arc::clone(&meter);
        script.reply_with("PUT", "/api/v1/uploads/up-1/parts/1", move || {
            // The system callback reports the network change while part 1 uploads.
            meter.interrupt();
            Ok(HttpResponse {
                status: 200,
                headers: vec![("etag".into(), "\"e1\"".into())],
                body: Vec::new(),
            })
        });
    }
    let queue = Arc::new(Mutex::new(Queue::open(&dirs.queue()).unwrap()));
    recording(&queue.lock().unwrap(), &dirs.recordings(), "g1", 10);
    let up = uploader(
        Arc::new(script.clone()),
        Arc::clone(&meter),
        &server(),
        "eclp_dispositivo",
        Arc::clone(&queue),
        "eclume-android/0.1.0",
        "Pixel 8",
    )
    .unwrap();

    let report = synchronize(&queue, &up, &meter).unwrap();
    assert_eq!((report.synced, report.failed), (0, 0));
    assert_eq!(script.count("PUT", "/api/v1/uploads/up-1/parts/1"), 1);
    assert_eq!(script.count("PUT", "/api/v1/uploads/up-1/parts/2"), 0);
    assert_eq!(script.count("POST", "/api/v1/uploads/up-1/complete"), 0);
    let rec = queue.lock().unwrap().get("g1").unwrap().unwrap();
    assert_eq!((rec.status, rec.attempts), (Status::Pending, 0));
    assert_eq!(rec.upload_id.as_deref(), Some("up-1"));

    // Back on eclume's Wi-Fi: the server already has part 1, and only part 2 uploads.
    script.reply(
        "GET",
        "/api/v1/uploads/up-1",
        json(
            200,
            serde_json::json!({
                "id": "up-1", "status": "in_progress", "part_size": 6, "part_count": 2,
                "parts_received": [{"part_number": 1, "etag": "\"e1\""}], "recording_id": null,
                "parts": [
                    {"part_number": 2, "url": format!("{URL}/api/v1/uploads/up-1/parts/2"), "headers": {}}
                ]
            }),
        ),
    );
    meter.resume();
    let report = synchronize(&queue, &up, &meter).unwrap();
    assert_eq!(report.synced, 1);
    assert_eq!(script.count("PUT", "/api/v1/uploads/up-1/parts/1"), 1);
    assert_eq!(script.count("PUT", "/api/v1/uploads/up-1/parts/2"), 1);
    let rec = queue.lock().unwrap().get("g1").unwrap().unwrap();
    assert_eq!(rec.status, Status::Synced);
}

#[test]
fn sync_notes_the_401_and_the_open_sheet_holds_the_recording() {
    let (dirs, _guard) = temp_dirs("sync-401");
    let script = Script::default();
    script.reply(
        "POST",
        "/api/v1/uploads",
        json(
            401,
            serde_json::json!({"title": "Não autenticado", "status": 401}),
        ),
    );
    let queue = Arc::new(Mutex::new(Queue::open(&dirs.queue()).unwrap()));
    recording(&queue.lock().unwrap(), &dirs.recordings(), "g1", 10);
    recording(&queue.lock().unwrap(), &dirs.recordings(), "folha", 10);
    queue.lock().unwrap().set_details_pending("folha").unwrap();
    let meter = Arc::new(Meter::default());
    let up = uploader(
        Arc::new(script.clone()),
        Arc::clone(&meter),
        &server(),
        "eclp_dispositivo",
        Arc::clone(&queue),
        "eclume-android/0.1.0",
        "Pixel 8",
    )
    .unwrap();
    let report = synchronize(&queue, &up, &meter).unwrap();
    assert_eq!((report.synced, report.failed), (0, 1));
    assert!(meter.credential_refused());
    assert_eq!(script.count("POST", "/api/v1/uploads"), 1);
    let sheet = queue.lock().unwrap().get("folha").unwrap().unwrap();
    assert_eq!(sheet.status, Status::Pending);
}

#[test]
fn agenda_types_and_server_steps() {
    let script = Script::default();
    script.reply(
        "GET",
        "/api/v1/agenda-types",
        json(
            200,
            serde_json::json!({"items": [{"id": "t1", "name": "Reunião de equipe"}], "next_cursor": null}),
        ),
    );
    script.reply(
        "GET",
        "/api/v1/recordings/rec-remoto",
        json(
            200,
            serde_json::json!({"id": "rec-remoto", "pipeline": [
                {"step": "received", "state": "done"},
                {"step": "transcription", "state": "active"},
                {"step": "summary", "state": "skipped", "reason": "no_provider", "error": null},
                {"step": "fields", "state": "failed",
                 "error": {"code": "provider_timeout", "message": "O agente não respondeu."}}
            ]}),
        ),
    );
    let types = fetch_agenda_types(&script, &server(), "eclp_x").unwrap();
    assert_eq!(types[0].name, "Reunião de equipe");
    let request = script.request("GET", "/api/v1/agenda-types").unwrap();
    assert!(request
        .headers
        .iter()
        .any(|(k, v)| k == "Authorization" && v == "Bearer eclp_x"));
    let on_server = fetch_steps(&script, &server(), "eclp_x", "rec-remoto").unwrap();
    // A server older than 2.16.0, without `job.queue`: no wait; without a title, `None`.
    assert_eq!(on_server.wait, None);
    assert_eq!(on_server.title, None);
    let steps = on_server.steps;
    assert_eq!(steps[1].state, "active");
    assert_eq!(steps[1].reason, None);
    assert_eq!(steps[2].reason.as_deref(), Some("no_provider"));
    assert_eq!(
        steps[3].error.as_ref().map(|e| e.message.as_str()),
        Some("O agente não respondeu.")
    );
}

#[test]
fn server_titles_by_since_across_every_page() {
    let script = Script::default();
    let calls = Arc::new(Mutex::new(0));
    let counter = Arc::clone(&calls);
    script.reply_with("GET", "/api/v1/recordings", move || {
        let mut n = counter.lock().unwrap();
        *n += 1;
        if *n == 1 {
            json(
                200,
                serde_json::json!({"items": [
                    {"id": "r1", "title": "Alinhamento", "updated_at": "2026-10-01T12:00:00Z"},
                    {"id": "r2", "title": " ", "updated_at": "2026-10-01T12:05:00Z"}
                ], "next_cursor": "c+2"}),
            )
        } else {
            json(
                200,
                serde_json::json!({"items": [
                    {"id": "r3", "title": "Kickoff", "updated_at": "2026-10-01T12:10:00Z"}
                ], "next_cursor": null}),
            )
        }
    });
    let titles = fetch_titles(&script, &server(), "eclp_x", "2026-10-01T11:00:00Z").unwrap();
    assert_eq!(
        titles.pairs,
        [
            ("r1".to_string(), "Alinhamento".to_string()),
            ("r3".to_string(), "Kickoff".to_string())
        ]
    );
    assert_eq!(titles.next.as_deref(), Some("2026-10-01T12:09:00Z"));
    let last = script.request("GET", "/api/v1/recordings").unwrap();
    assert!(last.url.contains("since=2026-10-01T11%3A00%3A00Z"));
    assert!(last.url.contains("cursor=c%2B2"));
}

#[test]
fn wait_in_the_server_queue() {
    let script = Script::default();
    script.reply(
        "GET",
        "/api/v1/recordings/rec-remoto",
        json(
            200,
            serde_json::json!({"id": "rec-remoto", "title": "Alinhamento", "pipeline": [], "job": {"state": "queued", "queue": {
                "reason": "processor_queue", "ahead": 2, "account_ahead": null,
                "estimated_start_at": "2026-10-01T14:14:00Z", "resumes_at": null,
                "processor": {"online": false, "offline_since": "2026-10-01T14:02:00Z"}
            }}}),
        ),
    );
    let on_server = fetch_steps(&script, &server(), "eclp_x", "rec-remoto").unwrap();
    assert_eq!(on_server.title.as_deref(), Some("Alinhamento"));
    let wait = on_server.wait.unwrap();
    assert_eq!(wait.reason, "processor_queue");
    assert_eq!(wait.ahead, Some(2));
    assert_eq!(wait.account_ahead, None);
    let processor = wait.processor.unwrap();
    assert!(!processor.online);
    assert_eq!(
        processor.offline_since.as_deref(),
        Some("2026-10-01T14:02:00Z")
    );
}

#[test]
fn update_through_movel_json_checks_the_apk() {
    assert!(is_newer("0.2.0", "0.1.0"));
    assert!(is_newer("0.10.0", "0.9.9"));
    assert!(!is_newer("0.1.0", "0.1.0"));
    assert!(!is_newer("0.0.9", "0.1.0"));
    assert!(!is_newer("versão", "0.1.0"));

    let apk = b"PK apk novo".to_vec();
    let sha = eclume_sync::pin::sha256_hex(&apk);
    let script = Script::default();
    assert_eq!(
        {
            script.reply("GET", "/downloads/movel.json", common::text(404, ""));
            fetch_manifest(&script, &server()).unwrap()
        },
        None
    );
    script.reply(
        "GET",
        "/downloads/movel.json",
        json(
            200,
            serde_json::json!({
                "versao": "0.2.0", "publicado_em": "2026-09-27T18:30:05Z", "notas": "Correções",
                "apk": {"arquivo": "eclume-0.2.0.apk", "url": "/downloads/movel/0.2.0/eclume-0.2.0.apk",
                        "tamanho": apk.len(), "sha256": sha},
                "min_android": "8.0", "certificado_sha256": "ab".repeat(32),
                "instalacao": "/downloads/movel/INSTALACAO.md"
            }),
        ),
    );
    let manifest = fetch_manifest(&script, &server()).unwrap().unwrap();
    assert_eq!(manifest.version, "0.2.0");

    let (dirs, _guard) = temp_dirs("apk");
    script.reply(
        "GET",
        "/downloads/movel/0.2.0/eclume-0.2.0.apk",
        Ok(HttpResponse {
            status: 200,
            headers: Vec::new(),
            body: apk.clone(),
        }),
    );
    let path = download_apk(&script, &server(), &manifest, &dirs.data).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), apk);
    let request = script
        .request("GET", "/downloads/movel/0.2.0/eclume-0.2.0.apk")
        .unwrap();
    assert_eq!(
        request.url,
        format!("{URL}/downloads/movel/0.2.0/eclume-0.2.0.apk")
    );

    // An APK that does not match the manifest is not installed.
    script.reply(
        "GET",
        "/downloads/movel/0.2.0/eclume-0.2.0.apk",
        Ok(HttpResponse {
            status: 200,
            headers: Vec::new(),
            body: b"PK adulterado".to_vec(),
        }),
    );
    let err = download_apk(&script, &server(), &manifest, &dirs.no_backup).unwrap_err();
    assert!(format!("{err:#}").contains("não confere"), "{err:#}");
    assert!(!dirs.no_backup.exists());
}

/// A connected core with a credential, over a script with the probe and the agenda types.
fn connected_core(
    name: &str,
) -> (
    Arc<Mutex<eclume_mobile_core::Core>>,
    Script,
    common::Cleanup,
) {
    use eclume_mobile_core::{lock, Core};

    let (dirs, guard) = temp_dirs(name);
    let script = Script::default();
    script.reply(
        "GET",
        "/downloads/eclume-root.crt",
        common::text(200, common::CA_PEM),
    );
    script.reply(
        "GET",
        "/api/v1/server",
        json(
            200,
            serde_json::json!({"name": "eclume", "url": URL, "ca_sha256": CA_SHA256}),
        ),
    );
    script.reply(
        "POST",
        "/api/v1/devices/login",
        json(
            201,
            serde_json::json!({"token": {"id": "t1", "name": "Pixel 8"}, "secret": "eclp_segredo",
                "server": {"name": "eclume", "url": URL, "ca_sha256": CA_SHA256}}),
        ),
    );
    script.reply(
        "GET",
        "/api/v1/agenda-types",
        json(
            200,
            serde_json::json!({"items": [{"id": "t1", "name": "Reunião"}], "next_cursor": null}),
        ),
    );
    script.reply(
        "GET",
        "/api/v1/me/transcription",
        json(
            200,
            serde_json::json!({"language": null, "platform_default": "pt"}),
        ),
    );
    script.reply(
        "GET",
        "/api/v1/me/locale",
        json(
            200,
            serde_json::json!({"locale": "pt-BR", "effective": "pt-BR", "default": "en", "supported": ["en", "pt-BR"]}),
        ),
    );
    script.reply("GET", "/downloads/movel.json", common::text(404, ""));
    let core = Arc::new(Mutex::new(
        Core::open(
            dirs,
            "0.1.0",
            Arc::new(common::FakeTransports(script.clone())),
        )
        .unwrap(),
    ));
    {
        let mut core = lock(&core).unwrap();
        core.connect_address(URL).unwrap();
        core.trust_ca().unwrap();
        core.sign_in("ana@eclume.test", "senha").unwrap();
    }
    (core, script, guard)
}

/// A whole cycle through the core (probe, types, update, sync) must not deadlock itself: the
/// network runs outside the core's lock.
#[test]
fn full_cycle_does_not_deadlock_the_core() {
    use eclume_mobile_core::{cycle, lock};

    let (core, _script, _guard) = connected_core("ciclo");
    lock(&core).unwrap().network_changed(true);
    let (done, receive) = std::sync::mpsc::channel();
    let c = Arc::clone(&core);
    std::thread::spawn(move || {
        let _ = done.send(
            cycle(&c, true)
                .map(|r| r.is_some())
                .map_err(|e| format!("{e:#}")),
        );
    });
    let result = receive
        .recv_timeout(std::time::Duration::from_secs(10))
        .expect("the cycle deadlocked the core");
    assert_eq!(result, Ok(false));
    let core = lock(&core).unwrap();
    assert_eq!(core.state().unwrap().network, NetworkState::OnNetwork);
    assert_eq!(core.config().agenda_types[0].name, "Reunião");
    assert_eq!(core.config().account_locale.as_deref(), Some("pt-BR"));
    assert_eq!(core.state().unwrap().locale, "pt-BR");
    // The account default comes named on the sheet, off the network afterwards too.
    let options = core.language_options();
    assert_eq!(options[0].value, "");
    assert_eq!(options[0].label, "Padrão da conta: Português");
    assert_eq!(options[1].value, "auto");
}

#[test]
fn null_account_locale_uses_the_device_and_sign_out_clears_the_cache() {
    use eclume_mobile_core::config::Config;
    use eclume_mobile_core::{cycle, lock};

    let (core, script, _guard) = connected_core("account-locale");
    {
        let mut core = lock(&core).unwrap();
        core.store_device_locale(Some("en-US".into())).unwrap();
        core.network_changed(true);
    }
    cycle(&core, true).unwrap();
    assert_eq!(lock(&core).unwrap().state().unwrap().locale, "pt-BR");
    script.reply(
        "GET",
        "/api/v1/me/locale",
        json(
            200,
            serde_json::json!({"locale": null, "effective": "pt-BR", "default": "en", "supported": ["en", "pt-BR"]}),
        ),
    );
    cycle(&core, true).unwrap();
    let mut core = lock(&core).unwrap();
    assert_eq!(core.config().account_locale, None);
    assert_eq!(core.state().unwrap().locale, "en");
    let saved = Config::load(&core.dirs().config()).unwrap();
    assert_eq!(saved.account_locale, None);
    assert_eq!(saved.device_locale.as_deref(), Some("en-US"));

    core.store_account_locale(Some("pt-BR".into())).unwrap();
    core.sign_out().unwrap();
    assert_eq!(core.state().unwrap().locale, "en");
    let saved = Config::load(&core.dirs().config()).unwrap();
    assert_eq!(saved.account_locale, None);
    assert_eq!(saved.device_locale.as_deref(), Some("en-US"));
}

#[test]
fn missing_account_locale_route_preserves_the_resolved_locale() {
    use eclume_mobile_core::{cycle, lock};

    let (core, script, _guard) = connected_core("locale-route-missing");
    script.reply("GET", "/api/v1/me/locale", common::text(404, ""));
    lock(&core).unwrap().network_changed(true);
    cycle(&core, true).unwrap();
    assert_eq!(lock(&core).unwrap().state().unwrap().locale, "en");
    lock(&core)
        .unwrap()
        .store_device_locale(Some("pt-PT".into()))
        .unwrap();
    cycle(&core, true).unwrap();
    assert_eq!(lock(&core).unwrap().state().unwrap().locale, "pt-BR");
    lock(&core)
        .unwrap()
        .store_account_locale(Some("en-GB".into()))
        .unwrap();
    cycle(&core, true).unwrap();
    let core = lock(&core).unwrap();
    assert_eq!(core.config().account_locale.as_deref(), Some("en-GB"));
    assert_eq!(core.state().unwrap().locale, "en");
    assert_eq!(script.count("GET", "/api/v1/me/locale"), 3);
}

/// The process opened only for the `SyncWorker` has no screen to report the Wi-Fi: the worker
/// cycle assumes the unmetered network WorkManager guarantees, and the probe runs.
#[test]
fn worker_cycle_probes_without_the_screen() {
    use eclume_mobile_core::{cycle, lock, worker_cycle};

    let (core, _script, _guard) = connected_core("worker");
    assert_eq!(cycle(&core, false).unwrap().map(|_| ()), None);
    worker_cycle(&core).unwrap();
    let core = lock(&core).unwrap();
    assert_eq!(core.state().unwrap().network, NetworkState::OnNetwork);
    assert_eq!(core.config().agenda_types[0].name, "Reunião");
}

/// The worker's probe says whether it is on the network and what waits; its cycle, whether it was
/// interrupted.
#[test]
fn worker_probe_and_report() {
    use eclume_mobile_core::{lock, worker_cycle, worker_probe};

    let (core, script, _guard) = connected_core("worker-sonda");
    let outcome = worker_probe(&core).unwrap();
    assert!(outcome.on_network);
    assert_eq!((outcome.pending, outcome.bytes), (0, 0));
    assert_eq!(worker_cycle(&core).unwrap(), None);

    let queue_dir = {
        let core = lock(&core).unwrap();
        let queue = core.queue();
        let queue = queue.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("eclume-worker-{}", std::process::id()));
        recording(&queue, &dir, "g1", 10);
        dir
    };
    assert_eq!(
        (
            worker_probe(&core).unwrap().pending,
            worker_probe(&core).unwrap().bytes
        ),
        (1, 10)
    );

    // The system stops the worker halfway: part 1 uploads, and the rest waits.
    upload_script(&script);
    let c = Arc::clone(&core);
    script.reply_with("PUT", "/api/v1/uploads/up-1/parts/1", move || {
        lock(&c).unwrap().interrupt_sync();
        Ok(HttpResponse {
            status: 200,
            headers: vec![("etag".into(), "\"e1\"".into())],
            body: Vec::new(),
        })
    });
    let report = worker_cycle(&core).unwrap().unwrap();
    assert!(report.interrupted);
    assert_eq!((report.report.synced, report.report.failed), (0, 0));
    let _ = std::fs::remove_dir_all(queue_dir);
}

/// A 401 on an authenticated read (the agenda types), with nothing to upload, also leads to sign-in.
#[test]
fn credential_revoked_on_a_read_goes_back_to_sign_in() {
    use eclume_mobile_core::connection::ConnectionState;
    use eclume_mobile_core::{cycle, lock};

    let (core, script, _guard) = connected_core("revogada");
    script.reply(
        "GET",
        "/api/v1/agenda-types",
        json(
            401,
            serde_json::json!({"title": "Não autenticado", "status": 401}),
        ),
    );
    lock(&core).unwrap().network_changed(true);
    assert_eq!(cycle(&core, false).unwrap().map(|_| ()), None);
    let core = lock(&core).unwrap();
    assert_eq!(core.state().unwrap().network, NetworkState::NoCredential);
    assert!(matches!(
        core.state().unwrap().connection,
        ConnectionState::NoCredential { .. }
    ));
}

/// Reopens the connected core with `ca` in place of `ca.pem`.
fn reopened_with_ca(name: &str, ca: &str) -> (eclume_mobile_core::Core, common::Cleanup) {
    use eclume_mobile_core::{lock, Core};

    let (core, script, guard) = connected_core(name);
    let dirs = lock(&core).unwrap().dirs().clone();
    drop(core);
    std::fs::write(dirs.ca(), ca).unwrap();
    let transports = Arc::new(common::FakeTransports(script));
    let core = Core::open(dirs, "0.1.0", transports).unwrap();
    (core, guard)
}

#[test]
fn stored_ca_with_an_extra_certificate_asks_for_a_new_sign_in() {
    use eclume_mobile_core::connection::ConnectionState;

    let other = include_str!("../../../../server/tests/fixtures/ca-test.pem");
    let (core, _guard) = reopened_with_ca("ca-a-mais", &format!("{}{other}", common::CA_PEM));
    let ConnectionState::NoCredential { reason, .. } = core.state().unwrap().connection else {
        panic!("expected the sign-in screen");
    };
    assert_eq!(reason.as_deref(), Some(eclume_sync::pin::CA_TRIMMED));
    assert!(!core.dirs().token().exists());
    let ca = std::fs::read_to_string(core.dirs().ca()).unwrap();
    assert_eq!(ca, common::CA_PEM);

    // With a single certificate, nothing changes.
    let (core, _guard) = reopened_with_ca("ca-unica", common::CA_PEM);
    assert!(matches!(
        core.state().unwrap().connection,
        ConnectionState::Connected { .. }
    ));
    assert_eq!(
        std::fs::read_to_string(core.dirs().ca()).unwrap(),
        common::CA_PEM
    );
}

/// Root rotation: the probe stores the next root the pinned descriptor announces and, when the
/// server switches (TLS refuses the pinned one), swaps it in without pairing again; another switch
/// without an announcement keeps reporting the changed CA.
#[test]
fn ca_swapped_for_the_next_without_pairing_again() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use eclume_mobile_core::{lock, probe as probe_core};

    const OTHER_CA: &str = include_str!("../../../../server/tests/fixtures/ca-test.pem");
    let other = eclume_sync::pin::root_from_pem(OTHER_CA.as_bytes()).unwrap();
    let other = other.sha256;
    let (core, script, _guard) = connected_core("proxima");
    let announced = other.clone();
    script.reply(
        "GET",
        "/api/v1/server",
        json(
            200,
            serde_json::json!({"name": "eclume", "url": URL, "ca_sha256": CA_SHA256,
                "ca_next_sha256": announced}),
        ),
    );
    script.reply(
        "GET",
        "/downloads/eclume-root-proxima.crt",
        common::text(200, OTHER_CA),
    );
    lock(&core).unwrap().network_changed(true);
    assert!(probe_core(&core, true).unwrap().on_network);
    let next = eclume_sync::pin::next_path(&lock(&core).unwrap().dirs().ca());
    assert_eq!(std::fs::read_to_string(&next).unwrap(), OTHER_CA);

    // The switch: the probe through the pinned one fails in TLS; the check through the next one
    // answers with it.
    let calls = Arc::new(AtomicUsize::new(0));
    let (counter, switched) = (Arc::clone(&calls), other.clone());
    script.reply_with("GET", "/api/v1/server", move || {
        if counter.fetch_add(1, Ordering::SeqCst) % 2 == 0 {
            common::failure("invalid peer certificate: UnknownIssuer")
        } else {
            json(
                200,
                serde_json::json!({"name": "eclume", "url": URL, "ca_sha256": switched}),
            )
        }
    });
    assert!(probe_core(&core, true).unwrap().on_network);
    {
        let core = lock(&core).unwrap();
        assert_eq!(core.config().server.as_ref().unwrap().ca_sha256, other);
        assert_eq!(std::fs::read_to_string(core.dirs().ca()).unwrap(), OTHER_CA);
        assert!(!next.exists());
        assert_eq!(core.state().unwrap().network, NetworkState::OnNetwork);
    }

    // Another root, with no next one stored: the CA really changed.
    script.reply(
        "GET",
        "/api/v1/server",
        common::failure("invalid peer certificate: UnknownIssuer"),
    );
    assert!(!probe_core(&core, true).unwrap().on_network);
    let core = lock(&core).unwrap();
    assert_eq!(core.state().unwrap().network, NetworkState::CaMismatch);
}
