//! Atualização automática pelo updater do Tauri: o manifesto `latest.json` é servido pelo próprio
//! servidor eclume em `<web_url>/downloads/`, e o pacote é verificado pela chave minisign do
//! `tauri.conf.json` antes de instalar. Nunca instala nem reinicia durante gravação ou sync.

use std::time::Duration;

use anyhow::{Context, Result};
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_updater::UpdaterExt;

use crate::state::{AppState, AppStatus};

/// Espera depois de abrir o app, para não competir com a inicialização.
const FIRST_CHECK: Duration = Duration::from_secs(30);
/// Intervalo entre checagens.
const INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

/// Onde o servidor eclume publica o manifesto do updater.
fn endpoint(web_url: &str) -> Result<Url> {
    let url = format!("{}/downloads/latest.json", web_url.trim_end_matches('/'));
    Url::parse(&url).with_context(|| format!("endereço de atualização inválido: {url}"))
}

fn is_idle(app: &AppHandle) -> bool {
    matches!(app.state::<AppState>().status(), Ok(AppStatus::Idle))
}

/// Checa, baixa e instala uma versão nova, se houver. Devolve se instalou.
async fn check_and_install(app: &AppHandle) -> Result<bool> {
    let url = endpoint(&app.state::<AppState>().web_url()?)?;
    let updater = app
        .updater_builder()
        .endpoints(vec![url.clone()])?
        .build()?;
    let Some(update) = updater
        .check()
        .await
        .with_context(|| format!("falha ao consultar {url}"))?
    else {
        return Ok(false);
    };
    log::info!("versão {} disponível; baixando", update.version);
    let bytes = update.download(|_, _| {}, || {}).await?;
    if !is_idle(app) {
        log::info!(
            "atualização {} adiada: o app não está ocioso",
            update.version
        );
        return Ok(false);
    }
    // No Windows, `install` abre o instalador em modo passivo e encerra o app.
    update.install(bytes)?;
    log::info!("versão {} instalada", update.version);
    Ok(true)
}

/// Checa por atualização 30 s depois de abrir e a cada 6 h. Build de depuração não se atualiza.
pub fn spawn(app: AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            if is_idle(&app) {
                match check_and_install(&app).await {
                    // Linux e macOS: a versão nova vale depois de reabrir.
                    Ok(true) if is_idle(&app) => app.restart(),
                    Ok(_) => {}
                    Err(err) => log::warn!("atualização: {err:#}"),
                }
            }
            tokio::time::sleep(INTERVAL).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::endpoint;

    #[test]
    fn endpoint_fica_em_downloads_do_web_url() {
        assert_eq!(
            endpoint("https://192.168.15.199:8443").unwrap().as_str(),
            "https://192.168.15.199:8443/downloads/latest.json"
        );
        assert_eq!(
            endpoint("https://eclume.local/").unwrap().as_str(),
            "https://eclume.local/downloads/latest.json"
        );
    }
}
