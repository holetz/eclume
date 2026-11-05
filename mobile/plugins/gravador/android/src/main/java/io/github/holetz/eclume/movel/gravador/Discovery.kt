package io.github.holetz.eclume.movel.gravador

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.util.Log
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/** A found `_eclume._tcp` announcement: the instance name and the raw TXT (the core parses it). */
data class Announcement(val name: String, val txt: Map<String, String>)

/**
 * Server discovery through `NsdManager`: looks for `_eclume._tcp` for a few seconds and resolves
 * each instance to read the TXT (`url`, `ca`, `v`, `name`). The TXT is not authenticated: the
 * core checks the CA and the person checks the fingerprint before sending the password.
 */
class Discovery(context: Context) {
    companion object {
        private const val TAG = "eclume"
        const val TYPE = "_eclume._tcp"

        /** The bytes of each TXT key as text (a key without a value is empty). */
        fun txtAsText(attributes: Map<String, ByteArray?>): Map<String, String> =
            attributes.mapValues { (_, value) -> value?.toString(Charsets.UTF_8) ?: "" }
    }

    private val nsd = context.getSystemService(NsdManager::class.java)
    private val executor = Executors.newSingleThreadExecutor()

    /** Searches for [seconds] and returns the resolved announcements (blocks; call off the UI). */
    fun search(seconds: Int): List<Announcement> {
        val found = ConcurrentHashMap<String, Announcement>()
        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(type: String) {}
            override fun onDiscoveryStopped(type: String) {}
            override fun onStartDiscoveryFailed(type: String, error: Int) {
                Log.w(TAG, "mDNS did not start: $error")
            }
            override fun onStopDiscoveryFailed(type: String, error: Int) {}
            override fun onServiceLost(info: NsdServiceInfo) {}
            override fun onServiceFound(info: NsdServiceInfo) {
                resolve(info) { resolved ->
                    found[resolved.serviceName] =
                        Announcement(resolved.serviceName, txtAsText(resolved.attributes))
                }
            }
        }
        nsd.discoverServices(TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
        try {
            Thread.sleep(seconds.coerceIn(1, 30) * 1000L)
        } finally {
            runCatching { nsd.stopServiceDiscovery(listener) }
            // Each search creates a Discovery: the executor's thread exits with it.
            executor.shutdown()
        }
        return found.values.toList()
    }

    private fun resolve(info: NsdServiceInfo, onResolved: (NsdServiceInfo) -> Unit) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            val callback = object : NsdManager.ServiceInfoCallback {
                override fun onServiceInfoCallbackRegistrationFailed(error: Int) {}
                override fun onServiceUpdated(updated: NsdServiceInfo) {
                    onResolved(updated)
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
                    override fun onResolveFailed(info: NsdServiceInfo, error: Int) {
                        Log.w(TAG, "mDNS did not resolve ${info.serviceName}: $error")
                    }
                    override fun onServiceResolved(resolved: NsdServiceInfo) = onResolved(resolved)
                },
            )
        }
    }
}
