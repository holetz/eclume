//! A rede do eclume e o sync, sem rede: a máquina de estados, a sonda e uma passada de sync
//! completa pelo transporte roteirizado.

mod comum;

use std::path::Path;
use std::sync::{Arc, Mutex};

use comum::{dirs_temp, json, Roteiro, CA_SHA256};
use eclume_mobile_core::config::Servidor;
use eclume_mobile_core::rede::{sondar, Andamento, EstadoRede, Rede, Sonda};
use eclume_mobile_core::sync::{
    baixar_apk, buscar_etapas, buscar_manifesto, buscar_tipos_de_agenda, bytes_sincronizados,
    excluir_sincronizadas, mais_nova, reter, sincronizar, uploader, Medidor,
};
use eclume_recorder::{now_ms, Queue, Source, Status};
use eclume_sync::transport::HttpResponse;

const URL: &str = "https://eclume.test:8443";

fn servidor() -> Servidor {
    Servidor {
        url: URL.into(),
        nome: "eclume".into(),
        ca_sha256: CA_SHA256.into(),
    }
}

#[test]
fn na_rede_so_com_wifi_nao_medido_e_sonda_ok() {
    let mut rede = Rede::default();
    assert_eq!(rede.estado(), EstadoRede::Away);
    // Nos dados móveis, a sonda nem roda.
    assert!(!rede.precisa_sondar(0, true));

    assert!(rede.mudou_wifi(true));
    assert!(rede.precisa_sondar(0, true));
    assert_eq!(rede.estado(), EstadoRede::Away);
    rede.registrar_sonda(1_000, Sonda::Ok);
    assert_eq!(rede.estado(), EstadoRede::OnNetwork);
    assert!(rede.na_rede());
    // Visível, repete a cada 60 s; em segundo plano, não.
    assert!(!rede.precisa_sondar(30_000, true));
    assert!(rede.precisa_sondar(61_000, true));
    assert!(!rede.precisa_sondar(61_000, false));

    let andamento = Andamento {
        i: 1,
        n: 2,
        pct: 64,
        bytes_s: 18_000_000,
    };
    rede.sync_andando(andamento);
    assert_eq!(rede.estado(), EstadoRede::Syncing(andamento));
    rede.sync_terminou();

    rede.registrar_sonda(62_000, Sonda::SemResposta);
    assert_eq!(rede.estado(), EstadoRede::Away);
    rede.registrar_sonda(63_000, Sonda::CaMudou);
    assert_eq!(rede.estado(), EstadoRede::CaMismatch);
    assert!(!rede.na_rede());

    // Trocar de rede invalida a sonda.
    rede.registrar_sonda(64_000, Sonda::Ok);
    assert!(rede.mudou_wifi(false));
    assert_eq!(rede.estado(), EstadoRede::Away);
    assert!(!rede.mudou_wifi(false));
    rede.mudou_wifi(true);
    assert!(rede.precisa_sondar(64_001, false));

    rede.perdeu_credencial();
    assert_eq!(rede.estado(), EstadoRede::SemCredencial);
    assert!(!rede.pode_sondar());
    rede.recuperou_credencial();
    assert!(rede.pode_sondar());
}

#[test]
fn sonda_confere_a_impressao_digital() {
    let roteiro = Roteiro::default();
    let info = |ca: &str| {
        json(
            200,
            serde_json::json!({"name": "eclume", "url": URL, "ca_sha256": ca}),
        )
    };
    roteiro.responde("GET", "/api/v1/server", info(CA_SHA256));
    assert_eq!(sondar(Arc::new(roteiro.clone()), &servidor()), Sonda::Ok);
    roteiro.responde("GET", "/api/v1/server", info(&"11".repeat(32)));
    assert_eq!(
        sondar(Arc::new(roteiro.clone()), &servidor()),
        Sonda::CaMudou
    );
    roteiro.responde("GET", "/api/v1/server", comum::falha("tempo esgotado"));
    assert_eq!(
        sondar(Arc::new(roteiro.clone()), &servidor()),
        Sonda::SemResposta
    );
    roteiro.responde(
        "GET",
        "/api/v1/server",
        comum::falha("invalid peer certificate: UnknownIssuer"),
    );
    assert_eq!(sondar(Arc::new(roteiro), &servidor()), Sonda::CaMudou);
}

