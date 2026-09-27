//! Núcleo do app móvel do eclume, independente do Tauri: o mesmo objeto atende a UI (pelos
//! comandos Tauri) e o sistema (pela ponte JNI do plugin Android), porque a Activity pode morrer e
//! voltar enquanto o serviço grava. Arquitetura em docs/standards/code/mobile-app.md.

pub mod conexao;
pub mod config;

/// O prefixo do `client_version` e do user agent do app Android.
pub const CLIENT_PREFIX: &str = "eclume-android";

/// `eclume-android/<versão>`: o `capture.client_version` do upload e o user agent.
pub fn client_version(version: &str) -> String {
    format!("{CLIENT_PREFIX}/{version}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versao_do_cliente_segue_o_contrato() {
        assert_eq!(client_version("0.1.0"), "eclume-android/0.1.0");
    }
}
