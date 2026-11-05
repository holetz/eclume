package io.github.holetz.eclume.movel.gravador

/**
 * The Kotlin → Rust bridge (`src-tauri/src/jni.rs`): the path that does not depend on the WebView
 * being alive. The notification reaches the core through [action], and WorkManager uploads the
 * recordings through [syncPending]. Each function returns the core's JSON; an error comes as
 * `{"erro": "..."}`.
 */
object EclumeCore {
    init {
        System.loadLibrary("eclume_mobile_lib")
    }

    /** `pausar`, `continuar`, `marcar` or `parar`; returns the `AppState` after the action. */
    @JvmStatic
    external fun action(name: String): String

    /** The current `AppState`. */
    @JvmStatic
    external fun state(): String

    /**
     * Opens the core with the app's data folder (if needed), probes and uploads what is pending;
     * the JSON carries `sincronizadas`, `falhas` and `interrompido`.
     */
    @JvmStatic
    external fun syncPending(base: String): String

    /** Before the worker's sync: `na_rede`, `pendentes` and `bytes`. */
    @JvmStatic
    external fun probePending(base: String): String

    /** The system's network callback: without the unmetered Wi-Fi, the running sync stops. */
    @JvmStatic
    external fun network(unmeteredWifi: Boolean): String

    /** The worker was stopped: the upload stops at the next request. */
    @JvmStatic
    external fun interruptSync(): String
}
