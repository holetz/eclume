package io.github.holetz.eclume.movel.gravador

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities

/**
 * "Unmetered Wi-Fi": the default network is Wi-Fi and is not charged. It is the first half of "on
 * eclume's network" (the other is the `/server` probe, in the core); on mobile data, nothing is
 * uploaded. Each change goes to the core right away (`EclumeCore.network`): without the unmetered
 * Wi-Fi, the running sync stops at the next request. The app and the `SyncWorker` register the
 * same callback.
 */
object Connectivity {
    @Volatile
    var unmeteredWifi: Boolean = false
        private set

    private var registered = false

    /** The rule, pure: Wi-Fi and unmetered. */
    fun isUnmeteredWifi(wifi: Boolean, unmetered: Boolean): Boolean = wifi && unmetered

    @Synchronized
    fun follow(context: Context) {
        if (registered) return
        val manager = context.applicationContext.getSystemService(ConnectivityManager::class.java)
        manager.activeNetwork?.let { network ->
            manager.getNetworkCapabilities(network)?.let { update(it) }
        }
        manager.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) =
                update(capabilities)

            override fun onLost(network: Network) {
                set(false)
            }
        })
        registered = true
    }

    private fun update(capabilities: NetworkCapabilities) {
        set(
            isUnmeteredWifi(
                capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI),
                capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED),
            ),
        )
    }

    private fun set(unmetered: Boolean) {
        unmeteredWifi = unmetered
        runCatching { EclumeCore.network(unmetered) }
    }
}
