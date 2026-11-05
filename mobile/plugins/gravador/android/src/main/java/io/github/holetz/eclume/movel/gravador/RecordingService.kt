package io.github.holetz.eclume.movel.gravador

import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioManager
import android.media.AudioRecordingConfiguration
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import app.tauri.plugin.Invoke

/**
 * The microphone-type foreground service: keeps the process and the microphone alive with the
 * screen locked and draws the ongoing notification. The recording itself belongs to the Rust core,
 * in the same process; the notification's actions arrive here and go to the core through the JNI
 * bridge.
 *
 * The core's reply is read as a session, no session or an error ([CoreReply]): an error keeps the
 * foreground and the last notification (the recording may still be alive), only "no session" ends
 * it, and Parar always ends it. The plugin's `iniciarServico` is only answered after
 * `startForeground` (or rejected with the refusal's reason, or by a deadline).
 */
class RecordingService : Service() {
    companion object {
        private const val TAG = "eclume"
        // The intent actions and extras keep their values: the notification's PendingIntents carry
        // them.
        const val START = "io.github.holetz.eclume.movel.INICIAR"
        const val UPDATE = "io.github.holetz.eclume.movel.ATUALIZAR"
        const val PAUSE = "io.github.holetz.eclume.movel.PAUSAR"
        const val RESUME = "io.github.holetz.eclume.movel.CONTINUAR"
        const val MARK = "io.github.holetz.eclume.movel.MARCAR"
        const val STOP = "io.github.holetz.eclume.movel.PARAR"
        private const val END = "io.github.holetz.eclume.movel.ENCERRAR"
        private const val EXTRA_REASON = "motivo"
        private const val EXTRA_DURATION = "duracaoMs"
        /** How long `iniciarServico` waits for the foreground before refusing. */
        private const val FOREGROUND_DEADLINE_MS = 5_000L

        /** The `iniciarServico` waiting for the foreground. */
        @Volatile
        private var pending: Invoke? = null

        /** The service exists in this process (the watchdog tells the process that died recording). */
        @Volatile
        var alive = false
            private set

        /**
         * Starts the service (with the Activity visible, as Android 14 requires for the microphone)
         * and keeps the `invoke`, answered by the service after `startForeground`.
         */
        fun start(context: Context, invoke: Invoke) {
            answerStart("outro início substituiu este")
            pending = invoke
            try {
                ContextCompat.startForegroundService(context, Intent(context, RecordingService::class.java).setAction(START))
            } catch (error: RuntimeException) {
                // ForegroundServiceStartNotAllowedException (API 31+) and SecurityException.
                Log.w(TAG, "recording service refused", error)
                answerStart(error.message ?: error.javaClass.simpleName)
                return
            }
            Handler(Looper.getMainLooper()).postDelayed({
                if (pending === invoke) answerStart("o serviço não entrou em primeiro plano em 5 s")
            }, FOREGROUND_DEADLINE_MS)
        }

        /** Resolves (`error` null) or rejects the waiting `iniciarServico`, if any. */
        private fun answerStart(error: String?) {
            val invoke = pending ?: return
            pending = null
            if (error == null) invoke.resolve() else invoke.reject(error)
        }

        fun update(context: Context) {
            context.startService(Intent(context, RecordingService::class.java).setAction(UPDATE))
        }

        /**
         * The core already stopped the recording: removes the notification and ends. With `reason`
         * (a stop nobody asked for), shows the stop notice before exiting.
         */
        fun end(context: Context, reason: String? = null, durationMs: Long? = null) {
            val intent = Intent(context, RecordingService::class.java).setAction(END)
            reason?.let { intent.putExtra(EXTRA_REASON, it) }
            durationMs?.let { intent.putExtra(EXTRA_DURATION, it) }
            context.startService(intent)
        }

        /** The core's action name for each notification action (the bridge's wire names). */
        fun coreAction(action: String?): String? = when (action) {
            PAUSE -> "pausar"
            RESUME -> "continuar"
            MARK -> "marcar"
            STOP -> "parar"
            else -> null
        }
    }

    private var inForeground = false
    private var wakeLock: PowerManager.WakeLock? = null
    private var silenceWatch: AudioManager.AudioRecordingCallback? = null
    private var silenced = false

    /** The core's resolved locale, from its last reply (`AppState.locale`). */
    private var locale: String? = null

    /** The texts in the core's locale; with no reply yet, it reads the state. */
    private fun strings(): Strings {
        if (locale == null) locale = Localized.localeOf(EclumeCore.state())
        return Localized.strings(this, locale)
    }

