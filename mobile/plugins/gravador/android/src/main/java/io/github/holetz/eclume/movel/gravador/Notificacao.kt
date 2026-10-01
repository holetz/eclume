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
    /** O microfone caiu e o núcleo tenta reabri-lo (fone plugado ou tirado, Bluetooth). */
    val reconectando: Boolean = false,
    /** O sistema silenciou a captura (chamada, assistente de voz, bloqueio do microfone). */
    val silenciada: Boolean = false,
) {
    companion object {
        /** A notificação de quem ainda não sabe a sessão (um `INICIAR` com erro do núcleo). */
        val NEUTRA = SessaoNaNotificacao(0, true, 0, null)

        /** A sessão do `EstadoApp`; `null` sem gravação em curso (ou com erro do núcleo). */
        fun doEstado(json: String): SessaoNaNotificacao? =
            (RespostaDoNucleo.ler(json) as? RespostaDoNucleo.ComSessao)?.sessao

        internal fun daSessao(estado: JSONObject, sessao: JSONObject): SessaoNaNotificacao =
            SessaoNaNotificacao(
                audioMs = sessao.optLong("audio_ms"),
                pausada = sessao.optBoolean("pausada"),
                marcadores = sessao.optJSONArray("marcadores")?.length() ?: 0,
                espacoLivre = estado.optString("espaco_livre").takeIf { it.isNotEmpty() && it != "null" },
                reconectando = sessao.optString("microfone") == "reconectando",
                silenciada = sessao.optBoolean("silenciada"),
            )
    }
}

/**
 * Como o serviço lê a resposta da ponte: há sessão, não há sessão (`"sessao": null`), ou o núcleo
 * respondeu erro (`{"erro": …}`, também um pânico do Rust). Erro nunca encerra o serviço, a não ser
 * em Parar: a gravação pode seguir viva no núcleo.
 */
sealed class RespostaDoNucleo {
    data class ComSessao(val sessao: SessaoNaNotificacao) : RespostaDoNucleo()
    object SemSessao : RespostaDoNucleo()
    data class Erro(val mensagem: String) : RespostaDoNucleo()

    companion object {
        fun ler(json: String?): RespostaDoNucleo {
            val estado = json?.let { runCatching { JSONObject(it) }.getOrNull() }
                ?: return Erro("resposta inválida do núcleo: $json")
            if (estado.has("erro")) return Erro(estado.optString("erro"))
            val sessao = estado.optJSONObject("sessao") ?: return SemSessao
            return ComSessao(SessaoNaNotificacao.daSessao(estado, sessao))
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

    /**
     * "2 marcadores · espaço para cerca de 9 h"; com o microfone fora, "Microfone desconectado ·
     * reconectando"; com a captura silenciada pelo sistema, "Silenciado pelo sistema".
     */
    fun texto(sessao: SessaoNaNotificacao): String {
        if (sessao.silenciada) return "Silenciado pelo sistema"
        if (sessao.reconectando) return "Microfone desconectado · reconectando"
        val marcadores = if (sessao.marcadores == 1) "1 marcador" else "${sessao.marcadores} marcadores"
        return sessao.espacoLivre?.let { "$marcadores · espaço para $it" } ?: marcadores
    }

    /** O instante de início do cronômetro: agora menos o tempo de áudio. */
    fun inicioDoCronometro(agoraMs: Long, sessao: SessaoNaNotificacao): Long = agoraMs - sessao.audioMs

    const val PAROU = "A gravação parou"
    const val PAROU_COM_ERRO = "A gravação parou com erro"
    const val INTERROMPIDA = "A gravação foi interrompida"

    /** "pouco espaço livre · 00:12:30 salvos" (o motivo vem do núcleo). */
    fun parou(motivo: String, duracaoMs: Long?): String =
        duracaoMs?.let { "$motivo · ${relogio(it)} salvos" } ?: motivo
}

/**
 * A notificação contínua da gravação (canal `gravacao`, sem som, visível na tela bloqueada) e os
 * avisos de quando ela para sem pedido (canal `avisos`, que toca).
 */
object Notificacao {
    const val ID = 4201
    const val ID_AVISO = 4202
    const val CANAL = "gravacao"
    const val CANAL_AVISOS = "avisos"

    fun criarCanal(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val gerente = context.getSystemService(NotificationManager::class.java)
        val canal = NotificationChannel(CANAL, "Gravação", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Mostra a gravação em curso, com Pausar, Marcador e Parar."
            setSound(null, null)
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        }
        gerente.createNotificationChannel(canal)
        val avisos = NotificationChannel(CANAL_AVISOS, "Avisos da gravação", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "Avisa quando a gravação para sem pedido ou é interrompida."
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        }
        gerente.createNotificationChannel(avisos)
    }

    /** Posta um aviso no canal `avisos` (toca), que abre o app ao toque. */
    fun avisar(context: Context, titulo: String, texto: String, id: Int = ID_AVISO) {
        criarCanal(context)
        val aviso = NotificationCompat.Builder(context, CANAL_AVISOS)
            .setSmallIcon(android.R.drawable.stat_notify_error)
            .setContentTitle(titulo)
            .setContentText(texto)
            .setAutoCancel(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setContentIntent(abrirApp(context))
            .build()
        runCatching { context.getSystemService(NotificationManager::class.java).notify(id, aviso) }
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
