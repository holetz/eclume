//! A sessão de gravação pelo núcleo, com uma fonte sintética no lugar do microfone.

mod comum;

use std::sync::Arc;
use std::time::Duration;

use comum::{dirs_temp, Roteiro, TransportesFalsos};
use eclume_mobile_core::sessao::EstadoMicrofone;
use eclume_mobile_core::{Core, MotivoDaParada, Selo};
use eclume_recorder::source::SineSource;
use eclume_recorder::{AudioSource, Queue, Source, SourceState, Status};

/// Um seno entregue em tempo real, como um microfone: 10 ms por leitura.
struct Microfone(SineSource);

impl AudioSource for Microfone {
    fn sample_rate(&self) -> u32 {
        self.0.sample_rate()
    }

    fn read(&mut self, timeout: Duration) -> Option<Vec<f32>> {
        std::thread::sleep(Duration::from_millis(10));
        self.0.read(timeout)
    }
}

fn microfone(segundos: u64) -> Box<dyn AudioSource> {
    Box::new(Microfone(SineSource::new(
        48_000,
        440.0,
        0.4,
        Duration::from_secs(segundos),
    )))
}

fn abrir(dirs: eclume_mobile_core::config::Dirs) -> Core {
    Core::abrir(
        dirs,
        "0.1.0",
        Arc::new(TransportesFalsos(Roteiro::default())),
    )
    .unwrap()
}

#[test]
fn gravar_pausar_marcar_parar_e_salvar() {
    let (dirs, _guard) = dirs_temp("sessao");
    let mut core = abrir(dirs.clone());
    core.definir_aparelho("Pixel 8").unwrap();
    let id = core.gravar(microfone(30)).unwrap();
    assert!(core.gravar(microfone(1)).is_err());
    std::thread::sleep(Duration::from_millis(200));

    let marcador = core.marcar(None).unwrap();
    assert!(marcador.at_ms > 0);
    let anotado = core
        .anotar_marcador(&marcador.client_id, Some("Decisão do orçamento"))
        .unwrap();
    assert_eq!(anotado.note.as_deref(), Some("Decisão do orçamento"));

    core.pausar().unwrap();
    std::thread::sleep(Duration::from_millis(30));
    let estado = core.estado().unwrap();
    let sessao = estado.sessao.unwrap();
    assert!(sessao.pausada);
    assert_eq!(sessao.marcadores.len(), 1);
    let pausado_em = sessao.audio_ms;
    std::thread::sleep(Duration::from_millis(250));
    assert_eq!(core.estado().unwrap().sessao.unwrap().audio_ms, pausado_em);
    core.continuar().unwrap();
    std::thread::sleep(Duration::from_millis(100));

    let gravacao = core.parar().unwrap();
    assert_eq!(gravacao.id, id);
    assert_eq!(gravacao.source, Source::Mobile);
    assert!(gravacao.details_pending);
    let folha = core.estado().unwrap().folha.unwrap();
    assert_eq!((folha.id.as_str(), folha.marcadores), (id.as_str(), 1));
    assert_eq!(core.estado().unwrap().pendentes, 1);

    core.salvar(&id, Some("Visita ao cliente"), None, Some("en"))
        .unwrap();
    assert_eq!(core.estado().unwrap().folha, None);
    let lista = core.gravacoes().unwrap();
    assert_eq!(lista[0].titulo.as_deref(), Some("Visita ao cliente"));
    assert_eq!(lista[0].selo, Selo::Aguardando);
    assert_eq!(lista[0].marcadores, 1);
    let fila = core.fila().lock().unwrap();
    assert_eq!(
        fila.get(&id).unwrap().unwrap().language.as_deref(),
        Some("en")
    );
    drop(fila);
    let detalhe = core.gravacao(&id).unwrap();
    assert!(detalhe.caminho.unwrap().ends_with(".ogg"));
    // Só depois de sincronizada sai do celular.
    assert!(core.excluir_local(&id).is_err());
}

#[test]
fn queda_no_meio_fica_interrompida_e_sem_folha() {
    let (dirs, _guard) = dirs_temp("queda");
    {
        let fila = Queue::open(&dirs.fila()).unwrap();
        std::fs::create_dir_all(dirs.gravacoes()).unwrap();
        let part = dirs.gravacoes().join("orfa.ogg.part");
        std::fs::write(&part, b"OggS parcial").unwrap();
        fila.begin("orfa", &part, 1).unwrap();
        fila.set_details_pending("orfa").unwrap();
    }
    let core = abrir(dirs.clone());
    let lista = core.gravacoes().unwrap();
    assert_eq!(lista[0].selo, Selo::Interrompida);
    let rec = core.fila().lock().unwrap().get("orfa").unwrap().unwrap();
    assert_eq!(rec.status, Status::Pending);
    assert!(!rec.details_pending);
    assert!(dirs.gravacoes().join("orfa.ogg").exists());
}

