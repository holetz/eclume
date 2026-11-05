package io.github.holetz.eclume.movel.gravador

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RecordingNotificationTest {
    private val pt = XmlStrings.strings(XmlStrings.PT_BR)
    private val en = XmlStrings.strings(XmlStrings.EN)

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
        assertEquals("Gravando", NotificationTexts.title(pt, recording))
        assertEquals("Pausado · 00:42:10", NotificationTexts.title(pt, recording.copy(paused = true)))
        assertEquals("Recording", NotificationTexts.title(en, recording))
        assertEquals("Paused · 00:42:10", NotificationTexts.title(en, recording.copy(paused = true)))
        // The system chronometer counts from now minus the audio time.
        assertEquals(1_000_000L - recording.audioMs, NotificationTexts.chronometerStart(1_000_000L, recording))
    }

    @Test
    fun markersAndFreeSpace() {
        assertEquals("2 marcadores · espaço para cerca de 9 h", NotificationTexts.text(pt, recording))
        assertEquals("1 marcador", NotificationTexts.text(pt, recording.copy(markers = 1, freeSpace = null)))
        assertEquals("0 marcadores", NotificationTexts.text(pt, recording.copy(markers = 0, freeSpace = null)))
        assertEquals(
            "Microfone desconectado · reconectando",
            NotificationTexts.text(pt, recording.copy(reconnecting = true)),
        )
        assertEquals("Silenciado pelo sistema", NotificationTexts.text(pt, recording.copy(silenced = true)))
    }

    @Test
    fun markersAndFreeSpaceInEnglish() {
        // The free space is the core's estimate, already in the core's locale.
        assertEquals("2 markers · room for about 9 h", NotificationTexts.text(en, recording.copy(freeSpace = "about 9 h")))
        assertEquals("1 marker", NotificationTexts.text(en, recording.copy(markers = 1, freeSpace = null)))
        assertEquals("Microphone disconnected · reconnecting", NotificationTexts.text(en, recording.copy(reconnecting = true)))
        assertEquals("Silenced by the system", NotificationTexts.text(en, recording.copy(silenced = true)))
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
        assertEquals("A gravação parou", NotificationTexts.stoppedTitle(pt))
        assertEquals("A gravação parou com erro", NotificationTexts.stoppedWithErrorTitle(pt))
        assertEquals("A gravação foi interrompida", NotificationTexts.interruptedTitle(pt))
        assertEquals("pouco espaço livre · 00:12:30 salvos", NotificationTexts.stopped(pt, "pouco espaço livre", 750_000L))
        assertEquals("o microfone parou", NotificationTexts.stopped(pt, "o microfone parou", null))
        assertEquals("The recording stopped", NotificationTexts.stoppedTitle(en))
        assertEquals("The recording stopped with an error", NotificationTexts.stoppedWithErrorTitle(en))
        assertEquals("The recording was interrupted", NotificationTexts.interruptedTitle(en))
        assertEquals("low free space · 00:12:30 saved", NotificationTexts.stopped(en, "low free space", 750_000L))
        assertEquals("the system ended the service · 00:00:05 saved", NotificationTexts.stopped(en, en.get("warning_system_ended"), 5_000L))
    }

    @Test
    fun actionsAndChannelsInBothLocales() {
        assertEquals(listOf("Pause", "Resume", "Marker", "Stop"), listOf("action_pause", "action_resume", "action_marker", "action_stop").map(en::get))
        assertEquals(listOf("Pausar", "Continuar", "Marcador", "Parar"), listOf("action_pause", "action_resume", "action_marker", "action_stop").map(pt::get))
        assertEquals("Recording warnings", en.get("channel_warnings"))
        assertEquals("Avisos da gravação", pt.get("channel_warnings"))
        assertEquals("Tap to open", en.get("warning_tap_to_open"))
        assertEquals("Toque para abrir", pt.get("warning_tap_to_open"))
    }

    @Test
    fun bothLocalesHaveTheSameKeysAndPlaceholders() {
        val english = XmlStrings.read(XmlStrings.EN)
        val portuguese = XmlStrings.read(XmlStrings.PT_BR)
        assertEquals(english.keys, portuguese.keys)
        // Every name the code reads exists, and nothing in the XML goes unread.
        assertEquals(english.keys, Localized.IDS.keys)
        val placeholder = Regex("%\\d\\$[sd]")
        for ((name, text) in english) {
            assertEquals(name, placeholder.findAll(text).map { it.value }.toSet(), placeholder.findAll(portuguese.getValue(name)).map { it.value }.toSet())
        }
    }

    @Test
    fun theLocaleComesFromTheCoreReply() {
        assertEquals("pt-BR", Localized.localeOf("""{"sessao": null, "locale": "pt-BR"}"""))
        assertEquals("en", Localized.localeOf("""{"na_rede": true, "pendentes": 1, "locale": "en"}"""))
        assertNull(Localized.localeOf("""{"erro": "x"}"""))
        assertNull(Localized.localeOf("not json"))
        assertNull(Localized.localeOf(null))
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
