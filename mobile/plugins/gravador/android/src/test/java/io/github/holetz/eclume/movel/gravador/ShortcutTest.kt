package io.github.holetz.eclume.movel.gravador

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ShortcutTest {
    @Test
    fun onlyANewTapOnTheShortcutRecords() {
        assertTrue(Shortcut.isRecordNow(Shortcut.RECORD_NOW, 0))
        // From the recents, the same intent comes back with FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY.
        assertFalse(Shortcut.isRecordNow(Shortcut.RECORD_NOW, 0x00100000))
        assertFalse(Shortcut.isRecordNow("android.intent.action.MAIN", 0))
        assertFalse(Shortcut.isRecordNow(null, 0))
    }
}