/// Uma gravação `pending` com um arquivo de `bytes` bytes.
fn gravacao(fila: &Queue, dir: &Path, id: &str, bytes: usize) {
    std::fs::create_dir_all(dir).unwrap();
    let path = dir.join(format!("{id}.ogg"));
    std::fs::write(&path, vec![7_u8; bytes]).unwrap();
    fila.begin(id, &dir.join(format!("{id}.ogg.part")), now_ms() - 60_000)
        .unwrap();
    fila.finish(id, &path, now_ms(), 60_000, bytes as i64)
        .unwrap();
    fila.set_source(id, Source::Mobile).unwrap();
}

fn roteiro_de_upload(roteiro: &Roteiro) {
    roteiro.responde(
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
        roteiro.responde(
            "PUT",
            &format!("/api/v1/uploads/up-1/parts/{n}"),
            Ok(HttpResponse {
                status: 200,
                headers: vec![("etag".into(), format!("\"e{n}\""))],
                body: Vec::new(),
            }),
        );
    }
    roteiro.responde(
        "POST",
        "/api/v1/uploads/up-1/complete",
        json(
            201,
            serde_json::json!({"id": "rec-remoto", "status": "queued"}),
        ),
    );
}

#[test]
fn sync_sobe_com_andamento_e_retencao_apaga_so_o_confirmado() {
    let (dirs, _guard) = dirs_temp("sync");
    let roteiro = Roteiro::default();
    roteiro_de_upload(&roteiro);
    let fila = Arc::new(Mutex::new(Queue::open(&dirs.fila()).unwrap()));
    gravacao(&fila.lock().unwrap(), &dirs.gravacoes(), "g1", 10);
    let medidor = Arc::new(Medidor::default());
    let up = uploader(
        Arc::new(roteiro.clone()),
        Arc::clone(&medidor),
        &servidor(),
        "eclp_dispositivo",
        Arc::clone(&fila),
        "eclume-android/0.1.0",
        "Pixel 8",
    )
    .unwrap();

    let relatorio = sincronizar(&fila, &up, &medidor).unwrap();
    assert_eq!(relatorio.synced, 1);
    let andamento = medidor.andamento();
    assert_eq!((andamento.i, andamento.n, andamento.pct), (1, 1, 100));
    assert!(!medidor.credencial_recusada());
    let criacao = roteiro.pedido("POST", "/api/v1/uploads").unwrap();
    let corpo: serde_json::Value = serde_json::from_slice(&criacao.body).unwrap();
    assert_eq!(corpo["source"], "mobile");
    assert_eq!(corpo["capture"]["device_name"], "Pixel 8");
    assert_eq!(corpo["capture"]["client_version"], "eclume-android/0.1.0");
    let rec = fila.lock().unwrap().get("g1").unwrap().unwrap();
    assert_eq!(rec.status, Status::Synced);
    assert_eq!(rec.remote_id.as_deref(), Some("rec-remoto"));

    // A retenção de 7 dias ainda guarda o que acabou de subir; "Excluir sincronizadas" apaga já.
    assert_eq!(reter(&fila, now_ms(), 7).unwrap(), 0);
    assert_eq!(bytes_sincronizados(&fila).unwrap(), 10);
    assert_eq!(reter(&fila, now_ms() + 8 * 86_400_000, 7).unwrap(), 1);
    assert!(!rec.path.exists());
    assert_eq!(excluir_sincronizadas(&fila).unwrap(), (0, 0));
}

