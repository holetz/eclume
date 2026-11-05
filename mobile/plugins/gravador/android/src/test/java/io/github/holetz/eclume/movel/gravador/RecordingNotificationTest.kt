package io.github.holetz.eclume.movel.gravador

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RecordingNotificationTest {
    private val recording = NotificationSession(
        audioMs = 42 * 60_000L + 10_000L,
        paused = false,
        markers = 2,
        freeSpace = "cerca de 9 h",
    )

    @Test
    fun audioTimeClock() {
        assertEquals("00:42:10", NotificationTexts.clock(recording.audioMs))
        assertEquals("01:00:00", NotificationTexts.clock(3_600_000L))
        assertEquals("00:00:00", NotificationTexts.clock(-5L))
    }

    @Test
    fun recordingUsesTheChronometerAndPausedShowsTheStoppedTime() {
        assertEquals("Gravando", NotificationTexts.title(recording))
        assertEquals("Pausado · 00:42:10", NotificationTexts.title(recording.copy(paused = true)))
        // The system chronometer counts from now minus the audio time.
        assertEquals(1_000_000L - recording.audioMs, NotificationTexts.chronometerStart(1_000_000L, recording))
    }

    @Test
    fun markersAndFreeSpace() {
        assertEquals("2 marcadores · espaço para cerca de 9 h", NotificationTexts.text(recording))
        assertEquals("1 marcador", NotificationTexts.text(recording.copy(markers = 1, freeSpace = null)))
        assertEquals(
            "Microfone desconectado · reconectando",
            NotificationTexts.text(recording.copy(reconnecting = true)),
        )
        assertEquals("Silenciado pelo sistema", NotificationTexts.text(recording.copy(silenced = true)))
    }

    @Test
    fun coreReplyHasThreeCases() {
        val withSession = CoreReply.read(
            """{"sessao": {"audio_ms": 1000, "pausada": false, "marcadores": [{}], "microfone": "ok"},
                "espaco_livre": "cerca de 9 h"}""",
        )
        assertEquals(
            CoreReply.WithSession(NotificationSession(1000, false, 1, "cerca de 9 h")),
            withSession,
        )
        assertEquals(CoreReply.NoSession, CoreReply.read("""{"sessao": null}"""))
        assertEquals(
            CoreReply.Failure("pânico: núcleo quebrado"),
            CoreReply.read("""{"erro": "pânico: núcleo quebrado"}"""),
        )
        assertTrue(CoreReply.read("not json") is CoreReply.Failure)
        assertTrue(CoreReply.read(null) is CoreReply.Failure)
        assertNull(NotificationSession.fromState("""{"erro": "x"}"""))
    }

    @Test
    fun warningWhenTheRecordingStops() {
        assertEquals("A gravação parou", NotificationTexts.STOPPED)
        assertEquals("pouco espaço livre · 00:12:30 salvos", NotificationTexts.stopped("pouco espaço livre", 750_000L))
        assertEquals("o microfone parou", NotificationTexts.stopped("o microfone parou", null))
    }

    @Test
    fun notificationActionsBecomeCoreActions() {
        assertEquals("pausar", RecordingService.coreAction(RecordingService.PAUSE))
        assertEquals("continuar", RecordingService.coreAction(RecordingService.RESUME))
        assertEquals("marcar", RecordingService.coreAction(RecordingService.MARK))
        assertEquals("parar", RecordingService.coreAction(RecordingService.STOP))
        assertNull(RecordingService.coreAction(RecordingService.UPDATE))
        assertNull(RecordingService.coreAction(null))
    }
}
