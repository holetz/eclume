package io.github.holetz.eclume.movel.gravador

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.webkit.WebView
import java.util.concurrent.atomic.AtomicBoolean
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

// The `@Command` method names, the `@InvokeArg` property names, the permission aliases and the
// JSON keys are the plugin's IPC contract with the Rust side and the UI, and keep their names.

@InvokeArg
class DiscoverArgs {
    var segundos: Int = 10
}

@InvokeArg
class UrlArgs {
    lateinit var url: String
}

@InvokeArg
class InstallerArgs {
    lateinit var caminho: String
}

@InvokeArg
class ScheduleSyncArgs {
    var atrasoMs: Long = 0
}

@InvokeArg
class StopArgs {
    var motivo: String? = null
    var duracaoMs: Long? = null
}

/**
 * The `eclume-gravador` plugin: what only the system does, asked by the app's Rust
 * (`run_mobile_plugin`) or by the UI (`plugin:eclume-gravador|…`). The `microfone` and
 * `notificacoes` permissions are requested by the UI before recording (`request_permissions`).
 */
@TauriPlugin(
    permissions = [
        Permission(strings = [Manifest.permission.RECORD_AUDIO], alias = "microfone"),
        Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notificacoes"),
    ],
)
class RecorderPlugin(private val activity: Activity) : Plugin(activity) {
    /** A tap on the "Gravar agora" shortcut waiting for the UI (`consumirAtalho`). */
    private val pendingShortcut = AtomicBoolean(false)

    override fun load(webView: WebView) {
        Connectivity.follow(activity)
        SyncWorker.schedule(activity)
        // Cold start through the shortcut: the intent is the Activity's.
        noteShortcut(activity.intent)
    }

    /** The app already open (the MainActivity is `singleTask`): the shortcut arrives here. */
    override fun onNewIntent(intent: Intent) {
        noteShortcut(intent)
    }

    /**
     * Keeps the tap on the shortcut and swaps the intent's action for `MAIN`: recreating the
     * Activity and coming back from the recents do not fire another recording.
     */
    private fun noteShortcut(intent: Intent?) {
        if (intent == null || !Shortcut.isRecordNow(intent.action, intent.flags)) return
        pendingShortcut.set(true)
        intent.action = Intent.ACTION_MAIN
        activity.intent = intent
    }

    /** `true` once per tap on the shortcut; the UI decides to record by the Gravar button's rule. */
    @Command
    fun consumirAtalho(invoke: Invoke) {
        invoke.resolve(JSObject().apply { put("gravar", pendingShortcut.getAndSet(false)) })
    }

    /** Starts the service; the `invoke` is answered by the service after `startForeground`. */
    @Command
    fun iniciarServico(invoke: Invoke) {
        RecordingService.start(activity, invoke)
    }

    @Command
    fun atualizarServico(invoke: Invoke) {
        RecordingService.update(activity)
        invoke.resolve()
    }

    /** Removes the notification; with `motivo` (a stop nobody asked for), shows the stop notice. */
    @Command
    fun pararServico(invoke: Invoke) {
        val args = invoke.parseArgs(StopArgs::class.java)
        RecordingService.end(activity, args.motivo, args.duracaoMs)
        invoke.resolve()
    }

    /** Schedules a `SyncWorker` pass on the next unmetered Wi-Fi (Parar, Salvar and Pular). */
    @Command
    fun agendarSync(invoke: Invoke) {
        val args = invoke.parseArgs(ScheduleSyncArgs::class.java)
        SyncWorker.scheduleNow(activity, args.atrasoMs)
        invoke.resolve()
    }

    /** The app-settings shortcut: the system screen with eclume's permissions. */
    @Command
    fun abrirConfiguracoesDoApp(invoke: Invoke) {
        val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", activity.packageName, null))
        activity.startActivity(intent)
        invoke.resolve()
    }

    /** Asks for the battery-optimization exemption (the system dialog). */
    @Command
    fun pedirIsencaoDeBateria(invoke: Invoke) {
        Device.markExemptionAsked(activity)
        val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${activity.packageName}"))
        activity.startActivity(intent)
        invoke.resolve()
    }

    /** Looks for the server through mDNS; returns the raw announcements, which the core parses. */
    @Command
    fun descobrir(invoke: Invoke) {
        val args = invoke.parseArgs(DiscoverArgs::class.java)
        val services = JSArray()
        for (announcement in Discovery(activity).search(args.segundos)) {
            val txt = JSObject()
            announcement.txt.forEach { (key, value) -> txt.put(key, value) }
            services.put(JSObject().apply {
                put("nome", announcement.name)
                put("txt", txt)
            })
        }
        invoke.resolve(JSObject().apply { put("servicos", services) })
    }

    /**
     * Battery, free space, unmetered Wi-Fi, model, the edge-to-edge insets (dp), whether
     * notifications are allowed and the battery-optimization exemption.
     */
    @Command
    fun estadoDoDispositivo(invoke: Invoke) {
        val state = Device.read(activity)
        invoke.resolve(JSObject().apply {
            put("bateria", state.battery)
            put("carregando", state.charging)
            put("espacoLivre", state.freeSpace)
            put("wifiNaoMedido", state.unmeteredWifi)
            put("modelo", state.model)
            put("insetTopo", state.insetTop.toDouble())
            put("insetBase", state.insetBottom.toDouble())
            put("notificacoes", state.notifications)
            put("isencaoDeBateria", state.batteryExemption)
        })
    }

    /** Opens the system installer for the downloaded APK (`aberto: false` when it first went to
     * ask for the permission to install from unknown sources). */
    @Command
    fun abrirInstalador(invoke: Invoke) {
        val args = invoke.parseArgs(InstallerArgs::class.java)
        val opened = Updater.open(activity, args.caminho)
        invoke.resolve(JSObject().apply { put("aberto", opened) })
    }

    /** Opens `url` in the system browser (the detail's "Abrir na web"), as the installer opens the APK. */
    @Command
    fun abrirUrl(invoke: Invoke) {
        val args = invoke.parseArgs(UrlArgs::class.java)
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(args.url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        activity.startActivity(intent)
        invoke.resolve()
    }
}
