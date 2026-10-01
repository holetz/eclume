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
 * O serviço em primeiro plano do tipo microfone: mantém o processo e o microfone vivos com a tela
 * bloqueada e desenha a notificação contínua. A gravação em si é do núcleo Rust, no mesmo
 * processo; as ações da notificação chegam aqui e vão ao núcleo pela ponte JNI.
 *
 * A resposta do núcleo é lida como sessão, sem sessão ou erro ([RespostaDoNucleo]): erro mantém o
 * primeiro plano e a última notificação (a gravação pode seguir viva), só "sem sessão" encerra, e
 * Parar sempre encerra. O `iniciarServico` do plugin só é respondido depois do `startForeground`
 * (ou rejeitado com o motivo da recusa, ou por prazo).
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
        private const val EXTRA_MOTIVO = "motivo"
        private const val EXTRA_DURACAO = "duracaoMs"
        /** Quanto o `iniciarServico` espera o primeiro plano antes de recusar. */
        private const val PRAZO_DO_PRIMEIRO_PLANO_MS = 5_000L

        /** O `iniciarServico` que espera o primeiro plano. */
        @Volatile
        private var aguardando: Invoke? = null

        /** O serviço existe neste processo (a vigia distingue o processo que morreu gravando). */
        @Volatile
        var vivo = false
            private set

        /**
         * Sobe o serviço (com a Activity visível, como o Android 14 exige para o microfone) e guarda o
         * `invoke`, respondido pelo serviço depois do `startForeground`.
         */
        fun iniciar(context: Context, invoke: Invoke) {
            responderInicio("outro início substituiu este")
            aguardando = invoke
            try {
                ContextCompat.startForegroundService(context, Intent(context, ServicoDeGravacao::class.java).setAction(INICIAR))
            } catch (erro: RuntimeException) {
                // ForegroundServiceStartNotAllowedException (API 31+) e SecurityException.
                Log.w(TAG, "serviço de gravação recusado", erro)
                responderInicio(erro.message ?: erro.javaClass.simpleName)
                return
            }
            Handler(Looper.getMainLooper()).postDelayed({
                if (aguardando === invoke) responderInicio("o serviço não entrou em primeiro plano em 5 s")
            }, PRAZO_DO_PRIMEIRO_PLANO_MS)
        }

        /** Resolve (`erro` nulo) ou rejeita o `iniciarServico` que espera, se houver. */
        private fun responderInicio(erro: String?) {
            val invoke = aguardando ?: return
            aguardando = null
            if (erro == null) invoke.resolve() else invoke.reject(erro)
        }

        fun atualizar(context: Context) {
            context.startService(Intent(context, ServicoDeGravacao::class.java).setAction(ATUALIZAR))
        }

        /**
         * A gravação já foi parada pelo núcleo: tira a notificação e encerra. Com `motivo` (parada sem
         * pedido), avisa "A gravação parou" antes de sair.
         */
        fun encerrar(context: Context, motivo: String? = null, duracaoMs: Long? = null) {
            val intent = Intent(context, ServicoDeGravacao::class.java).setAction(ENCERRAR)
            motivo?.let { intent.putExtra(EXTRA_MOTIVO, it) }
            duracaoMs?.let { intent.putExtra(EXTRA_DURACAO, it) }
            context.startService(intent)
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
        vivo = true
        Notificacao.criarCanal(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val acao = intent?.action
        if (acao == ENCERRAR) {
            intent.getStringExtra(EXTRA_MOTIVO)?.let { motivo ->
                val duracao = if (intent.hasExtra(EXTRA_DURACAO)) intent.getLongExtra(EXTRA_DURACAO, 0) else null
                Notificacao.avisar(this, TextosDaNotificacao.PAROU, TextosDaNotificacao.parou(motivo, duracao))
            }
            encerrar()
            return START_NOT_STICKY
        }
        val nucleo = acaoDoNucleo(acao)
        val resposta = RespostaDoNucleo.ler(if (nucleo != null) EclumeCore.acao(nucleo) else EclumeCore.estado())
        when (resposta) {
            is RespostaDoNucleo.ComSessao -> mostrar(resposta.sessao)
            RespostaDoNucleo.SemSessao -> {
                if (acao == INICIAR) {
                    // O Android exige o startForeground mesmo quando não há o que mostrar.
                    Log.w(TAG, "serviço iniciado sem gravação em curso")
                    responderInicio("nenhuma gravação em curso")
                    entrarEmPrimeiroPlano(SessaoNaNotificacao.NEUTRA)
                }
                encerrar()
            }
            is RespostaDoNucleo.Erro -> {
                Log.w(TAG, "erro do núcleo na ação $acao: ${resposta.mensagem}")
                if (acao == PARAR) {
                    // Parar sempre encerra, para não sobrar notificação presa a um núcleo com erro.
                    Notificacao.avisar(this, TextosDaNotificacao.PAROU_COM_ERRO, resposta.mensagem)
                    encerrar()
                } else if (!emPrimeiroPlano) {
                    entrarEmPrimeiroPlano(SessaoNaNotificacao.NEUTRA)
                }
            }
        }
        return START_NOT_STICKY
    }

    private fun mostrar(sessao: SessaoNaNotificacao) {
        if (!emPrimeiroPlano) {
            entrarEmPrimeiroPlano(sessao)
        } else {
            getSystemService(NotificationManager::class.java)
                .notify(Notificacao.ID, Notificacao.montar(this, sessao, System.currentTimeMillis()))
        }
    }

    /** Entra em primeiro plano e responde ao `iniciarServico`; devolve se entrou. */
    private fun entrarEmPrimeiroPlano(sessao: SessaoNaNotificacao): Boolean {
        val notificacao = Notificacao.montar(this, sessao, System.currentTimeMillis())
        val tipo = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        } else {
            0
        }
        try {
            ServiceCompat.startForeground(this, Notificacao.ID, notificacao, tipo)
        } catch (erro: RuntimeException) {
            // ForegroundServiceStartNotAllowedException (API 31+) e SecurityException (sem a
            // permissão do microfone, ou fora da janela em que o Android aceita o tipo microfone).
            Log.w(TAG, "startForeground recusado", erro)
            responderInicio(erro.message ?: erro.javaClass.simpleName)
            stopSelf()
            return false
        }
        emPrimeiroPlano = true
        responderInicio(null)
        if (trava == null) {
            trava = getSystemService(PowerManager::class.java)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "eclume:gravacao")
                .apply { acquire() }
        }
        VigiaDaGravacao.armar(this)
        vigiarSilencio()
        return true
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
                val resposta = RespostaDoNucleo.ler(EclumeCore.acao(if (agora) "silenciado" else "audivel"))
                if (resposta is RespostaDoNucleo.ComSessao) mostrar(resposta.sessao)
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
        VigiaDaGravacao.desarmar(this)
        trava?.takeIf { it.isHeld }?.release()
        trava = null
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        emPrimeiroPlano = false
        stopSelf()
    }

    override fun onDestroy() {
        // O sistema derrubou o serviço com a gravação em curso: o núcleo fecha o arquivo e avisa.
        val sessao = SessaoNaNotificacao.doEstado(EclumeCore.estado())
        if (sessao != null) {
            Log.w(TAG, "serviço destruído gravando; parando a gravação")
            EclumeCore.acao("parar")
            Notificacao.avisar(
                this,
                TextosDaNotificacao.PAROU,
                TextosDaNotificacao.parou("o sistema encerrou o serviço", sessao.audioMs),
            )
        }
        pararDeVigiarSilencio()
        VigiaDaGravacao.desarmar(this)
        trava?.takeIf { it.isHeld }?.release()
        vivo = false
        super.onDestroy()
    }
}
