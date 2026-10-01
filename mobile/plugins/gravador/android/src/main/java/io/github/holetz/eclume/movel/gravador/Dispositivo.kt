package io.github.holetz.eclume.movel.gravador

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.os.StatFs
import androidx.core.app.NotificationManagerCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/** O que o núcleo e a UI precisam saber do aparelho. */
data class EstadoDoAparelho(
    val bateria: Int,
    val carregando: Boolean,
    val espacoLivre: Long,
    val wifiNaoMedido: Boolean,
    val modelo: String,
    val insetTopo: Float,
    val insetBase: Float,
    /** As notificações do app estão liberadas. */
    val notificacoes: Boolean,
    /** A isenção da otimização de bateria: `concedida`, `pedir` ou `recusada`. */
    val isencaoDeBateria: String,
)

object Dispositivo {
    private const val PREFERENCIAS = "eclume-gravador"
    private const val ISENCAO_PEDIDA = "isencao_de_bateria_pedida"

    /** `concedida`; `recusada` depois de já ter pedido uma vez; `pedir` antes disso. */
    fun isencao(concedida: Boolean, jaPediu: Boolean): String = when {
        concedida -> "concedida"
        jaPediu -> "recusada"
        else -> "pedir"
    }

    /** Lembra que o app já pediu a isenção (a próxima recusa vira `recusada`). */
    fun marcarIsencaoPedida(context: Context) {
        context.getSharedPreferences(PREFERENCIAS, Context.MODE_PRIVATE).edit().putBoolean(ISENCAO_PEDIDA, true).apply()
    }

    private fun isencaoDeBateria(context: Context): String {
        val concedida = context.getSystemService(PowerManager::class.java)
            .isIgnoringBatteryOptimizations(context.packageName)
        val jaPediu = context.getSharedPreferences(PREFERENCIAS, Context.MODE_PRIVATE).getBoolean(ISENCAO_PEDIDA, false)
        return isencao(concedida, jaPediu)
    }
    /** O nível da bateria em %, do `level`/`scale` do sticky `ACTION_BATTERY_CHANGED`. */
    fun porcentagem(nivel: Int, escala: Int): Int =
        if (nivel < 0 || escala <= 0) 100 else (nivel * 100 / escala).coerceIn(0, 100)

    fun ler(activity: Activity): EstadoDoAparelho {
        val bateria = activity.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val status = bateria?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val insets = ViewCompat.getRootWindowInsets(activity.window.decorView)
            ?.getInsets(WindowInsetsCompat.Type.systemBars())
        val densidade = activity.resources.displayMetrics.density
        return EstadoDoAparelho(
            bateria = porcentagem(
                bateria?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1,
                bateria?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1,
            ),
            carregando = status == BatteryManager.BATTERY_STATUS_CHARGING ||
                status == BatteryManager.BATTERY_STATUS_FULL,
            espacoLivre = espacoLivre(activity),
            wifiNaoMedido = Conectividade.wifiNaoMedido,
            modelo = Build.MODEL ?: "Android",
            insetTopo = (insets?.top ?: 0) / densidade,
            insetBase = (insets?.bottom ?: 0) / densidade,
            notificacoes = NotificationManagerCompat.from(activity).areNotificationsEnabled(),
            isencaoDeBateria = isencaoDeBateria(activity),
        )
    }

    /** Bytes livres onde as gravações ficam. */
    fun espacoLivre(context: Context): Long = StatFs(context.filesDir.path).availableBytes
}
