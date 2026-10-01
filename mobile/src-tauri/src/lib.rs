//! O app móvel do eclume: a casca Tauri sobre o `eclume-mobile-core`. Os comandos
//! ([`comandos`]) e o evento `estado` ([`eventos`]) ligam a UI ao núcleo do processo; no Android,
//! a ponte JNI (`jni`) liga o plugin nativo (serviço de gravação, notificação, WorkManager) ao
//! mesmo núcleo, sem depender do WebView.

mod comandos;
mod eventos;
#[cfg(target_os = "android")]
mod jni;

use eclume_mobile_core::config::Dirs;
use eclume_recorder::AudioSource;
use tauri::{Manager, Runtime};

/// A versão do app (`tauri.conf.json` e `Cargo.toml` andam juntos).
pub const VERSAO: &str = env!("CARGO_PKG_VERSION");

/// O microfone padrão, a 16 kHz mono pelo mixer do gravador.
pub(crate) fn microfone() -> anyhow::Result<Box<dyn AudioSource>> {
    Ok(Box::new(eclume_audio_capture::MicSource::open()?))
}

/// A resposta de uma chamada da ponte JNI, isolada de pânico: um erro vira `{"erro": …}` e um
/// pânico vira `{"erro": "pânico: …"}`, sem abortar o processo (o workspace não usa
/// `panic = "abort"`). Fica fora do `cfg(android)` para ser testada no host.
// Usada só pela ponte do Android; os testes a exercitam no host.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) fn responder(
    f: impl FnOnce() -> anyhow::Result<serde_json::Value>,
) -> serde_json::Value {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(Ok(valor)) => valor,
        Ok(Err(err)) => serde_json::json!({ "erro": format!("{err:#}") }),
        Err(panico) => {
            let mensagem = panico
                .downcast_ref::<&str>()
                .map(|m| (*m).to_string())
                .or_else(|| panico.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "sem mensagem".into());
            log::error!("pânico na ponte JNI: {mensagem}");
            serde_json::json!({ "erro": format!("pânico: {mensagem}") })
        }
    }
}

/// Os diretórios do núcleo a partir da pasta de dados do app: `eclume/` para config, CA, fila e
/// gravações, e `no_backup/` (o `noBackupFilesDir` do Android) para o token.
pub(crate) fn dirs_de(base: &std::path::Path) -> Dirs {
    Dirs {
        dados: base.join("eclume"),
        sem_backup: base.join("no_backup"),
    }
}

/// O serviço em primeiro plano do Android (notificação e microfone com a tela bloqueada), pelo
/// plugin `gravador`. O lado Kotlin responde na thread de quem chama: `iniciar` bloqueia (o
/// `gravar` o chama numa thread de bloqueio) e as outras chamadas correm numa thread própria.
pub(crate) mod servico {
    use tauri::{AppHandle, Runtime};
    use tauri_plugin_eclume_gravador::GravadorExt;

    fn em_segundo_plano<R: Runtime>(
        app: &AppHandle<R>,
        o_que: &'static str,
        f: fn(
            &tauri_plugin_eclume_gravador::Gravador<R>,
        ) -> tauri_plugin_eclume_gravador::Resultado<()>,
    ) {
        let app = app.clone();
        std::thread::spawn(move || {
            if let Err(err) = f(app.gravador()) {
                log::warn!("serviço de gravação ({o_que}): {err}");
            }
        });
    }

    /// Sobe o serviço e espera o primeiro plano (bloqueia; nunca na thread principal).
    pub fn iniciar<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
        app.gravador()
            .iniciar_servico()
            .map_err(|err| err.to_string())
    }

    pub fn atualizar<R: Runtime>(app: &AppHandle<R>) {
        em_segundo_plano(app, "atualizar", |g| g.atualizar_servico());
    }

    pub fn parar<R: Runtime>(app: &AppHandle<R>) {
        em_segundo_plano(app, "parar", |g| g.parar_servico(None));
    }

    /// Agenda o sync do WorkManager para subir com o app fechado (fora da thread do comando).
    pub fn agendar_sync<R: Runtime>(app: &AppHandle<R>, atraso: std::time::Duration) {
        let app = app.clone();
        let atraso_ms = u64::try_from(atraso.as_millis()).unwrap_or(u64::MAX);
        std::thread::spawn(move || {
            if let Err(err) = app.gravador().agendar_sync(atraso_ms) {
                log::warn!("agendar o sync: {err}");
            }
        });
    }

    /// A gravação parou sem pedido: o serviço avisa "A gravação parou" com o motivo e sai.
    pub fn parar_com_aviso<R: Runtime>(app: &AppHandle<R>, motivo: &'static str, duracao_ms: i64) {
        let app = app.clone();
        std::thread::spawn(move || {
            if let Err(err) = app.gravador().parar_servico(Some((motivo, duracao_ms))) {
                log::warn!("serviço de gravação (parar com aviso): {err}");
            }
        });
    }
}

/// Um servidor achado na rede, já interpretado pelo parser do TXT do crate de sync.
#[derive(Clone, Debug, serde::Serialize)]
pub struct Achado {
    pub nome: String,
    pub url: String,
    pub ca_sha256: Option<String>,
}

