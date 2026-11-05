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

/** What the core and the UI need to know about the device. */
data class DeviceState(
    val battery: Int,
    val charging: Boolean,
    val freeSpace: Long,
    val unmeteredWifi: Boolean,
    val model: String,
    val insetTop: Float,
    val insetBottom: Float,
    /** The app's notifications are allowed. */
    val notifications: Boolean,
    /** The battery-optimization exemption: `concedida`, `pedir` or `recusada`. */
    val batteryExemption: String,
)

object Device {
    // The SharedPreferences file and key are persisted on the device and keep their names.
    private const val PREFERENCES = "eclume-gravador"
    private const val EXEMPTION_ASKED = "isencao_de_bateria_pedida"

    /** `concedida`; `recusada` after having asked once; `pedir` before that. */
    fun exemption(granted: Boolean, alreadyAsked: Boolean): String = when {
        granted -> "concedida"
        alreadyAsked -> "recusada"
        else -> "pedir"
    }

    /** Remembers that the app already asked for the exemption (the next refusal is `recusada`). */
    fun markExemptionAsked(context: Context) {
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit().putBoolean(EXEMPTION_ASKED, true).apply()
    }

    private fun batteryExemption(context: Context): String {
        val granted = context.getSystemService(PowerManager::class.java)
            .isIgnoringBatteryOptimizations(context.packageName)
        val alreadyAsked = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).getBoolean(EXEMPTION_ASKED, false)
        return exemption(granted, alreadyAsked)
    }
    /** The battery level in %, from the `level`/`scale` of the sticky `ACTION_BATTERY_CHANGED`. */
    fun percentage(level: Int, scale: Int): Int =
        if (level < 0 || scale <= 0) 100 else (level * 100 / scale).coerceIn(0, 100)

    fun read(activity: Activity): DeviceState {
        val battery = activity.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val status = battery?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val insets = ViewCompat.getRootWindowInsets(activity.window.decorView)
            ?.getInsets(WindowInsetsCompat.Type.systemBars())
        val density = activity.resources.displayMetrics.density
        return DeviceState(
            battery = percentage(
                battery?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1,
                battery?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1,
            ),
            charging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
                status == BatteryManager.BATTERY_STATUS_FULL,
            freeSpace = freeSpace(activity),
            unmeteredWifi = Connectivity.unmeteredWifi,
            model = Build.MODEL ?: "Android",
            insetTop = (insets?.top ?: 0) / density,
            insetBottom = (insets?.bottom ?: 0) / density,
            notifications = NotificationManagerCompat.from(activity).areNotificationsEnabled(),
            batteryExemption = batteryExemption(activity),
        )
    }

    /** Free bytes where the recordings live. */
    fun freeSpace(context: Context): Long = StatFs(context.filesDir.path).availableBytes
}
