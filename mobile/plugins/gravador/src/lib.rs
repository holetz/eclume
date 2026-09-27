//! O plugin nativo do app móvel do eclume (`eclume-gravador`). No Android, a classe Kotlin
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

/// O aparelho: bateria, espaço livre, rede, modelo e os recortes de borda a borda (em dp).
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EstadoDoDispositivo {
    pub bateria: u8,
    pub carregando: bool,
    pub espaco_livre: u64,
    pub wifi_nao_medido: bool,
    pub modelo: String,
    pub inset_topo: f64,
    pub inset_base: f64,
}

/// Um anúncio `_eclume._tcp` achado pelo `NsdManager`, com o TXT cru.
#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize)]
pub struct Anuncio {
    pub nome: String,
    pub txt: std::collections::BTreeMap<String, String>,
}

#[cfg(mobile)]
#[derive(serde::Deserialize)]
struct Anuncios {
    servicos: Vec<Anuncio>,
}

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

    /// O estado do aparelho. Fora do celular (desenvolvimento), um aparelho na tomada e no Wi-Fi.
    pub fn estado_do_dispositivo(&self) -> Resultado<EstadoDoDispositivo> {
        #[cfg(mobile)]
        return self.chamar("estadoDoDispositivo");
        #[cfg(not(mobile))]
        Ok(EstadoDoDispositivo {
            bateria: 100,
            carregando: true,
            espaco_livre: 64 * 1_000_000_000,
            wifi_nao_medido: true,
            modelo: "computador".into(),
            inset_topo: 0.0,
            inset_base: 0.0,
        })
    }

    /// Procura `_eclume._tcp` por `segundos` pelo `NsdManager` (bloqueia). Fora do celular, a
    /// descoberta é a do crate de sync, e isto não acha nada.
    pub fn descobrir(&self, segundos: u32) -> Resultado<Vec<Anuncio>> {
        #[cfg(mobile)]
        return self
            .handle
            .run_mobile_plugin::<Anuncios>("descobrir", serde_json::json!({ "segundos": segundos }))
            .map(|a| a.servicos);
        #[cfg(not(mobile))]
        {
            let _ = segundos;
            Ok(Vec::new())
        }
    }

    /// Abre o instalador do sistema para o APK em `caminho` (no cache do app). Devolve `false`
    /// quando o sistema foi antes pedir a permissão de instalar de fontes desconhecidas.
    pub fn abrir_instalador(&self, caminho: &str) -> Resultado<bool> {
        #[cfg(mobile)]
        {
            #[derive(serde::Deserialize)]
            struct Aberto {
                aberto: bool,
            }
            return self
                .handle
                .run_mobile_plugin::<Aberto>(
                    "abrirInstalador",
                    serde_json::json!({ "caminho": caminho }),
                )
                .map(|r| r.aberto);
        }
        #[cfg(not(mobile))]
        {
            let _ = caminho;
            Ok(false)
        }
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
    Builder::new("eclume-gravador")
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
