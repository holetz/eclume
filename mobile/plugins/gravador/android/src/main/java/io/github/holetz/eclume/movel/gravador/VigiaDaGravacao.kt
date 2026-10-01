package io.github.holetz.eclume.movel.gravador

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.SystemClock

/**
 * A vigia do processo que morre gravando. Ao entrar em primeiro plano, o serviço grava a marca
 * "gravando desde" e arma um alarme de 5 min (`setAndAllowWhileIdle`; o Doze estica até ~9 min).
 * Com o serviço vivo, o alarme só se rearma. Num processo novo (o anterior morreu com o serviço),
 * com a marca ainda lá, avisa "A gravação foi interrompida · Toque para abrir" e limpa a marca. O
 * microfone não reabre sozinho: o Android 14+ só aceita o serviço de microfone com a Activity
 * visível.
 */
class VigiaDaGravacao : BroadcastReceiver() {
    companion object {
        private const val PREFERENCIAS = "eclume-gravador"
        private const val GRAVANDO_DESDE = "gravando_desde"
        private const val INTERVALO_MS = 5 * 60_000L
        private const val ID_AVISO = 4203

        private fun preferencias(context: Context) =
            context.getSharedPreferences(PREFERENCIAS, Context.MODE_PRIVATE)

        private fun alarme(context: Context): PendingIntent = PendingIntent.getBroadcast(
            context,
            0,
            Intent(context, VigiaDaGravacao::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        private fun agendar(context: Context) {
            context.getSystemService(AlarmManager::class.java).setAndAllowWhileIdle(
                AlarmManager.ELAPSED_REALTIME_WAKEUP,
                SystemClock.elapsedRealtime() + INTERVALO_MS,
                alarme(context),
            )
        }

        /** O serviço entrou em primeiro plano: marca e arma. */
        fun armar(context: Context) {
            preferencias(context).edit().putLong(GRAVANDO_DESDE, System.currentTimeMillis()).apply()
            agendar(context)
        }

        /** A gravação terminou (ou o serviço saiu): limpa a marca e cancela o alarme. */
        fun desarmar(context: Context) {
            preferencias(context).edit().remove(GRAVANDO_DESDE).apply()
            context.getSystemService(AlarmManager::class.java).cancel(alarme(context))
        }
    }

    override fun onReceive(context: Context, intent: Intent?) {
        if (preferencias(context).getLong(GRAVANDO_DESDE, 0L) == 0L) return
        if (ServicoDeGravacao.vivo) {
            agendar(context)
            return
        }
        Notificacao.avisar(context, TextosDaNotificacao.INTERROMPIDA, "Toque para abrir", ID_AVISO)
        desarmar(context)
    }
}
