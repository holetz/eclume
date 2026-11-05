package io.github.holetz.eclume.movel.gravador

/**
 * The launcher icon's "Gravar agora" shortcut (the app's `res/xml/shortcuts.xml`): opens the
 * MainActivity with the [RECORD_NOW] action. Each tap counts once: the UI consumes it through
 * `consumirAtalho`, and an intent that comes back from the recents
 * (`FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY`) does not count.
 */
object Shortcut {
    /** The intent action; its value is registered in the app's `shortcuts.xml` and is kept. */
    const val RECORD_NOW = "io.github.holetz.eclume.movel.GRAVAR_AGORA"

    /** The `Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY`. */
    private const val FROM_RECENTS = 0x00100000

    /** A new tap on the shortcut: its action, not coming from the recents. */
    fun isRecordNow(action: String?, flags: Int): Boolean =
        action == RECORD_NOW && (flags and FROM_RECENTS) == 0
}
