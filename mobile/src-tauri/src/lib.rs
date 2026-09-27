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

/// Os diretórios do núcleo a partir da pasta de dados do app: `eclume/` para config, CA, fila e
/// gravações, e `no_backup/` (o `noBackupFilesDir` do Android) para o token.
pub(crate) fn dirs_de(base: &std::path::Path) -> Dirs {
    Dirs {
        dados: base.join("eclume"),
        sem_backup: base.join("no_backup"),
    }
}

/// O serviço em primeiro plano do Android (notificação e microfone com a tela bloqueada). Fora do
/// Android, não há serviço.
pub(crate) mod servico {
    use tauri::{AppHandle, Runtime};

    pub fn iniciar<R: Runtime>(_app: &AppHandle<R>) {}

    pub fn atualizar<R: Runtime>(_app: &AppHandle<R>) {}

    pub fn parar<R: Runtime>(_app: &AppHandle<R>) {}
}

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
    tauri::Builder::default()
        .setup(|app| {
            abrir_nucleo(app.handle())?;
            eventos::iniciar_laco(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
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
            comandos::configuracoes,
            comandos::salvar_configuracoes,
            comandos::sair,
            comandos::visibilidade,
        ])
        .run(tauri::generate_context!())
        .expect("falha ao iniciar o app móvel do eclume");
}

#[cfg(test)]
mod tests {
    use super::*;

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
