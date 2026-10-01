//! Atualização automática pelo updater do Tauri: o manifesto `latest.json` é servido pelo próprio
//! servidor eclume em `<web_url>/downloads/`, e o pacote é verificado pela chave minisign do
//! `tauri.conf.json` antes de instalar. Nunca instala nem reinicia durante gravação ou sync.
//!
//! O cliente HTTP do updater confia no servidor como o sync ([`AppState::trust`]): a CA fixada
//! pela primeira execução é a única raiz (`tls_certs_only`); uma CA escolhida à mão é somada às do
//! sistema (`tls_certs_merge`); sem CA própria, o cliente padrão. Uma CA fixada ilegível, ou com
//! mais de um certificado, faz a checagem não rodar (fica no log), sem cair nas raízes do sistema.
//! O pacote segue conferido pela minisign; o TLS fixado protege o `latest.json` e o download.

use std::path::Path;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use eclume_sync::transport::TrustMode;
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

/// As raízes do cliente do updater.
enum Roots {
    /// Sem CA própria do servidor: o cliente padrão.
    Default,
    /// CA escolhida à mão: somada às do sistema.
    Merge(Vec<reqwest::Certificate>),
    /// CA fixada pela primeira execução: a única raiz.
    Only(reqwest::Certificate),
}

/// As raízes pela confiança do sync; a CA fixada tem de ter exatamente um certificado.
fn roots(trust: &TrustMode) -> Result<Roots> {
    match trust {
        TrustMode::PlatformPlus(None) => Ok(Roots::Default),
        TrustMode::PlatformPlus(Some(path)) => Ok(Roots::Merge(read_certs(path)?)),
        TrustMode::Pinned(path) => {
            let mut certs = read_certs(path)?;
            if certs.len() != 1 {
                bail!(
                    "a CA fixada em {} tem {} certificados; esperava exatamente um",
                    path.display(),
                    certs.len()
                );
            }
            Ok(Roots::Only(certs.remove(0)))
        }
    }
}

/// Os certificados de um PEM; um arquivo sem nenhum é erro.
fn read_certs(path: &Path) -> Result<Vec<reqwest::Certificate>> {
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
    let trust = state.trust()?;
    match roots(&trust) {
        Ok(Roots::Default) => {}
        Ok(Roots::Merge(certs)) => {
            builder = builder.configure_client(move |client| client.tls_certs_merge(certs.clone()));
        }
        Ok(Roots::Only(root)) => {
            builder = builder.configure_client(move |client| client.tls_certs_only([root.clone()]));
        }
        // A CA fixada ilegível para a checagem: as raízes do sistema não a substituem.
        Err(err) if matches!(trust, TrustMode::Pinned(_)) => {
            return Err(err.context("atualização não consultada"));
        }
        // Uma CA escolhida à mão ilegível não impede a checagem: as do sistema ainda podem bastar.
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
                // Cada checagem numa subtarefa: um pânico nela fica no log e o laço segue.
                let check = {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move { check_and_install(&app).await })
                };
                match check.await {
                    // Linux e macOS: a versão nova vale depois de reabrir.
                    Ok(Ok(true)) if is_idle(&app) => app.restart(),
                    Ok(Ok(_)) => {}
                    Ok(Err(err)) => log::warn!("atualização: {err:#}"),
                    Err(tauri::Error::JoinError(err)) if err.is_panic() => {
                        log::error!("pânico na checagem de atualização; a próxima segue no prazo");
                    }
                    Err(err) => log::warn!("checagem de atualização interrompida: {err}"),
                }
            }
            tokio::time::sleep(INTERVAL).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use eclume_sync::transport::TrustMode;

    use super::{endpoint, roots, Roots};

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
    fn sem_ca_propria_usa_o_cliente_padrao() {
        assert!(matches!(
            roots(&TrustMode::PlatformPlus(None)),
            Ok(Roots::Default)
        ));
    }

    #[test]
    fn ca_extra_vira_raiz_do_cliente_do_updater() {
        let dir = std::env::temp_dir().join(format!("eclume-updater-ca-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("eclume-root.crt");
        let chosen = || TrustMode::PlatformPlus(Some(path.clone()));
        let pinned = || TrustMode::Pinned(path.clone());

        std::fs::write(&path, CA).unwrap();
        assert!(matches!(roots(&pinned()), Ok(Roots::Only(_))));

        // À mão, os dois somam-se às do sistema; fixada, dois certificados são recusados.
        std::fs::write(&path, format!("{CA}{CA}")).unwrap();
        let Ok(Roots::Merge(certs)) = roots(&chosen()) else {
            panic!("a CA escolhida à mão soma-se às do sistema");
        };
        assert_eq!(certs.len(), 2);
        assert!(roots(&pinned()).is_err());

        std::fs::write(&path, "sem certificado").unwrap();
        assert!(roots(&chosen()).is_err());
        assert!(roots(&pinned()).is_err());
        let missing = TrustMode::Pinned(dir.join("nao-existe.pem"));
        assert!(roots(&missing).is_err());
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
