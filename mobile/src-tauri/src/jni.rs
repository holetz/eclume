//! A ponte Kotlin → Rust do plugin Android (`EclumeCore`): o caminho que não depende do WebView
//! estar vivo. A notificação (Pausar, Marcador, Parar) chega por `acao`, e o `SyncWorker` do
//! WorkManager, sem Activity, abre o núcleo por `syncPendentes`. O serviço avisa o silêncio
//! imposto pelo sistema por `acao("silenciado" | "audivel")`. Cada função devolve JSON, e cada
//! resposta passa por `crate::responder`: erro e pânico viram `{"erro": …}`, sem abortar o processo.

use eclume_mobile_core::{self as core, trancar};
use jni::objects::{JClass, JString};
use jni::sys::jstring;
use jni::JNIEnv;
use serde_json::json;

fn texto(env: &mut JNIEnv<'_>, valor: &JString<'_>) -> String {
    env.get_string(valor).map(Into::into).unwrap_or_default()
}

fn devolver(env: &mut JNIEnv<'_>, valor: &serde_json::Value) -> jstring {
    env.new_string(valor.to_string())
        .map(|s| s.into_raw())
        .unwrap_or(std::ptr::null_mut())
}

fn nucleo() -> anyhow::Result<&'static std::sync::Mutex<core::Core>> {
    core::global().ok_or_else(|| anyhow::anyhow!("o núcleo não foi aberto"))
}

fn estado_json() -> anyhow::Result<serde_json::Value> {
    Ok(serde_json::to_value(trancar(nucleo()?)?.estado()?)?)
}

fn executar(nome: &str) -> anyhow::Result<serde_json::Value> {
    {
        let mut c = trancar(nucleo()?)?;
        match nome {
            "pausar" => c.pausar()?,
            "continuar" => c.continuar()?,
            "marcar" => {
                c.marcar(None)?;
            }
            "parar" => {
                c.parar()?;
            }
            "silenciado" => c.silenciar(true)?,
            "audivel" => c.silenciar(false)?,
            outro => anyhow::bail!("ação desconhecida: {outro}"),
        }
    }
    estado_json()
}

/// `EclumeCore.acao(nome)`: uma ação da notificação; devolve o estado depois dela.
#[no_mangle]
pub extern "system" fn Java_io_github_holetz_eclume_movel_gravador_EclumeCore_acao<'l>(
    mut env: JNIEnv<'l>,
    _classe: JClass<'l>,
    nome: JString<'l>,
) -> jstring {
    let nome = texto(&mut env, &nome);
    let resposta = crate::responder(|| executar(&nome));
    devolver(&mut env, &resposta)
}

/// `EclumeCore.estado()`: o estado atual, para a notificação se redesenhar.
#[no_mangle]
pub extern "system" fn Java_io_github_holetz_eclume_movel_gravador_EclumeCore_estado<'l>(
    mut env: JNIEnv<'l>,
    _classe: JClass<'l>,
) -> jstring {
    let resposta = crate::responder(estado_json);
    devolver(&mut env, &resposta)
}

/// `EclumeCore.syncPendentes(base)`: o sync do WorkManager. Abre o núcleo com a pasta de dados do
/// app (a mesma que o Tauri usa), faz a sonda e sobe o que estiver pendente, só na rede do eclume.
#[no_mangle]
pub extern "system" fn Java_io_github_holetz_eclume_movel_gravador_EclumeCore_syncPendentes<
    'l,
>(
    mut env: JNIEnv<'l>,
    _classe: JClass<'l>,
    base: JString<'l>,
) -> jstring {
    let base = texto(&mut env, &base);
    let resposta = crate::responder(|| {
        core::iniciar(crate::dirs_de(std::path::Path::new(&base)), crate::VERSAO)
            .and_then(core::ciclo_do_worker)
            .map(|relatorio| match relatorio {
                Some(r) => {
                    json!({ "na_rede": true, "sincronizadas": r.synced, "falhas": r.failed })
                }
                None => json!({ "na_rede": false }),
            })
    });
    devolver(&mut env, &resposta)
}
