//! O plugin nativo do app móvel do eclume (`gravador`). No Android, a classe Kotlin
//! `GravadorPlugin` cuida do que só o sistema faz: o serviço em primeiro plano do tipo microfone,
//! com a notificação contínua que grava com a tela bloqueada. Fora do Android (o build de
//! desenvolvimento e os testes no Linux), os métodos não fazem nada.
//!
//! O caminho de volta, do Kotlin para o Rust, não passa por aqui: é a ponte JNI `EclumeCore` do
//! app, que não depende do WebView estar vivo.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime};

/// O pacote Kotlin do plugin.
pub const PACOTE_ANDROID: &str = "io.github.holetz.eclume.movel.gravador";

/// O erro de uma chamada ao lado nativo; fora do celular, nenhuma chamada falha.
#[cfg(mobile)]
pub type Erro = tauri::plugin::mobile::PluginInvokeError;
#[cfg(not(mobile))]
pub type Erro = std::convert::Infallible;

pub type Resultado<T> = Result<T, Erro>;

/// O acesso ao plugin, guardado no estado do app.
pub struct Gravador<R: Runtime> {
    #[cfg(mobile)]
    handle: tauri::plugin::PluginHandle<R>,
    #[cfg(not(mobile))]
    _app: tauri::AppHandle<R>,
}

impl<R: Runtime> Gravador<R> {
    #[cfg(mobile)]
    fn chamar<T: serde::de::DeserializeOwned>(&self, comando: &str) -> Resultado<T> {
        self.handle.run_mobile_plugin(comando, ())
    }

    /// Sobe o serviço em primeiro plano (o toque em Gravar, com a Activity visível).
    pub fn iniciar_servico(&self) -> Resultado<()> {
        #[cfg(mobile)]
        self.chamar::<serde_json::Value>("iniciarServico")?;
        Ok(())
    }

    /// Redesenha a notificação pelo estado atual do núcleo.
    pub fn atualizar_servico(&self) -> Resultado<()> {
        #[cfg(mobile)]
        self.chamar::<serde_json::Value>("atualizarServico")?;
        Ok(())
    }

    /// Tira a notificação e para o serviço.
    pub fn parar_servico(&self) -> Resultado<()> {
        #[cfg(mobile)]
        self.chamar::<serde_json::Value>("pararServico")?;
        Ok(())
    }
}

/// O acesso ao plugin a partir de um `App`, `AppHandle` ou janela.
pub trait GravadorExt<R: Runtime> {
    fn gravador(&self) -> &Gravador<R>;
}

impl<R: Runtime, T: Manager<R>> GravadorExt<R> for T {
    fn gravador(&self) -> &Gravador<R> {
        self.state::<Gravador<R>>().inner()
    }
}

/// Registra o plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("gravador")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let gravador = Gravador {
                handle: api.register_android_plugin(PACOTE_ANDROID, "GravadorPlugin")?,
            };
            #[cfg(target_os = "ios")]
            let gravador: Gravador<R> = {
                let _ = api;
                return Err("o plugin gravador ainda não tem lado iOS".into());
            };
            #[cfg(not(mobile))]
            let gravador = {
                let _ = api;
                Gravador { _app: app.clone() }
            };
            app.manage(gravador);
            Ok(())
        })
        .build()
}
