package io.github.holetz.eclume.movel.gravador

import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * The background sync: WorkManager runs this worker every 15 min, once when the app opens and on
 * every Parar, Salvar and Pular (chained after a running sync), always on unmetered Wi-Fi and even
 * without the Activity. The core opens with the app's data folder (the same as Tauri's), probes
 * `/server` and only uploads on eclume's network. With something to upload, the worker runs in the
 * foreground (`dataSync`, with the upload count), beyond the 10-min limit; if Android refuses, it
 * runs as ordinary work and the next one resumes from the missing parts. Stopped by the system,
 * the upload stops at the next request (`EclumeCore.interruptSync`).
 */
class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    /** What to do after a pass. */
    enum class Decision { SUCCESS, RETRY }

    companion object {
        private const val TAG = "eclume"
        // The unique work names are persisted by WorkManager and keep their values.
        const val PERIODIC = "eclume-sync"
        const val ON_CONNECT = "eclume-sync-ao-conectar"
        private const val NOTIFICATION_ID = 4204

        /** Only on unmetered Wi-Fi: nothing goes out over mobile data. */
        fun constraints(): Constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.UNMETERED)
            .build()

        /** On open: the 15-min periodic work and one pass on the next Wi-Fi (without duplicating). */
        fun schedule(context: Context) {
            val work = WorkManager.getInstance(context)
            work.enqueueUniquePeriodicWork(
                PERIODIC,
                ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
                    .setConstraints(constraints())
                    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES)
                    .build(),
            )
            work.enqueueUniqueWork(
                ON_CONNECT,
                ExistingWorkPolicy.KEEP,
                onePass(0),
            )
        }

        /**
         * Parar (with the sheet's deadline), Salvar and Pular: one pass on the next Wi-Fi, chained
         * after a running sync, without cancelling it.
         */
        fun scheduleNow(context: Context, delayMs: Long) {
            WorkManager.getInstance(context).enqueueUniqueWork(
                ON_CONNECT,
                ExistingWorkPolicy.APPEND_OR_REPLACE,
                onePass(delayMs),
            )
        }

        private fun onePass(delayMs: Long) = OneTimeWorkRequestBuilder<SyncWorker>()
            .setConstraints(constraints())
            .setInitialDelay(delayMs.coerceAtLeast(0), TimeUnit.MILLISECONDS)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES)
            .build()

        /**
         * `success` when everything was uploaded or there was nothing to upload; `retry` when the
         * cycle failed, was interrupted or a recording failed (the core's backoff decides which is
         * due). The JSON keys are the bridge's wire format.
         */
        fun decide(reply: String?): Decision {
            val json = reply?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return Decision.RETRY
            if (json.has("erro")) return Decision.RETRY
            if (json.optBoolean("interrompido")) return Decision.RETRY
            if (json.optInt("falhas") > 0) return Decision.RETRY
            return Decision.SUCCESS
        }

        /** How many recordings wait on eclume's network (zero off it or on error). */
        fun toUpload(probe: String?): Int {
            val json = probe?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return 0
            if (!json.optBoolean("na_rede")) return 0
            return json.optInt("pendentes").coerceAtLeast(0)
        }

        /** The foreground notification's text, singular or plural (UI copy, pt-BR). */
        fun uploadText(pending: Int): String =
            if (pending == 1) "Enviando 1 gravação" else "Enviando $pending gravações"
    }

    override suspend fun doWork(): Result {
        val base = applicationContext.dataDir.absolutePath
        // The network callback tells the core right away, also in this process opened only by the worker.
        Connectivity.follow(applicationContext)
        val pending = toUpload(withContext(Dispatchers.IO) { EclumeCore.probePending(base) })
        if (pending > 0) enterForeground(pending)
        val reply = coroutineScope {
            val sync = async(Dispatchers.IO) { EclumeCore.syncPending(base) }
            try {
                sync.await()
            } catch (stopped: CancellationException) {
                // WorkManager stopped the worker (lost network, deadline, cancellation): the JNI call
                // cannot be interrupted, so the core stops the upload at the next request.
                EclumeCore.interruptSync()
                throw stopped
            }
        }
        Log.i(TAG, "background sync: $reply")
        return when (decide(reply)) {
            Decision.SUCCESS -> Result.success()
            Decision.RETRY -> Result.retry()
        }
    }

    private suspend fun enterForeground(pending: Int) {
        val notification = RecordingNotification.syncing(applicationContext, uploadText(pending))
        val info = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ForegroundInfo(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            ForegroundInfo(NOTIFICATION_ID, notification)
        }
        try {
            setForeground(info)
        } catch (refused: IllegalStateException) {
            // ForegroundServiceStartNotAllowedException (Android 12+ without the battery exemption):
            // goes on as ordinary work, and the next one resumes from the missing parts.
            Log.w(TAG, "sync without foreground: ${refused.message}")
        }
    }
}
