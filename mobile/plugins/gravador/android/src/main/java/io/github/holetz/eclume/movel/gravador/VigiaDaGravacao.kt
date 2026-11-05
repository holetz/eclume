package io.github.holetz.eclume.movel.gravador

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.SystemClock

/**
 * The watchdog of the process that dies while recording. On entering the foreground, the service
 * writes the "recording since" mark and arms a 5-min alarm (`setAndAllowWhileIdle`; Doze stretches
 * it to ~9 min). With the service alive, the alarm only rearms. In a new process (the previous one
 * died with the service), with the mark still there, it shows the interrupted-recording notice and
 * clears the mark. The microphone does not reopen on its own: Android 14+ only accepts the
 * microphone service with the Activity visible.
 *
 * The class keeps its name: the alarm's PendingIntent names this component, and an alarm armed
 * before an update must still reach it.
 */
class VigiaDaGravacao : BroadcastReceiver() {
    companion object {
        // The SharedPreferences file and key are persisted on the device and keep their names.
        private const val PREFERENCES = "eclume-gravador"
        private const val RECORDING_SINCE = "gravando_desde"
        private const val INTERVAL_MS = 5 * 60_000L
        private const val WARNING_ID = 4203

        private fun preferences(context: Context) =
            context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

        private fun alarm(context: Context): PendingIntent = PendingIntent.getBroadcast(
            context,
            0,
            Intent(context, VigiaDaGravacao::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        private fun schedule(context: Context) {
            context.getSystemService(AlarmManager::class.java).setAndAllowWhileIdle(
                AlarmManager.ELAPSED_REALTIME_WAKEUP,
                SystemClock.elapsedRealtime() + INTERVAL_MS,
                alarm(context),
            )
        }

        /** The service entered the foreground: marks and arms. */
        fun arm(context: Context) {
            preferences(context).edit().putLong(RECORDING_SINCE, System.currentTimeMillis()).apply()
            schedule(context)
        }

        /** The recording ended (or the service exited): clears the mark and cancels the alarm. */
        fun disarm(context: Context) {
            preferences(context).edit().remove(RECORDING_SINCE).apply()
            context.getSystemService(AlarmManager::class.java).cancel(alarm(context))
        }
    }

    override fun onReceive(context: Context, intent: Intent?) {
        if (preferences(context).getLong(RECORDING_SINCE, 0L) == 0L) return
        if (RecordingService.alive) {
            schedule(context)
            return
        }
        // The process may hold no core here: the warning follows the device's locale.
        val strings = Localized.strings(context, null)
        RecordingNotification.warn(
            context,
            strings,
            NotificationTexts.interruptedTitle(strings),
            strings.get("warning_tap_to_open"),
            WARNING_ID,
        )
        disarm(context)
    }
}
