package io.github.holetz.eclume.movel.gravador

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import org.json.JSONObject

/** What the notification shows, taken from the core's `AppState`. */
data class NotificationSession(
    val audioMs: Long,
    val paused: Boolean,
    val markers: Int,
    val freeSpace: String?,
    /** The microphone dropped and the core tries to reopen it (headset in or out, Bluetooth). */
    val reconnecting: Boolean = false,
    /** The system silenced the capture (a call, the voice assistant, the microphone block). */
    val silenced: Boolean = false,
) {
    companion object {
        /** The notification of one who does not know the session yet (a `INICIAR` with a core error). */
        val NEUTRAL = NotificationSession(0, true, 0, null)

        /** The session of the `AppState`; `null` with no recording running (or with a core error). */
        fun fromState(json: String): NotificationSession? =
            (CoreReply.read(json) as? CoreReply.WithSession)?.session

        // The JSON keys are the core's `AppState` serialization and keep their names.
        internal fun fromSession(state: JSONObject, session: JSONObject): NotificationSession =
            NotificationSession(
                audioMs = session.optLong("audio_ms"),
                paused = session.optBoolean("pausada"),
                markers = session.optJSONArray("marcadores")?.length() ?: 0,
                freeSpace = state.optString("espaco_livre").takeIf { it.isNotEmpty() && it != "null" },
                reconnecting = session.optString("microfone") == "reconectando",
                silenced = session.optBoolean("silenciada"),
            )
    }
}

/**
 * How the service reads the bridge's reply: there is a session, there is none (`"sessao": null`),
 * or the core answered an error (`{"erro": …}`, also a Rust panic). An error never ends the
 * service, except on Parar: the recording may still be alive in the core.
 */
sealed class CoreReply {
    data class WithSession(val session: NotificationSession) : CoreReply()
    object NoSession : CoreReply()
    data class Failure(val message: String) : CoreReply()

    companion object {
        fun read(json: String?): CoreReply {
            val state = json?.let { runCatching { JSONObject(it) }.getOrNull() }
                ?: return Failure("resposta inválida do núcleo: $json")
            if (state.has("erro")) return Failure(state.optString("erro"))
            val session = state.optJSONObject("sessao") ?: return NoSession
            return WithSession(NotificationSession.fromSession(state, session))
        }
    }
}

/** The notification's texts, pure (tested without Android). They are UI copy and stay pt-BR. */
object NotificationTexts {
    fun clock(ms: Long): String {
        val s = (ms / 1000).coerceAtLeast(0)
        return "%02d:%02d:%02d".format(s / 3600, (s % 3600) / 60, s % 60)
    }

    /** "Gravando" or "Pausado · 00:42:10" (while recording, the clock is the system chronometer). */
    fun title(session: NotificationSession): String =
        if (session.paused) "Pausado · ${clock(session.audioMs)}" else "Gravando"

    /**
     * The marker count and the space left; with the microphone gone, the reconnecting line; with
     * the capture silenced by the system, the silenced line.
     */
    fun text(session: NotificationSession): String {
        if (session.silenced) return "Silenciado pelo sistema"
        if (session.reconnecting) return "Microfone desconectado · reconectando"
        val markers = if (session.markers == 1) "1 marcador" else "${session.markers} marcadores"
        return session.freeSpace?.let { "$markers · espaço para $it" } ?: markers
    }

    /** The chronometer's start instant: now minus the audio time. */
    fun chronometerStart(nowMs: Long, session: NotificationSession): Long = nowMs - session.audioMs

    const val STOPPED = "A gravação parou"
    const val STOPPED_WITH_ERROR = "A gravação parou com erro"
    const val INTERRUPTED = "A gravação foi interrompida"

    /** The reason (from the core) and the saved time. */
    fun stopped(reason: String, durationMs: Long?): String =
        durationMs?.let { "$reason · ${clock(it)} salvos" } ?: reason
}

/**
 * The ongoing recording notification (`gravacao` channel, silent, visible on the lock screen) and
 * the warnings of when it stops without being asked (`avisos` channel, which rings). The channel
 * ids are registered on the device and keep their names.
 */
object RecordingNotification {
    const val ID = 4201
    const val WARNING_ID = 4202
    const val CHANNEL = "gravacao"
    const val WARNINGS_CHANNEL = "avisos"
    const val SYNC_CHANNEL = "sync"

    fun createChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(CHANNEL, "Gravação", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Mostra a gravação em curso, com Pausar, Marcador e Parar."
            setSound(null, null)
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        }
        manager.createNotificationChannel(channel)
        val warnings = NotificationChannel(WARNINGS_CHANNEL, "Avisos da gravação", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "Avisa quando a gravação para sem pedido ou é interrompida."
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        }
        manager.createNotificationChannel(warnings)
        val sync = NotificationChannel(SYNC_CHANNEL, "Envio das gravações", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Mostra o envio das gravações ao servidor em segundo plano."
            setSound(null, null)
        }
        manager.createNotificationChannel(sync)
    }

    /** The notification of the `SyncWorker` in the foreground (the upload count). */
    fun syncing(context: Context, text: String): Notification {
        createChannels(context)
        return NotificationCompat.Builder(context, SYNC_CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle(text)
            .setContentText("No Wi‑Fi do servidor eclume")
            .setOngoing(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setContentIntent(openApp(context))
            .build()
    }

    /** Posts a warning on the `avisos` channel (it rings), which opens the app on tap. */
    fun warn(context: Context, title: String, text: String, id: Int = WARNING_ID) {
        createChannels(context)
        val warning = NotificationCompat.Builder(context, WARNINGS_CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_error)
            .setContentTitle(title)
            .setContentText(text)
            .setAutoCancel(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setContentIntent(openApp(context))
            .build()
        runCatching { context.getSystemService(NotificationManager::class.java).notify(id, warning) }
    }

    private fun action(context: Context, name: String, code: Int): PendingIntent {
        val intent = Intent(context, RecordingService::class.java).setAction(name)
        return PendingIntent.getService(
            context,
            code,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun openApp(context: Context): PendingIntent? {
        val intent = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
        return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_IMMUTABLE)
    }

    fun build(context: Context, session: NotificationSession, nowMs: Long): Notification {
        val builder = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle(NotificationTexts.title(session))
            .setContentText(NotificationTexts.text(session))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(openApp(context))
        if (session.paused) {
            builder.setShowWhen(false)
            builder.addAction(0, "Continuar", action(context, RecordingService.RESUME, 1))
        } else {
            builder.setUsesChronometer(true)
                .setShowWhen(true)
                .setWhen(NotificationTexts.chronometerStart(nowMs, session))
            builder.addAction(0, "Pausar", action(context, RecordingService.PAUSE, 1))
        }
        builder.addAction(0, "Marcador", action(context, RecordingService.MARK, 2))
        builder.addAction(0, "Parar", action(context, RecordingService.STOP, 3))
        return builder.build()
    }
}
