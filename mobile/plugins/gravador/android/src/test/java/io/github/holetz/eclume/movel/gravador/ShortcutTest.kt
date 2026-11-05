package io.github.holetz.eclume.movel.gravador

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AtalhoTest {
    @Test
    fun soOToqueNovoNoAtalhoGrava() {
        assertTrue(Atalho.ehGravarAgora(Atalho.GRAVAR_AGORA, 0))
        // Pelos recentes, o mesmo intent volta com FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY.
        assertFalse(Atalho.ehGravarAgora(Atalho.GRAVAR_AGORA, 0x00100000))
        assertFalse(Atalho.ehGravarAgora("android.intent.action.MAIN", 0))
        assertFalse(Atalho.ehGravarAgora(null, 0))
    }
}
