package io.github.holetz.eclume.movel.gravador

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.util.Log
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/** Um anúncio `_eclume._tcp` achado: o nome da instância e o TXT cru (o núcleo o interpreta). */
data class Anuncio(val nome: String, val txt: Map<String, String>)

/**
 * A descoberta do servidor pelo `NsdManager`: procura `_eclume._tcp` por alguns segundos e resolve
 * cada instância para ler o TXT (`url`, `ca`, `v`, `name`). O TXT não é autenticado: o núcleo
 * confere a CA e a pessoa confere a impressão digital antes de mandar a senha.
 */
class Descoberta(context: Context) {
    companion object {
        private const val TAG = "eclume"
        const val TIPO = "_eclume._tcp"

        /** Os bytes de cada chave do TXT em texto (chave sem valor fica vazia). */
        fun txtEmTexto(atributos: Map<String, ByteArray?>): Map<String, String> =
            atributos.mapValues { (_, valor) -> valor?.toString(Charsets.UTF_8) ?: "" }
    }

    private val nsd = context.getSystemService(NsdManager::class.java)
    private val executor = Executors.newSingleThreadExecutor()

    /** Procura por [segundos] e devolve os anúncios resolvidos (bloqueia; chame fora da UI). */
    fun procurar(segundos: Int): List<Anuncio> {
        val achados = ConcurrentHashMap<String, Anuncio>()
        val ouvinte = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(tipo: String) {}
            override fun onDiscoveryStopped(tipo: String) {}
            override fun onStartDiscoveryFailed(tipo: String, erro: Int) {
                Log.w(TAG, "mDNS não começou: $erro")
            }
            override fun onStopDiscoveryFailed(tipo: String, erro: Int) {}
            override fun onServiceLost(info: NsdServiceInfo) {}
            override fun onServiceFound(info: NsdServiceInfo) {
                resolver(info) { resolvido ->
                    achados[resolvido.serviceName] =
                        Anuncio(resolvido.serviceName, txtEmTexto(resolvido.attributes))
                }
            }
        }
        nsd.discoverServices(TIPO, NsdManager.PROTOCOL_DNS_SD, ouvinte)
        try {
            Thread.sleep(segundos.coerceIn(1, 30) * 1000L)
        } finally {
            runCatching { nsd.stopServiceDiscovery(ouvinte) }
            // Cada procura cria uma Descoberta: a thread do executor sai com ela.
            executor.shutdown()
        }
        return achados.values.toList()
    }

    private fun resolver(info: NsdServiceInfo, aoResolver: (NsdServiceInfo) -> Unit) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            val callback = object : NsdManager.ServiceInfoCallback {
                override fun onServiceInfoCallbackRegistrationFailed(erro: Int) {}
                override fun onServiceUpdated(atualizado: NsdServiceInfo) {
                    aoResolver(atualizado)
                    runCatching { nsd.unregisterServiceInfoCallback(this) }
                }
                override fun onServiceLost() {}
                override fun onServiceInfoCallbackUnregistered() {}
            }
            nsd.registerServiceInfoCallback(info, executor, callback)
        } else {
            @Suppress("DEPRECATION")
            nsd.resolveService(
                info,
                object : NsdManager.ResolveListener {
                    override fun onResolveFailed(info: NsdServiceInfo, erro: Int) {
                        Log.w(TAG, "mDNS não resolveu ${info.serviceName}: $erro")
                    }
                    override fun onServiceResolved(resolvido: NsdServiceInfo) = aoResolver(resolvido)
                },
            )
        }
    }
}