/// Procura o servidor na rede por `segundos`: no Android, pelo `NsdManager` do plugin; no
/// desenvolvimento, pelo mDNS do crate de sync.
#[tauri::command]
async fn descobrir<R: Runtime>(
    app: tauri::AppHandle<R>,
    segundos: u32,
) -> Result<Vec<Achado>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(mobile)]
        let achados = {
            use tauri_plugin_eclume_gravador::GravadorExt;
            app.gravador()
                .descobrir(segundos)
                .map_err(|err| err.to_string())?
                .into_iter()
                .filter_map(|anuncio| {
                    let txt: Vec<(String, String)> = anuncio.txt.into_iter().collect();
                    eclume_sync::discovery::parse(&anuncio.nome, &txt)
                })
                .collect::<Vec<_>>()
        };
        #[cfg(not(mobile))]
        let achados = {
            let _ = &app;
            eclume_sync::discovery::discover(std::time::Duration::from_secs(u64::from(segundos)))
                .map_err(|err| format!("{err:#}"))?
        };
        Ok(achados
            .into_iter()
            .map(|f| Achado {
                nome: f.name,
                url: f.url,
                ca_sha256: f.ca_sha256,
            })
            .collect())
    })
    .await
    .map_err(|err| err.to_string())?
}

/// Lê o aparelho a cada poucos segundos (bateria, espaço, Wi-Fi não medido) e leva ao núcleo; uma
/// mudança de rede dispara o ciclo (a sonda roda de novo).
fn acompanhar_aparelho<R: Runtime>(app: tauri::AppHandle<R>) {
    use tauri_plugin_eclume_gravador::GravadorExt;

    std::thread::spawn(move || {
        let mut modelo_definido = false;
        loop {
            match app.gravador().estado_do_dispositivo() {
                Ok(estado) => {
                    let mudou = eclume_mobile_core::global()
                        .and_then(|nucleo| eclume_mobile_core::trancar(nucleo).ok())
                        .map(|mut core| {
                            if !modelo_definido {
                                modelo_definido = core.definir_aparelho(&estado.modelo).is_ok();
                            }
                            core.atualizar_aparelho(
                                estado.bateria,
                                estado.carregando,
                                estado.espaco_livre,
                            );
                            core.mudou_rede(estado.wifi_nao_medido)
                        })
                        .unwrap_or(false);
                    if mudou {
                        eventos::ciclo_em_segundo_plano(&app, false);
                    }
                }
                Err(err) => log::warn!("estado do aparelho: {err}"),
            }
            std::thread::sleep(INTERVALO_DO_APARELHO);
        }
    });
}

/// De quanto em quanto tempo o aparelho é lido.
const INTERVALO_DO_APARELHO: std::time::Duration = std::time::Duration::from_secs(5);

fn iniciar_log() {
    #[cfg(target_os = "android")]
    android_logger::init_once(
        android_logger::Config::default()
            .with_max_level(log::LevelFilter::Info)
            .with_tag("eclume"),
    );
}

fn abrir_nucleo<R: Runtime>(app: &tauri::AppHandle<R>) -> anyhow::Result<()> {
    let base = app.path().app_data_dir()?;
    log::info!("dados do app em {}", base.display());
    eclume_mobile_core::iniciar(dirs_de(&base), VERSAO)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    iniciar_log();
    let builder = tauri::Builder::default().plugin(tauri_plugin_eclume_gravador::init());
    // O leitor de QR (câmera) só existe no celular.
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());
    builder
        .setup(|app| {
            abrir_nucleo(app.handle())?;
            acompanhar_aparelho(app.handle().clone());
            eventos::iniciar_laco(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            descobrir,
            comandos::estado,
            comandos::conectar_descoberto,
            comandos::conectar_endereco,
            comandos::confiar_ca,
            comandos::cancelar_ca,
            comandos::entrar,
            comandos::parear,
            comandos::gravar,
            comandos::pausar,
            comandos::continuar,
            comandos::marcar,
            comandos::anotar_marcador,
            comandos::parar,
            comandos::salvar,
            comandos::sincronizar_agora,
            comandos::gravacoes,
            comandos::gravacao,
            comandos::excluir_local,
            comandos::excluir_sincronizadas,
            comandos::tipos_de_agenda,
            comandos::idiomas,
            comandos::configuracoes,
            comandos::salvar_configuracoes,
            comandos::sair,
            comandos::visibilidade,
            comandos::verificar_atualizacao,
            comandos::atualizar,
            comandos::abrir_na_web,
        ])
        .run(tauri::generate_context!())
        .expect("falha ao iniciar o app móvel do eclume");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn responder_transforma_erro_e_panico_em_json() {
        assert_eq!(
            responder(|| Ok(serde_json::json!({ "ok": true }))),
            serde_json::json!({ "ok": true })
        );
        assert_eq!(
            responder(|| Err(anyhow::anyhow!("sem sessão"))),
            serde_json::json!({ "erro": "sem sessão" })
        );
        assert_eq!(
            responder(|| panic!("núcleo quebrado")),
            serde_json::json!({ "erro": "pânico: núcleo quebrado" })
        );
        let dinamica = String::from("índice 3");
        assert_eq!(
            responder(move || panic!("{dinamica}")),
            serde_json::json!({ "erro": "pânico: índice 3" })
        );
    }

    #[test]
    fn token_fica_fora_da_pasta_de_dados() {
        let dirs = dirs_de(std::path::Path::new(
            "/data/user/0/io.github.holetz.eclume.movel",
        ));
        assert!(dirs.dados.ends_with("eclume"));
        assert!(dirs.token().starts_with(&dirs.sem_backup));
        assert!(!dirs.token().starts_with(&dirs.dados));
    }
}
