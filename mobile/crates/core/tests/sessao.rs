//! A sessão de gravação pelo núcleo, com uma fonte sintética no lugar do microfone.

mod comum;

use std::sync::Arc;
use std::time::Duration;

use comum::{dirs_temp, Roteiro, TransportesFalsos};
use eclume_mobile_core::{Core, Selo};
use eclume_recorder::source::SineSource;
use eclume_recorder::{AudioSource, Queue, Source, Status};

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

    core.salvar(&id, Some("Visita ao cliente"), None).unwrap();
    assert_eq!(core.estado().unwrap().folha, None);
    let lista = core.gravacoes().unwrap();
    assert_eq!(lista[0].titulo.as_deref(), Some("Visita ao cliente"));
    assert_eq!(lista[0].selo, Selo::Aguardando);
    assert_eq!(lista[0].marcadores, 1);
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
    let parada = core.verificar_limites().unwrap().unwrap();
    assert_eq!(parada.status, Status::Pending);
    assert!(core.estado().unwrap().sessao.is_none());
    assert!(core.estado().unwrap().avisos.bateria.is_none());
}
