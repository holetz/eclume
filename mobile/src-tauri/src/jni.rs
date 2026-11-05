//! The Kotlin → Rust bridge of the Android plugin (`EclumeCore`): the path that does not depend on
//! the WebView being alive. The notification (Pausar, Marcador, Parar) arrives through `action`, and
//! WorkManager's `SyncWorker`, with no Activity, opens the core through `syncPending`. The
//! service reports the silence the system imposes through `action("silenciado" | "audivel")`. Each
//! function returns JSON, and every reply goes through `crate::reply`: errors and panics become
//! `{"erro": …}`, without aborting the process.
//!
//! The action names and the JSON keys are the bridge's wire format with the Kotlin side and keep
//! their original (pt-BR) names.

use eclume_mobile_core::{self as core, lock};
use jni::objects::{JClass, JString};
use jni::sys::{jboolean, jstring};
use jni::JNIEnv;
use serde_json::json;

fn text(env: &mut JNIEnv<'_>, value: &JString<'_>) -> String {
    env.get_string(value).map(Into::into).unwrap_or_default()
}

fn give_back(env: &mut JNIEnv<'_>, value: &serde_json::Value) -> jstring {
    env.new_string(value.to_string())
        .map(|s| s.into_raw())
        .unwrap_or(std::ptr::null_mut())
}

fn the_core() -> anyhow::Result<&'static std::sync::Mutex<core::Core>> {
    core::global().ok_or_else(|| anyhow::anyhow!("o núcleo não foi aberto"))
}

fn state_json() -> anyhow::Result<serde_json::Value> {
    Ok(serde_json::to_value(lock(the_core()?)?.state()?)?)
}

fn run_action(name: &str) -> anyhow::Result<serde_json::Value> {
    {
        let mut c = lock(the_core()?)?;
        match name {
            "pausar" => c.pause()?,
            "continuar" => c.resume()?,
            "marcar" => {
                c.mark(None)?;
            }
            "parar" => {
                c.stop()?;
            }
            "silenciado" => c.set_muted(true)?,
            "audivel" => c.set_muted(false)?,
            other => anyhow::bail!("ação desconhecida: {other}"),
        }
    }
    state_json()
}

/// `EclumeCore.action(name)`: a notification action; returns the state after it.
#[no_mangle]
pub extern "system" fn Java_io_github_holetz_eclume_movel_gravador_EclumeCore_action<'l>(
    mut env: JNIEnv<'l>,
    _class: JClass<'l>,
    name: JString<'l>,
) -> jstring {
    let name = text(&mut env, &name);
    let reply = crate::reply(|| run_action(&name));
    give_back(&mut env, &reply)
}

/// `EclumeCore.state()`: the current state, for the notification to redraw itself.
#[no_mangle]
pub extern "system" fn Java_io_github_holetz_eclume_movel_gravador_EclumeCore_state<'l>(
    mut env: JNIEnv<'l>,
    _class: JClass<'l>,
) -> jstring {
    let reply = crate::reply(state_json);
    give_back(&mut env, &reply)
}

/// `EclumeCore.syncPending(base)`: the WorkManager sync. Opens the core with the app's data
/// folder (the same one Tauri uses), runs the probe and uploads what is pending, only on eclume's
/// network.
#[no_mangle]
pub extern "system" fn Java_io_github_holetz_eclume_movel_gravador_EclumeCore_syncPending<'l>(
    mut env: JNIEnv<'l>,
    _class: JClass<'l>,
    base: JString<'l>,
) -> jstring {
    let base = text(&mut env, &base);
    let reply = crate::reply(|| {
        core::init(
            crate::dirs_from(std::path::Path::new(&base)),
            crate::VERSION,
        )
        .and_then(core::worker_cycle)
        .map(|report| match report {
            Some(r) => json!({
                "na_rede": true,
                "sincronizadas": r.report.synced,
                "falhas": r.report.failed,
                "interrompido": r.interrupted,
            }),
            None => json!({ "na_rede": false }),
        })
    });
    give_back(&mut env, &reply)
}

/// `EclumeCore.probePending(base)`: before the worker's sync, whether the phone is on eclume's
/// network and how many recordings (and bytes) wait, to decide on the foreground.
#[no_mangle]
pub extern "system" fn Java_io_github_holetz_eclume_movel_gravador_EclumeCore_probePending<
    'l,
>(
    mut env: JNIEnv<'l>,
    _class: JClass<'l>,
    base: JString<'l>,
) -> jstring {
    let base = text(&mut env, &base);
    let reply = crate::reply(|| {
        let core = core::init(
            crate::dirs_from(std::path::Path::new(&base)),
            crate::VERSION,
        )?;
        Ok(serde_json::to_value(core::worker_probe(core)?)?)
    });
    give_back(&mut env, &reply)
}

/// `EclumeCore.network(unmeteredWifi)`: the system's network callback, right away; without the
/// unmetered Wi-Fi, the running sync stops at the next request. With no core open, there is
/// nothing to report.
#[no_mangle]
pub extern "system" fn Java_io_github_holetz_eclume_movel_gravador_EclumeCore_network<'l>(
    mut env: JNIEnv<'l>,
    _class: JClass<'l>,
    unmetered_wifi: jboolean,
) -> jstring {
    let reply = crate::reply(|| {
        if let Some(core) = core::global() {
            lock(core)?.network_changed(unmetered_wifi != 0);
        }
        Ok(json!({}))
    });
    give_back(&mut env, &reply)
}

/// `EclumeCore.interruptSync()`: the worker's `onStopped`; the upload stops at the next request
/// and the recording goes back to the queue without spending an attempt.
#[no_mangle]
pub extern "system" fn Java_io_github_holetz_eclume_movel_gravador_EclumeCore_interruptSync<
    'l,
>(
    mut env: JNIEnv<'l>,
    _class: JClass<'l>,
) -> jstring {
    let reply = crate::reply(|| {
        if let Some(core) = core::global() {
            lock(core)?.interrupt_sync();
        }
        Ok(json!({}))
    });
    give_back(&mut env, &reply)
}