    /** Reads a core reply, keeping its locale for the notification. */
    private fun read(json: String?): CoreReply {
        Localized.localeOf(json)?.let { locale = it }
        return CoreReply.read(json)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        alive = true
        RecordingNotification.createChannels(this, strings())
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action
        if (action == END) {
            intent.getStringExtra(EXTRA_REASON)?.let { reason ->
                val duration = if (intent.hasExtra(EXTRA_DURATION)) intent.getLongExtra(EXTRA_DURATION, 0) else null
                val strings = strings()
                RecordingNotification.warn(
                    this,
                    strings,
                    NotificationTexts.stoppedTitle(strings),
                    NotificationTexts.stopped(strings, reason, duration),
                )
            }
            finish()
            return START_NOT_STICKY
        }
        val core = coreAction(action)
        val reply = read(if (core != null) EclumeCore.action(core) else EclumeCore.state())
        when (reply) {
            is CoreReply.WithSession -> show(reply.session)
            CoreReply.NoSession -> {
                if (action == START) {
                    // Android requires startForeground even when there is nothing to show.
                    Log.w(TAG, "service started with no recording running")
                    answerStart("nenhuma gravação em curso")
                    enterForeground(NotificationSession.NEUTRAL)
                }
                finish()
            }
            is CoreReply.Failure -> {
                Log.w(TAG, "core error on action $action: ${reply.message}")
                if (action == STOP) {
                    // Parar always ends, so no notification is left stuck to a core in error.
                    val strings = strings()
                    RecordingNotification.warn(this, strings, NotificationTexts.stoppedWithErrorTitle(strings), reply.message)
                    finish()
                } else if (!inForeground) {
                    enterForeground(NotificationSession.NEUTRAL)
                }
            }
        }
        return START_NOT_STICKY
    }

    private fun show(session: NotificationSession) {
        if (!inForeground) {
            enterForeground(session)
        } else {
            getSystemService(NotificationManager::class.java)
                .notify(RecordingNotification.ID, RecordingNotification.build(this, strings(), session, System.currentTimeMillis()))
        }
    }

    /** Enters the foreground and answers `iniciarServico`; returns whether it entered. */
    private fun enterForeground(session: NotificationSession): Boolean {
        val notification = RecordingNotification.build(this, strings(), session, System.currentTimeMillis())
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        } else {
            0
        }
        try {
            ServiceCompat.startForeground(this, RecordingNotification.ID, notification, type)
        } catch (error: RuntimeException) {
            // ForegroundServiceStartNotAllowedException (API 31+) and SecurityException (without the
            // microphone permission, or outside the window in which Android accepts the type).
            Log.w(TAG, "startForeground refused", error)
            answerStart(error.message ?: error.javaClass.simpleName)
            stopSelf()
            return false
        }
        inForeground = true
        answerStart(null)
        if (wakeLock == null) {
            wakeLock = getSystemService(PowerManager::class.java)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "eclume:gravacao")
                .apply { acquire() }
        }
        VigiaDaGravacao.arm(this)
        watchSilence()
        return true
    }

    /**
     * API 29+: the `AudioRecordingCallback` says when the system silences the app's own capture
     * (`isClientSilenced`: a call, the voice assistant, the microphone block). The core marks it
     * and the notification shows the silenced line. Below API 29 there is no signal.
     */
    private fun watchSilence() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || silenceWatch != null) return
        val watch = object : AudioManager.AudioRecordingCallback() {
            override fun onRecordingConfigChanged(configs: MutableList<AudioRecordingConfiguration>) {
                val now = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && configs.any { it.isClientSilenced }
                if (now == silenced) return
                silenced = now
                val reply = read(EclumeCore.action(if (now) "silenciado" else "audivel"))
                if (reply is CoreReply.WithSession) show(reply.session)
            }
        }
        getSystemService(AudioManager::class.java)
            .registerAudioRecordingCallback(watch, Handler(Looper.getMainLooper()))
        silenceWatch = watch
    }

    private fun stopWatchingSilence() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        silenceWatch?.let { getSystemService(AudioManager::class.java).unregisterAudioRecordingCallback(it) }
        silenceWatch = null
        silenced = false
    }

    private fun finish() {
        stopWatchingSilence()
        VigiaDaGravacao.disarm(this)
        wakeLock?.takeIf { it.isHeld }?.release()
        wakeLock = null
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        inForeground = false
        stopSelf()
    }

    override fun onDestroy() {
        // The system killed the service with the recording running: the core closes the file and warns.
        val state = EclumeCore.state()
        val session = NotificationSession.fromState(state)
        if (session != null) {
            Log.w(TAG, "service destroyed while recording; stopping the recording")
            EclumeCore.action("parar")
            Localized.localeOf(state)?.let { locale = it }
            val strings = strings()
            RecordingNotification.warn(
                this,
                strings,
                NotificationTexts.stoppedTitle(strings),
                NotificationTexts.stopped(strings, strings.get("warning_system_ended"), session.audioMs),
            )
        }
        stopWatchingSilence()
        VigiaDaGravacao.disarm(this)
        wakeLock?.takeIf { it.isHeld }?.release()
        alive = false
        super.onDestroy()
    }
}
