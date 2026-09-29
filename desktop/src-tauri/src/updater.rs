//! Atualização automática pelo updater do Tauri: o manifesto `latest.json` é servido pelo próprio
//! servidor eclume em `<web_url>/downloads/`, e o pacote é verificado pela chave minisign do
//! `tauri.conf.json` antes de instalar. Nunca instala nem reinicia durante gravação ou sync.
//!
//! A CA extra configurada para o sync (`ca_path`, a raiz do Caddy do eclume quando o cliente não a
//! instalou no SO) vale também aqui: é somada às CAs do sistema no cliente HTTP do updater.

use std::path::Path;
use std::time::Duration;

use anyhow::{bail, Context, Result};
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

/// Certificados da CA extra do sync; vazio sem `ca_path`.
fn extra_roots(ca_path: Option<&Path>) -> Result<Vec<reqwest::Certificate>> {
    let Some(path) = ca_path else {
        return Ok(Vec::new());
    };
    let pem = std::fs::read(path)
        .with_context(|| format!("falha ao ler a CA extra em {}", path.display()))?;
    let certs = reqwest::Certificate::from_pem_bundle(&pem)
        .with_context(|| format!("PEM inválido em {}", path.display()))?;
    if certs.is_empty() {
        bail!("nenhum certificado no PEM {}", path.display());
    }
    Ok(certs)
}

fn is_idle(app: &AppHandle) -> bool {
    matches!(app.state::<AppState>().status(), Ok(AppStatus::Idle))
}

/// Checa, baixa e instala uma versão nova, se houver. Devolve se instalou.
async fn check_and_install(app: &AppHandle) -> Result<bool> {
    let state = app.state::<AppState>();
    let url = endpoint(&state.web_url()?)?;
    let mut builder = app.updater_builder().endpoints(vec![url.clone()])?;
    match extra_roots(state.ca_path()?.as_deref()) {
        Ok(roots) if !roots.is_empty() => {
            builder = builder.configure_client(move |client| client.tls_certs_merge(roots.clone()));
        }
        Ok(_) => {}
        // Uma CA ilegível não impede a checagem: as CAs do sistema ainda podem bastar.
        Err(err) => log::warn!("atualização sem a CA extra: {err:#}"),
    }
    let updater = builder.build()?;
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
    // As notas vão para o aviso "Atualizado para X" da próxima abertura.
    if let Err(err) = state.record_pending_update(&update.version, update.body.clone()) {
        log::warn!(
            "falha ao guardar as notas da versão {}: {err:#}",
            update.version
        );
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
    use super::{endpoint, extra_roots};

    const CA: &str = "-----BEGIN CERTIFICATE-----
MIIBhTCCASugAwIBAgIUZq/L15v8O8Pr4T/lykPSvtBCcvUwCgYIKoZIzj0EAwIw
FzEVMBMGA1UEAwwMZWNsdW1lIHRlc3RlMCAXDTI2MDkyNTEwNDQxNloYDzIxMjYw
OTAxMTA0NDE2WjAXMRUwEwYDVQQDDAxlY2x1bWUgdGVzdGUwWTATBgcqhkjOPQIB
BggqhkjOPQMBBwNCAAT1ysTldR1/rP5BmL3/VwD/J65t9C2TgTHLU+KacwJUxp0j
HhwK1AvDPl/7YVivmDUEI+D4dqmuaubJ9gfOZ2rMo1MwUTAdBgNVHQ4EFgQUn3Sk
yWf7HZqHcVA58oNJGvraVyMwHwYDVR0jBBgwFoAUn3SkyWf7HZqHcVA58oNJGvra
VyMwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiAqogMqxEP541HD
urwVrn2LuMQiFhpsFqzijXlyfFPQmgIhALpw58Bg8XjfqCOaXRJ53v7gVlG7SPkr
8cZ14kyIWDAT
-----END CERTIFICATE-----\n";

    #[test]
    fn sem_ca_extra_nao_ha_raiz_a_somar() {
        assert!(extra_roots(None).unwrap().is_empty());
    }

    #[test]
    fn ca_extra_vira_raiz_do_cliente_do_updater() {
        let dir = std::env::temp_dir().join(format!("eclume-updater-ca-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("eclume-root.crt");
        std::fs::write(&path, format!("{CA}{CA}")).unwrap();
        assert_eq!(extra_roots(Some(&path)).unwrap().len(), 2);
        std::fs::write(&path, "sem certificado").unwrap();
        assert!(extra_roots(Some(&path)).is_err());
        assert!(extra_roots(Some(&dir.join("nao-existe.pem"))).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

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
