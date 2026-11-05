package io.github.holetz.eclume.movel.gravador

import org.junit.Assert.assertEquals
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

    @Test
    fun theShortcutLabelsAreEnglishWithAPortugueseTranslation() {
        val en = XmlStrings.read(XmlStrings.EN, XmlStrings.APP_RES)
        val pt = XmlStrings.read(XmlStrings.PT_BR, XmlStrings.APP_RES)
        assertEquals("Record", en["shortcut_record_short"])
        assertEquals("Record now", en["shortcut_record_long"])
        assertEquals("Gravar", pt["shortcut_record_short"])
        assertEquals("Gravar agora", pt["shortcut_record_long"])
        // The brand is not translated: pt-BR only carries the labels.
        assertEquals(setOf("shortcut_record_short", "shortcut_record_long"), pt.keys)
    }
}
