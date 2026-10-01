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

/**
 * O serviço em primeiro plano do tipo microfone: mantém o processo e o microfone vivos com a tela
 * bloqueada e desenha a notificação contínua. A gravação em si é do núcleo Rust, no mesmo
 * processo; as ações da notificação chegam aqui e vão ao núcleo pela ponte JNI.
 */
class ServicoDeGravacao : Service() {
    companion object {
        private const val TAG = "eclume"
        const val INICIAR = "io.github.holetz.eclume.movel.INICIAR"
        const val ATUALIZAR = "io.github.holetz.eclume.movel.ATUALIZAR"
        const val PAUSAR = "io.github.holetz.eclume.movel.PAUSAR"
        const val CONTINUAR = "io.github.holetz.eclume.movel.CONTINUAR"
        const val MARCAR = "io.github.holetz.eclume.movel.MARCAR"
        const val PARAR = "io.github.holetz.eclume.movel.PARAR"
        private const val ENCERRAR = "io.github.holetz.eclume.movel.ENCERRAR"

        /** Sobe o serviço (com a Activity visível, como o Android 14 exige para o microfone). */
        fun iniciar(context: Context) =
            ContextCompat.startForegroundService(context, Intent(context, ServicoDeGravacao::class.java).setAction(INICIAR))

        fun atualizar(context: Context) {
            context.startService(Intent(context, ServicoDeGravacao::class.java).setAction(ATUALIZAR))
        }

        /** A gravação já foi parada pelo núcleo: só tira a notificação e encerra. */
        fun encerrar(context: Context) {
            context.startService(Intent(context, ServicoDeGravacao::class.java).setAction(ENCERRAR))
        }

        /** O nome da ação do núcleo para cada ação da notificação. */
        fun acaoDoNucleo(acao: String?): String? = when (acao) {
            PAUSAR -> "pausar"
            CONTINUAR -> "continuar"
            MARCAR -> "marcar"
            PARAR -> "parar"
            else -> null
        }
    }

    private var emPrimeiroPlano = false
    private var trava: PowerManager.WakeLock? = null
    private var vigiaDoSilencio: AudioManager.AudioRecordingCallback? = null
    private var silenciada = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Notificacao.criarCanal(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val acao = intent?.action
        val nucleo = acaoDoNucleo(acao)
        val estado = when {
            acao == ENCERRAR -> null
            nucleo != null -> EclumeCore.acao(nucleo)
            else -> EclumeCore.estado()
        }
        val sessao = estado?.let { SessaoNaNotificacao.doEstado(it) }
        if (sessao == null) {
            if (acao == INICIAR) {
                // O Android exige o startForeground mesmo quando não há o que mostrar.
                Log.w(TAG, "serviço iniciado sem gravação em curso: $estado")
                entrarEmPrimeiroPlano(SessaoNaNotificacao(0, true, 0, null))
            }
            encerrar()
            return START_NOT_STICKY
        }
        if (!emPrimeiroPlano) {
            entrarEmPrimeiroPlano(sessao)
        } else {
            getSystemService(NotificationManager::class.java)
                .notify(Notificacao.ID, Notificacao.montar(this, sessao, System.currentTimeMillis()))
        }
        return START_NOT_STICKY
    }

    private fun entrarEmPrimeiroPlano(sessao: SessaoNaNotificacao) {
        val notificacao = Notificacao.montar(this, sessao, System.currentTimeMillis())
        val tipo = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        } else {
            0
        }
        ServiceCompat.startForeground(this, Notificacao.ID, notificacao, tipo)
        emPrimeiroPlano = true
        vigiarSilencio()
        if (trava == null) {
            trava = getSystemService(PowerManager::class.java)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "eclume:gravacao")
                .apply { acquire() }
        }
    }

    /**
     * API 29+: o `AudioRecordingCallback` diz quando o sistema silencia a captura do próprio app
     * (`isClientSilenced`: chamada, assistente de voz, bloqueio do microfone). O núcleo marca e a
     * notificação mostra "Silenciado pelo sistema". Abaixo da API 29 não há sinal.
     */
    private fun vigiarSilencio() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || vigiaDoSilencio != null) return
        val vigia = object : AudioManager.AudioRecordingCallback() {
            override fun onRecordingConfigChanged(configs: MutableList<AudioRecordingConfiguration>) {
                val agora = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && configs.any { it.isClientSilenced }
                if (agora == silenciada) return
                silenciada = agora
                val estado = EclumeCore.acao(if (agora) "silenciado" else "audivel")
                SessaoNaNotificacao.doEstado(estado)?.let { sessao ->
                    getSystemService(NotificationManager::class.java)
                        .notify(Notificacao.ID, Notificacao.montar(this@ServicoDeGravacao, sessao, System.currentTimeMillis()))
                }
            }
        }
        getSystemService(AudioManager::class.java)
            .registerAudioRecordingCallback(vigia, Handler(Looper.getMainLooper()))
        vigiaDoSilencio = vigia
    }

    private fun pararDeVigiarSilencio() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        vigiaDoSilencio?.let { getSystemService(AudioManager::class.java).unregisterAudioRecordingCallback(it) }
        vigiaDoSilencio = null
        silenciada = false
    }

    private fun encerrar() {
        pararDeVigiarSilencio()
        trava?.takeIf { it.isHeld }?.release()
        trava = null
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        emPrimeiroPlano = false
        stopSelf()
    }

    override fun onDestroy() {
        // O sistema derrubou o serviço com a gravação em curso: o núcleo fecha o arquivo.
        val estado = EclumeCore.estado()
        if (SessaoNaNotificacao.doEstado(estado) != null) {
            Log.w(TAG, "serviço destruído gravando; parando a gravação")
            EclumeCore.acao("parar")
        }
        pararDeVigiarSilencio()
        trava?.takeIf { it.isHeld }?.release()
        super.onDestroy()
    }
}