/// O Wi-Fi cai depois da primeira parte: a segunda não sai, a gravação volta à fila sem gastar
/// tentativa e, no próximo Wi-Fi, sobe só a parte que falta.
#[test]
fn wifi_que_cai_no_meio_interrompe_e_retoma_das_partes_que_faltam() {
    let (dirs, _guard) = dirs_temp("sync-interrompido");
    let roteiro = Roteiro::default();
    roteiro_de_upload(&roteiro);
    let medidor = Arc::new(Medidor::default());
    {
        let medidor = Arc::clone(&medidor);
        roteiro.responde_com("PUT", "/api/v1/uploads/up-1/parts/1", move || {
            // O callback do sistema avisa a troca de rede enquanto a parte 1 sobe.
            medidor.interromper();
            Ok(HttpResponse {
                status: 200,
                headers: vec![("etag".into(), "\"e1\"".into())],
                body: Vec::new(),
            })
        });
    }
    let fila = Arc::new(Mutex::new(Queue::open(&dirs.fila()).unwrap()));
    gravacao(&fila.lock().unwrap(), &dirs.gravacoes(), "g1", 10);
    let up = uploader(
        Arc::new(roteiro.clone()),
        Arc::clone(&medidor),
        &servidor(),
        "eclp_dispositivo",
        Arc::clone(&fila),
        "eclume-android/0.1.0",
        "Pixel 8",
    )
    .unwrap();

    let relatorio = sincronizar(&fila, &up, &medidor).unwrap();
    assert_eq!((relatorio.synced, relatorio.failed), (0, 0));
    assert_eq!(roteiro.quantos("PUT", "/api/v1/uploads/up-1/parts/1"), 1);
    assert_eq!(roteiro.quantos("PUT", "/api/v1/uploads/up-1/parts/2"), 0);
    assert_eq!(roteiro.quantos("POST", "/api/v1/uploads/up-1/complete"), 0);
    let rec = fila.lock().unwrap().get("g1").unwrap().unwrap();
    assert_eq!((rec.status, rec.attempts), (Status::Pending, 0));
    assert_eq!(rec.upload_id.as_deref(), Some("up-1"));

    // De volta ao Wi-Fi do eclume: o servidor já tem a parte 1, e só a 2 sobe.
    roteiro.responde(
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
    medidor.retomar();
    let relatorio = sincronizar(&fila, &up, &medidor).unwrap();
    assert_eq!(relatorio.synced, 1);
    assert_eq!(roteiro.quantos("PUT", "/api/v1/uploads/up-1/parts/1"), 1);
    assert_eq!(roteiro.quantos("PUT", "/api/v1/uploads/up-1/parts/2"), 1);
    let rec = fila.lock().unwrap().get("g1").unwrap().unwrap();
    assert_eq!(rec.status, Status::Synced);
}

#[test]
fn sync_nota_o_401_e_a_folha_aberta_segura_a_gravacao() {
    let (dirs, _guard) = dirs_temp("sync-401");
    let roteiro = Roteiro::default();
    roteiro.responde(
        "POST",
        "/api/v1/uploads",
        json(
            401,
            serde_json::json!({"title": "Não autenticado", "status": 401}),
        ),
    );
    let fila = Arc::new(Mutex::new(Queue::open(&dirs.fila()).unwrap()));
    gravacao(&fila.lock().unwrap(), &dirs.gravacoes(), "g1", 10);
    gravacao(&fila.lock().unwrap(), &dirs.gravacoes(), "folha", 10);
    fila.lock().unwrap().set_details_pending("folha").unwrap();
    let medidor = Arc::new(Medidor::default());
    let up = uploader(
        Arc::new(roteiro.clone()),
        Arc::clone(&medidor),
        &servidor(),
        "eclp_dispositivo",
        Arc::clone(&fila),
        "eclume-android/0.1.0",
        "Pixel 8",
    )
    .unwrap();
    let relatorio = sincronizar(&fila, &up, &medidor).unwrap();
    assert_eq!((relatorio.synced, relatorio.failed), (0, 1));
    assert!(medidor.credencial_recusada());
    assert_eq!(roteiro.quantos("POST", "/api/v1/uploads"), 1);
    let folha = fila.lock().unwrap().get("folha").unwrap().unwrap();
    assert_eq!(folha.status, Status::Pending);
}

#[test]
fn tipos_de_agenda_e_etapas_no_servidor() {
    let roteiro = Roteiro::default();
    roteiro.responde(
        "GET",
        "/api/v1/agenda-types",
        json(
            200,
            serde_json::json!({"items": [{"id": "t1", "name": "Reunião de equipe"}], "next_cursor": null}),
        ),
    );
    roteiro.responde(
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
    let tipos = buscar_tipos_de_agenda(&roteiro, &servidor(), "eclp_x").unwrap();
    assert_eq!(tipos[0].nome, "Reunião de equipe");
    let pedido = roteiro.pedido("GET", "/api/v1/agenda-types").unwrap();
    assert!(pedido
        .headers
        .iter()
        .any(|(k, v)| k == "Authorization" && v == "Bearer eclp_x"));
    let no_servidor = buscar_etapas(&roteiro, &servidor(), "eclp_x", "rec-remoto").unwrap();
    // Servidor anterior à 2.16.0, sem `job.queue`: sem espera.
    assert_eq!(no_servidor.espera, None);
    let etapas = no_servidor.etapas;
    assert_eq!(etapas[1].state, "active");
    assert_eq!(etapas[1].reason, None);
    assert_eq!(etapas[2].reason.as_deref(), Some("no_provider"));
    assert_eq!(
        etapas[3].error.as_ref().map(|e| e.message.as_str()),
        Some("O agente não respondeu.")
    );
}

#[test]
fn espera_na_fila_do_servidor() {
    let roteiro = Roteiro::default();
    roteiro.responde(
        "GET",
        "/api/v1/recordings/rec-remoto",
        json(
            200,
            serde_json::json!({"id": "rec-remoto", "pipeline": [], "job": {"state": "queued", "queue": {
                "reason": "processor_queue", "ahead": 2, "account_ahead": null,
                "estimated_start_at": "2026-10-01T14:14:00Z", "resumes_at": null,
                "processor": {"online": false, "offline_since": "2026-10-01T14:02:00Z"}
            }}}),
        ),
    );
    let espera = buscar_etapas(&roteiro, &servidor(), "eclp_x", "rec-remoto")
        .unwrap()
        .espera
        .unwrap();
    assert_eq!(espera.reason, "processor_queue");
    assert_eq!(espera.ahead, Some(2));
    assert_eq!(espera.account_ahead, None);
    let processador = espera.processor.unwrap();
    assert!(!processador.online);
    assert_eq!(
        processador.offline_since.as_deref(),
        Some("2026-10-01T14:02:00Z")
    );
}

#[test]
fn atualizacao_pelo_movel_json_confere_o_apk() {
    assert!(mais_nova("0.2.0", "0.1.0"));
    assert!(mais_nova("0.10.0", "0.9.9"));
    assert!(!mais_nova("0.1.0", "0.1.0"));
    assert!(!mais_nova("0.0.9", "0.1.0"));
    assert!(!mais_nova("versão", "0.1.0"));

    let apk = b"PK apk novo".to_vec();
    let sha = eclume_sync::pin::sha256_hex(&apk);
    let roteiro = Roteiro::default();
    assert_eq!(
        {
            roteiro.responde("GET", "/downloads/movel.json", comum::texto(404, ""));
            buscar_manifesto(&roteiro, &servidor()).unwrap()
        },
        None
    );
    roteiro.responde(
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
    let manifesto = buscar_manifesto(&roteiro, &servidor()).unwrap().unwrap();
    assert_eq!(manifesto.versao, "0.2.0");

    let (dirs, _guard) = dirs_temp("apk");
    roteiro.responde(
        "GET",
        "/downloads/movel/0.2.0/eclume-0.2.0.apk",
        Ok(HttpResponse {
            status: 200,
            headers: Vec::new(),
            body: apk.clone(),
        }),
    );
    let caminho = baixar_apk(&roteiro, &servidor(), &manifesto, &dirs.dados).unwrap();
    assert_eq!(std::fs::read(&caminho).unwrap(), apk);
    let pedido = roteiro
        .pedido("GET", "/downloads/movel/0.2.0/eclume-0.2.0.apk")
        .unwrap();
    assert_eq!(
        pedido.url,
        format!("{URL}/downloads/movel/0.2.0/eclume-0.2.0.apk")
    );

    // Um APK que não bate com o manifesto não é instalado.
    roteiro.responde(
        "GET",
        "/downloads/movel/0.2.0/eclume-0.2.0.apk",
        Ok(HttpResponse {
            status: 200,
            headers: Vec::new(),
            body: b"PK adulterado".to_vec(),
        }),
    );
    let erro = baixar_apk(&roteiro, &servidor(), &manifesto, &dirs.sem_backup).unwrap_err();
    assert!(format!("{erro:#}").contains("não confere"), "{erro:#}");
    assert!(!dirs.sem_backup.exists());
}

/// Um núcleo conectado e com credencial, sobre um roteiro com a sonda e os tipos de agenda.
fn nucleo_conectado(nome: &str) -> (Arc<Mutex<eclume_mobile_core::Core>>, Roteiro, comum::Limpa) {
    use eclume_mobile_core::{trancar, Core};

    let (dirs, guard) = dirs_temp(nome);
    let roteiro = Roteiro::default();
    roteiro.responde(
        "GET",
        "/downloads/eclume-root.crt",
        comum::texto(200, comum::CA_PEM),
    );
    roteiro.responde(
        "GET",
        "/api/v1/server",
        json(
            200,
            serde_json::json!({"name": "eclume", "url": URL, "ca_sha256": CA_SHA256}),
        ),
    );
    roteiro.responde(
        "POST",
        "/api/v1/devices/login",
        json(
            201,
            serde_json::json!({"token": {"id": "t1", "name": "Pixel 8"}, "secret": "eclp_segredo",
                "server": {"name": "eclume", "url": URL, "ca_sha256": CA_SHA256}}),
        ),
    );
    roteiro.responde(
        "GET",
        "/api/v1/agenda-types",
        json(
            200,
            serde_json::json!({"items": [{"id": "t1", "name": "Reunião"}], "next_cursor": null}),
        ),
    );
    roteiro.responde("GET", "/downloads/movel.json", comum::texto(404, ""));
    let nucleo = Arc::new(Mutex::new(
        Core::abrir(
            dirs,
            "0.1.0",
            Arc::new(comum::TransportesFalsos(roteiro.clone())),
        )
        .unwrap(),
    ));
    {
        let mut core = trancar(&nucleo).unwrap();
        core.conectar_endereco(URL).unwrap();
        core.confiar_ca().unwrap();
        core.entrar("ana@eclume.test", "senha").unwrap();
    }
    (nucleo, roteiro, guard)
}

/// Um ciclo inteiro pelo núcleo (sonda, tipos, atualização, sync) não pode travar a si mesmo: a
/// rede roda fora da trava do núcleo.
#[test]
fn ciclo_completo_nao_trava_o_nucleo() {
    use eclume_mobile_core::{ciclo, trancar};

    let (nucleo, _roteiro, _guard) = nucleo_conectado("ciclo");
    trancar(&nucleo).unwrap().mudou_rede(true);
    let (fim, recebe) = std::sync::mpsc::channel();
    let n = Arc::clone(&nucleo);
    std::thread::spawn(move || {
        let _ = fim.send(
            ciclo(&n, true)
                .map(|r| r.is_some())
                .map_err(|e| format!("{e:#}")),
        );
    });
    let resultado = recebe
        .recv_timeout(std::time::Duration::from_secs(10))
        .expect("o ciclo travou o núcleo");
    assert_eq!(resultado, Ok(false));
    let core = trancar(&nucleo).unwrap();
    assert_eq!(core.estado().unwrap().rede, EstadoRede::OnNetwork);
    assert_eq!(core.config().tipos_de_agenda[0].nome, "Reunião");
}

/// O processo aberto só para o `SyncWorker` não tem a tela para avisar o Wi-Fi: o ciclo do worker
/// parte da rede não medida que o WorkManager garante, e a sonda roda.
#[test]
fn ciclo_do_worker_sonda_sem_a_tela() {
    use eclume_mobile_core::{ciclo, ciclo_do_worker, trancar};

    let (nucleo, _roteiro, _guard) = nucleo_conectado("worker");
    assert_eq!(ciclo(&nucleo, false).unwrap().map(|_| ()), None);
    ciclo_do_worker(&nucleo).unwrap();
    let core = trancar(&nucleo).unwrap();
    assert_eq!(core.estado().unwrap().rede, EstadoRede::OnNetwork);
    assert_eq!(core.config().tipos_de_agenda[0].nome, "Reunião");
}

/// A sonda do worker diz se está na rede e o que aguarda; o ciclo dele, se foi interrompido.
#[test]
fn sondagem_e_relatorio_do_worker() {
    use eclume_mobile_core::{ciclo_do_worker, sondar_do_worker, trancar};

    let (nucleo, roteiro, _guard) = nucleo_conectado("worker-sonda");
    let sondagem = sondar_do_worker(&nucleo).unwrap();
    assert!(sondagem.na_rede);
    assert_eq!((sondagem.pendentes, sondagem.bytes), (0, 0));
    assert_eq!(ciclo_do_worker(&nucleo).unwrap(), None);

    let dirs_fila = {
        let core = trancar(&nucleo).unwrap();
        let fila = core.fila();
        let fila = fila.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("eclume-worker-{}", std::process::id()));
        gravacao(&fila, &dir, "g1", 10);
        dir
    };
    assert_eq!(
        (
            sondar_do_worker(&nucleo).unwrap().pendentes,
            sondar_do_worker(&nucleo).unwrap().bytes
        ),
        (1, 10)
    );

    // O sistema para o worker no meio: a parte 1 sobe, e o resto espera.
    roteiro_de_upload(&roteiro);
    let n = Arc::clone(&nucleo);
    roteiro.responde_com("PUT", "/api/v1/uploads/up-1/parts/1", move || {
        trancar(&n).unwrap().interromper_sync();
        Ok(HttpResponse {
            status: 200,
            headers: vec![("etag".into(), "\"e1\"".into())],
            body: Vec::new(),
        })
    });
    let relatorio = ciclo_do_worker(&nucleo).unwrap().unwrap();
    assert!(relatorio.interrompido);
    assert_eq!(
        (relatorio.relatorio.synced, relatorio.relatorio.failed),
        (0, 0)
    );
    let _ = std::fs::remove_dir_all(dirs_fila);
}

/// Um 401 numa leitura autenticada (os tipos de agenda), sem nada para subir, também leva a Entrar.
#[test]
fn credencial_revogada_na_leitura_volta_a_entrar() {
    use eclume_mobile_core::conexao::EstadoConexao;
    use eclume_mobile_core::{ciclo, trancar};

    let (nucleo, roteiro, _guard) = nucleo_conectado("revogada");
    roteiro.responde(
        "GET",
        "/api/v1/agenda-types",
        json(
            401,
            serde_json::json!({"title": "Não autenticado", "status": 401}),
        ),
    );
    trancar(&nucleo).unwrap().mudou_rede(true);
    assert_eq!(ciclo(&nucleo, false).unwrap().map(|_| ()), None);
    let core = trancar(&nucleo).unwrap();
    assert_eq!(core.estado().unwrap().rede, EstadoRede::SemCredencial);
    assert!(matches!(
        core.estado().unwrap().conexao,
        EstadoConexao::SemCredencial { .. }
    ));
}
