package io.github.holetz.eclume.movel.gravador

import android.content.Context
import android.content.res.Configuration
import org.json.JSONObject
import java.util.Locale

/**
 * The recorder's texts by resource name (`res/values/strings.xml`, English, and
 * `values-pt-rBR`). On the device they come from the resources of a context set to the core's
 * resolved locale; in the JVM tests, from the parsed XML files (`XmlStrings`).
 */
fun interface Strings {
    fun get(name: String): String

    /** The resource's positional template (`%1$s`, `%1$d`) filled with `args`. */
    fun format(name: String, vararg args: Any): String = String.format(Locale.ROOT, get(name), *args)

    /** Android has no plural rule here: 1 takes `<name>_one`, any other count `<name>_other`. */
    fun count(name: String, count: Int): String =
        format(if (count == 1) "${name}_one" else "${name}_other", count)
}

/** The locale the core resolved (account, then device, then `en`) and the strings it selects. */
object Localized {
    /** Every resource name the code reads, with its id (the tests check it against the XML). */
    val IDS: Map<String, Int> = mapOf(
        "notification_recording" to R.string.notification_recording,
        "notification_paused" to R.string.notification_paused,
        "notification_silenced" to R.string.notification_silenced,
        "notification_reconnecting" to R.string.notification_reconnecting,
        "notification_markers_one" to R.string.notification_markers_one,
        "notification_markers_other" to R.string.notification_markers_other,
        "notification_free_space" to R.string.notification_free_space,
        "action_resume" to R.string.action_resume,
        "action_pause" to R.string.action_pause,
        "action_marker" to R.string.action_marker,
        "action_stop" to R.string.action_stop,
        "warning_stopped" to R.string.warning_stopped,
        "warning_stopped_with_error" to R.string.warning_stopped_with_error,
        "warning_interrupted" to R.string.warning_interrupted,
        "warning_saved" to R.string.warning_saved,
        "warning_system_ended" to R.string.warning_system_ended,
        "warning_tap_to_open" to R.string.warning_tap_to_open,
        "channel_recording" to R.string.channel_recording,
        "channel_recording_description" to R.string.channel_recording_description,
        "channel_warnings" to R.string.channel_warnings,
        "channel_warnings_description" to R.string.channel_warnings_description,
        "channel_sync" to R.string.channel_sync,
        "channel_sync_description" to R.string.channel_sync_description,
        "sync_uploading_one" to R.string.sync_uploading_one,
        "sync_uploading_other" to R.string.sync_uploading_other,
        "sync_on_network" to R.string.sync_on_network,
    )

    /**
     * The `locale` tag of a core reply (the `AppState` or the worker probe); `null` when the
     * reply has none or is not JSON. The key is the core's serialization.
     */
    fun localeOf(json: String?): String? {
        val state = json?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return null
        return state.optString("locale").takeIf { it.isNotEmpty() && it != "null" }
    }

    /** The strings of `context` in the `tag` locale; with no tag, the device's own locale. */
    fun strings(context: Context, tag: String?): Strings {
        val resources = if (tag == null) {
            context.resources
        } else {
            val configuration = Configuration(context.resources.configuration)
            configuration.setLocale(Locale.forLanguageTag(tag))
            context.createConfigurationContext(configuration).resources
        }
        return Strings { name ->
            val id = IDS[name] ?: error("unknown string resource: $name")
            resources.getString(id)
        }
    }
}
