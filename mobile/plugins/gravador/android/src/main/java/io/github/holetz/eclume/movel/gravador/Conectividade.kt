package io.github.holetz.eclume.movel.gravador

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities

/**
 * "Wi-Fi não medido": a rede padrão é Wi-Fi e não é cobrada. É a primeira metade de "na rede do
 * eclume" (a outra é a sonda do `/server`, no núcleo); nos dados móveis, nada sobe.
 */
object Conectividade {
    @Volatile
    var wifiNaoMedido: Boolean = false
        private set

    private var registrada = false

    /** A regra, pura: Wi-Fi e não medida. */
    fun ehWifiNaoMedido(wifi: Boolean, naoMedida: Boolean): Boolean = wifi && naoMedida

    @Synchronized
    fun acompanhar(context: Context) {
        if (registrada) return
        val gerenciador = context.applicationContext.getSystemService(ConnectivityManager::class.java)
        gerenciador.activeNetwork?.let { rede ->
            gerenciador.getNetworkCapabilities(rede)?.let { atualizar(it) }
        }
        gerenciador.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onCapabilitiesChanged(rede: Network, capacidades: NetworkCapabilities) =
                atualizar(capacidades)

            override fun onLost(rede: Network) {
                wifiNaoMedido = false
            }
        })
        registrada = true
    }

    private fun atualizar(capacidades: NetworkCapabilities) {
        wifiNaoMedido = ehWifiNaoMedido(
            capacidades.hasTransport(NetworkCapabilities.TRANSPORT_WIFI),
            capacidades.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED),
        )
    }
}
