//! O evento `estado` e o laço do app: a UI é função do `EstadoApp`, que sai a cada 250 ms
//! gravando e a cada mudança no resto. O mesmo laço fecha a gravação que bateu num limite e dispara
//! o ciclo de rede (sonda, tipos de agenda e sync) quando ele cabe.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use eclume_mobile_core::{self as core, trancar, EstadoApp};
use tauri::{AppHandle, Emitter, Runtime};

/// O nome do evento que leva o `EstadoApp` à UI.
pub const EVENTO_ESTADO: &str = "estado";
/// O intervalo do laço.
const TICK: Duration = Duration::from_millis(250);
/// De quanto em quanto tempo o laço tenta o ciclo de rede (ele mesmo decide se sonda ou sobe).
const CICLO: Duration = Duration::from_secs(5);

static ULTIMO: Mutex<Option<String>> = Mutex::new(None);
static EM_CICLO: AtomicBool = AtomicBool::new(false);

fn estado_atual() -> Option<EstadoApp> {
    let nucleo = core::global()?;
    let estado = trancar(nucleo).ok()?.estado();
    match estado {
        Ok(estado) => Some(estado),
        Err(err) => {
            log::warn!("{err:#}");
            None
        }
    }
}

/// Emite o estado se mudou desde o último (ou sempre, com `forcar`).
fn emitir<R: Runtime>(app: &AppHandle<R>, forcar: bool) {
    let Some(estado) = estado_atual() else {
        return;
    };
    let Ok(json) = serde_json::to_string(&estado) else {
        return;
    };
    let mut ultimo = ULTIMO
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if forcar || ultimo.as_deref() != Some(json.as_str()) {
        *ultimo = Some(json);
        drop(ultimo);
        if let Err(err) = app.emit(EVENTO_ESTADO, &estado) {
            log::warn!("falha ao emitir o estado: {err}");
        }
    }
}

/// Avisa a UI do estado novo depois de um comando.
pub fn avisar<R: Runtime>(app: &AppHandle<R>) {
    emitir(app, false);
}

/// Roda um ciclo de rede numa thread, se não há outro em curso (`agora`: "Sincronizar agora").
pub fn ciclo_em_segundo_plano<R: Runtime>(app: &AppHandle<R>, agora: bool) {
    if EM_CICLO.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        if let Some(nucleo) = core::global() {
            if let Err(err) = core::ciclo(nucleo, agora) {
                log::warn!("ciclo de rede: {err:#}");
            }
        }
        EM_CICLO.store(false, Ordering::Release);
        emitir(&app, false);
    });
}

/// O laço do app, numa thread própria.
pub fn iniciar_laco<R: Runtime>(app: AppHandle<R>) {
    std::thread::spawn(move || {
        let mut ultimo_ciclo = Instant::now();
        ciclo_em_segundo_plano(&app, false);
        loop {
            std::thread::sleep(TICK);
            let Some(nucleo) = core::global() else {
                continue;
            };
            let fechada = trancar(nucleo).and_then(|mut c| {
                if let Err(err) = c.vigiar() {
                    log::warn!("vigiar o microfone: {err:#}");
                }
                c.verificar_limites()
            });
            match fechada {
                Ok(Some(gravacao)) => {
                    log::warn!("gravação {} fechada pelo limite", gravacao.id);
                    crate::servico::parar(&app);
                    ciclo_em_segundo_plano(&app, false);
                }
                Ok(None) => {}
                Err(err) => log::warn!("{err:#}"),
            }
            if ultimo_ciclo.elapsed() >= CICLO {
                ultimo_ciclo = Instant::now();
                ciclo_em_segundo_plano(&app, false);
            }
            emitir(&app, false);
        }
    });
}
