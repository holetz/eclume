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

/** O que a notificação mostra, tirado do `EstadoApp` do núcleo. */
data class SessaoNaNotificacao(
    val audioMs: Long,
    val pausada: Boolean,
    val marcadores: Int,
    val espacoLivre: String?,
) {
    companion object {
        /** A sessão do `EstadoApp`; `null` sem gravação em curso (ou com erro do núcleo). */
        fun doEstado(json: String): SessaoNaNotificacao? {
            val estado = runCatching { JSONObject(json) }.getOrNull() ?: return null
            val sessao = estado.optJSONObject("sessao") ?: return null
            return SessaoNaNotificacao(
                audioMs = sessao.optLong("audio_ms"),
                pausada = sessao.optBoolean("pausada"),
                marcadores = sessao.optJSONArray("marcadores")?.length() ?: 0,
                espacoLivre = estado.optString("espaco_livre").takeIf { it.isNotEmpty() && it != "null" },
            )
        }
    }
}

/** Os textos da notificação, puros (testados sem Android). */
object TextosDaNotificacao {
    fun relogio(ms: Long): String {
        val s = (ms / 1000).coerceAtLeast(0)
        return "%02d:%02d:%02d".format(s / 3600, (s % 3600) / 60, s % 60)
    }

    /** "Gravando" ou "Pausado · 00:42:10" (gravando, o relógio é o cronômetro do sistema). */
    fun titulo(sessao: SessaoNaNotificacao): String =
        if (sessao.pausada) "Pausado · ${relogio(sessao.audioMs)}" else "Gravando"

    /** "2 marcadores · espaço para cerca de 9 h". */
    fun texto(sessao: SessaoNaNotificacao): String {
        val marcadores = if (sessao.marcadores == 1) "1 marcador" else "${sessao.marcadores} marcadores"
        return sessao.espacoLivre?.let { "$marcadores · espaço para $it" } ?: marcadores
    }

    /** O instante de início do cronômetro: agora menos o tempo de áudio. */
    fun inicioDoCronometro(agoraMs: Long, sessao: SessaoNaNotificacao): Long = agoraMs - sessao.audioMs
}

/** A notificação contínua da gravação: canal `gravacao`, sem som, visível na tela bloqueada. */
object Notificacao {
    const val ID = 4201
    const val CANAL = "gravacao"

    fun criarCanal(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val canal = NotificationChannel(CANAL, "Gravação", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Mostra a gravação em curso, com Pausar, Marcador e Parar."
            setSound(null, null)
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        }
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(canal)
    }

    private fun acao(context: Context, nome: String, codigo: Int): PendingIntent {
        val intent = Intent(context, ServicoDeGravacao::class.java).setAction(nome)
        return PendingIntent.getService(
            context,
            codigo,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun abrirApp(context: Context): PendingIntent? {
        val intent = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
        return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_IMMUTABLE)
    }

    fun montar(context: Context, sessao: SessaoNaNotificacao, agoraMs: Long): Notification {
        val builder = NotificationCompat.Builder(context, CANAL)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle(TextosDaNotificacao.titulo(sessao))
            .setContentText(TextosDaNotificacao.texto(sessao))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(abrirApp(context))
        if (sessao.pausada) {
            builder.setShowWhen(false)
            builder.addAction(0, "Continuar", acao(context, ServicoDeGravacao.CONTINUAR, 1))
        } else {
            builder.setUsesChronometer(true)
                .setShowWhen(true)
                .setWhen(TextosDaNotificacao.inicioDoCronometro(agoraMs, sessao))
            builder.addAction(0, "Pausar", acao(context, ServicoDeGravacao.PAUSAR, 1))
        }
        builder.addAction(0, "Marcador", acao(context, ServicoDeGravacao.MARCAR, 2))
        builder.addAction(0, "Parar", acao(context, ServicoDeGravacao.PARAR, 3))
        return builder.build()
    }
}
