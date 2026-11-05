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
 * O sync em segundo plano: o WorkManager roda este worker a cada 15 min, uma vez ao abrir o app e
 * a cada Parar, Salvar e Pular (encadeado depois de um sync em curso), sempre no Wi-Fi não medido e
 * mesmo sem a Activity. O núcleo abre com a pasta de dados do app (a mesma do Tauri), faz a sonda
 * do `/server` e só sobe na rede do eclume. Com algo a subir, o worker roda em primeiro plano
 * (`dataSync`, "Enviando N gravações"), fora do limite de 10 min; se o Android recusar, roda como
 * trabalho comum e o próximo retoma das partes que faltam. Parado pelo sistema, o upload para na
 * próxima requisição (`EclumeCore.interruptSync`).
 */
class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    /** O que fazer depois de uma passada. */
    enum class Decisao { SUCESSO, REPETIR }

    companion object {
        private const val TAG = "eclume"
        const val PERIODICO = "eclume-sync"
        const val AO_CONECTAR = "eclume-sync-ao-conectar"
        private const val ID_NOTIFICACAO = 4204

        /** Só no Wi-Fi não medido: nada sai pelos dados móveis. */
        fun restricoes(): Constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.UNMETERED)
            .build()

        /** Na abertura: o periódico de 15 min e uma passada no próximo Wi-Fi (sem duplicar). */
        fun agendar(context: Context) {
            val trabalho = WorkManager.getInstance(context)
            trabalho.enqueueUniquePeriodicWork(
                PERIODICO,
                ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
                    .setConstraints(restricoes())
                    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES)
                    .build(),
            )
            trabalho.enqueueUniqueWork(
                AO_CONECTAR,
                ExistingWorkPolicy.KEEP,
                passada(0),
            )
        }

        /**
         * Parar (com o prazo da folha), Salvar e Pular: uma passada no próximo Wi-Fi, encadeada
         * depois de um sync em curso, sem cancelá-lo.
         */
        fun agendarAgora(context: Context, atrasoMs: Long) {
            WorkManager.getInstance(context).enqueueUniqueWork(
                AO_CONECTAR,
                ExistingWorkPolicy.APPEND_OR_REPLACE,
                passada(atrasoMs),
            )
        }

        private fun passada(atrasoMs: Long) = OneTimeWorkRequestBuilder<SyncWorker>()
            .setConstraints(restricoes())
            .setInitialDelay(atrasoMs.coerceAtLeast(0), TimeUnit.MILLISECONDS)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES)
            .build()

        /**
         * `success` quando subiu tudo ou não havia o que subir; `retry` quando o ciclo deu erro,
         * foi interrompido ou alguma gravação falhou (o backoff do núcleo decide qual está vencida).
         */
        fun decidir(resposta: String?): Decisao {
            val json = resposta?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return Decisao.REPETIR
            if (json.has("erro")) return Decisao.REPETIR
            if (json.optBoolean("interrompido")) return Decisao.REPETIR
            if (json.optInt("falhas") > 0) return Decisao.REPETIR
            return Decisao.SUCESSO
        }

        /** Quantas gravações aguardam na rede do eclume (zero fora dela ou com erro). */
        fun aSubir(sondagem: String?): Int {
            val json = sondagem?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return 0
            if (!json.optBoolean("na_rede")) return 0
            return json.optInt("pendentes").coerceAtLeast(0)
        }

        /** "Enviando 1 gravação" ou "Enviando 3 gravações". */
        fun textoDoEnvio(pendentes: Int): String =
            if (pendentes == 1) "Enviando 1 gravação" else "Enviando $pendentes gravações"
    }

    override suspend fun doWork(): Result {
        val base = applicationContext.dataDir.absolutePath
        // O callback de rede avisa o núcleo na hora, também neste processo aberto só pelo worker.
        Conectividade.acompanhar(applicationContext)
        val pendentes = aSubir(withContext(Dispatchers.IO) { EclumeCore.probePending(base) })
        if (pendentes > 0) entrarEmPrimeiroPlano(pendentes)
        val resposta = coroutineScope {
            val sync = async(Dispatchers.IO) { EclumeCore.syncPending(base) }
            try {
                sync.await()
            } catch (parado: CancellationException) {
                // O WorkManager parou o worker (perdeu a rede, prazo, cancelamento): a chamada JNI
                // não é interrompível, então o núcleo para o upload na próxima requisição.
                EclumeCore.interruptSync()
                throw parado
            }
        }
        Log.i(TAG, "sync em segundo plano: $resposta")
        return when (decidir(resposta)) {
            Decisao.SUCESSO -> Result.success()
            Decisao.REPETIR -> Result.retry()
        }
    }

    private suspend fun entrarEmPrimeiroPlano(pendentes: Int) {
        val notificacao = Notificacao.sincronizando(applicationContext, textoDoEnvio(pendentes))
        val info = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ForegroundInfo(ID_NOTIFICACAO, notificacao, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            ForegroundInfo(ID_NOTIFICACAO, notificacao)
        }
        try {
            setForeground(info)
        } catch (recusado: IllegalStateException) {
            // ForegroundServiceStartNotAllowedException (Android 12+ sem a isenção de bateria):
            // segue como trabalho comum, e o próximo retoma das partes que faltam.
            Log.w(TAG, "sync sem primeiro plano: ${recusado.message}")
        }
    }
}
