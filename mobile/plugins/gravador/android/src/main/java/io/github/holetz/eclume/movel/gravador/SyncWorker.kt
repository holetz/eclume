package io.github.holetz.eclume.movel.gravador

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/**
 * O sync em segundo plano: o WorkManager roda este worker a cada 15 min e uma vez ao ganhar Wi-Fi
 * não medido, mesmo sem a Activity. O núcleo abre com a pasta de dados do app (a mesma do Tauri),
 * faz a sonda do `/server` e só sobe na rede do eclume.
 */
class SyncWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    companion object {
        private const val TAG = "eclume"
        const val PERIODICO = "eclume-sync"
        const val AO_CONECTAR = "eclume-sync-ao-conectar"

        /** Só no Wi-Fi não medido: nada sai pelos dados móveis. */
        fun restricoes(): Constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.UNMETERED)
            .build()

        fun agendar(context: Context) {
            val trabalho = WorkManager.getInstance(context)
            trabalho.enqueueUniquePeriodicWork(
                PERIODICO,
                ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
                    .setConstraints(restricoes())
                    .build(),
            )
            trabalho.enqueueUniqueWork(
                AO_CONECTAR,
                ExistingWorkPolicy.KEEP,
                OneTimeWorkRequestBuilder<SyncWorker>().setConstraints(restricoes()).build(),
            )
        }
    }

    override fun doWork(): Result {
        val resposta = EclumeCore.syncPendentes(applicationContext.dataDir.absolutePath)
        Log.i(TAG, "sync em segundo plano: $resposta")
        // Uma falha de upload fica na fila com o backoff do núcleo; o worker não repete sozinho.
        return Result.success()
    }
}
