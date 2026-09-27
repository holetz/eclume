//! A rede do eclume e o sync, sem rede: a máquina de estados, a sonda e uma passada de sync
//! completa pelo transporte roteirizado.

mod comum;

use std::path::Path;
use std::sync::{Arc, Mutex};

use comum::{dirs_temp, json, Roteiro, CA_SHA256};
use eclume_mobile_core::config::Servidor;
use eclume_mobile_core::rede::{sondar, Andamento, EstadoRede, Rede, Sonda};
use eclume_mobile_core::sync::{
    buscar_etapas, buscar_tipos_de_agenda, bytes_sincronizados, excluir_sincronizadas, reter,
    sincronizar, uploader, Medidor,
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
                {"step": "transcription", "state": "active"}
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
    let etapas = buscar_etapas(&roteiro, &servidor(), "eclp_x", "rec-remoto").unwrap();
    assert_eq!(etapas[1].state, "active");
}