#[test]
fn limites_param_sem_espaco_e_avisam() {
    let (dirs, _guard) = dirs_temp("limites");
    let mut core = abrir(dirs);
    // 40 min de espaço a 24 kbps: aviso no Início.
    core.atualizar_aparelho(80, false, 7_200_000);
    let aviso = core.estado().unwrap().avisos.armazenamento.unwrap();
    assert_eq!(aviso.restante, "cerca de 40 min");
    assert_eq!(
        core.estado().unwrap().espaco_livre.as_deref(),
        Some("cerca de 40 min")
    );

    core.gravar(microfone(30)).unwrap();
    std::thread::sleep(Duration::from_millis(100));
    assert!(core.verificar_limites().unwrap().is_none());
    // Menos de 5 min livres: para e salva sozinho.
    core.atualizar_aparelho(12, false, 600_000);
    assert_eq!(core.estado().unwrap().avisos.bateria.unwrap().pct, 12);
    let (parada, motivo) = core.verificar_limites().unwrap().unwrap();
    assert_eq!(parada.status, Status::Pending);
    assert_eq!(motivo, MotivoDaParada::SemEspaco);
    assert_eq!(
        serde_json::to_value(motivo).unwrap(),
        serde_json::json!("sem_espaco")
    );
    assert!(core.estado().unwrap().sessao.is_none());
    assert!(core.estado().unwrap().avisos.bateria.is_none());
}

/// Um microfone que cai em `fora.0` e volta em `fora.1` (desde a abertura), como a fonte que se
/// reconecta informa: silêncio e `Reconnecting` enquanto está fora.
struct MicrofoneQueCai {
    seno: Microfone,
    aberto: std::time::Instant,
    fora: (Duration, Duration),
}

impl AudioSource for MicrofoneQueCai {
    fn sample_rate(&self) -> u32 {
        self.seno.sample_rate()
    }

    fn read(&mut self, timeout: Duration) -> Option<Vec<f32>> {
        let amostras = self.seno.read(timeout)?;
        Some(match self.state() {
            SourceState::Live => amostras,
            SourceState::Reconnecting { .. } => vec![0.0; amostras.len()],
        })
    }

    fn state(&self) -> SourceState {
        let agora = self.aberto.elapsed();
        if agora >= self.fora.0 && agora < self.fora.1 {
            SourceState::Reconnecting {
                since: self.aberto + self.fora.0,
            }
        } else {
            SourceState::Live
        }
    }
}

#[test]
fn microfone_que_cai_segue_gravando_e_vira_marcadores() {
    let (dirs, _guard) = dirs_temp("microfone");
    let mut core = abrir(dirs);
    let fonte = MicrofoneQueCai {
        seno: Microfone(SineSource::new(48_000, 440.0, 0.4, Duration::from_secs(60))),
        aberto: std::time::Instant::now(),
        fora: (Duration::from_millis(300), Duration::from_millis(6_000)),
    };
    core.gravar(Box::new(fonte)).unwrap();
    std::thread::sleep(Duration::from_millis(800));
    core.vigiar().unwrap();
    let sessao = core.estado().unwrap().sessao.unwrap();
    assert_eq!(sessao.microfone, EstadoMicrofone::Reconectando);
    // Menos de 5 s fora: ainda sem marcador.
    assert!(sessao.marcadores.is_empty());

    std::thread::sleep(Duration::from_millis(4_800));
    core.vigiar().unwrap();
    let marcadores = core.estado().unwrap().sessao.unwrap().marcadores;
    assert_eq!(marcadores.len(), 1);
    assert_eq!(marcadores[0].note.as_deref(), Some("microfone perdido"));

    std::thread::sleep(Duration::from_millis(700));
    core.vigiar().unwrap();
    let sessao = core.estado().unwrap().sessao.unwrap();
    assert_eq!(sessao.microfone, EstadoMicrofone::Ok);
    assert_eq!(sessao.marcadores.len(), 2);
    assert_eq!(
        sessao.marcadores[1].note.as_deref(),
        Some("microfone de volta")
    );
    assert!(
        core.verificar_limites().unwrap().is_none(),
        "a gravação seguiu"
    );
    core.parar().unwrap();
}

#[test]
fn silencio_imposto_pelo_sistema_aparece_e_marca() {
    let (dirs, _guard) = dirs_temp("silenciada");
    let mut core = abrir(dirs);
    assert!(
        core.silenciar(true).is_err(),
        "sem gravação, nada a silenciar"
    );
    core.gravar(microfone(30)).unwrap();
    std::thread::sleep(Duration::from_millis(100));
    core.silenciar(true).unwrap();
    core.silenciar(true).unwrap();
    let sessao = core.estado().unwrap().sessao.unwrap();
    assert!(sessao.silenciada);
    assert_eq!(sessao.marcadores.len(), 1);
    assert_eq!(
        sessao.marcadores[0].note.as_deref(),
        Some("silenciado pelo sistema")
    );
    core.silenciar(false).unwrap();
    assert!(!core.estado().unwrap().sessao.unwrap().silenciada);
    core.parar().unwrap();
}
