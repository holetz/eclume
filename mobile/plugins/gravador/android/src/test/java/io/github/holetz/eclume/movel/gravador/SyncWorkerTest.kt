package io.github.holetz.eclume.movel.gravador

import org.junit.Assert.assertEquals
import org.junit.Test

class SyncWorkerTest {
    @Test
    fun uploadedEverythingOrNothingToUploadIsSuccess() {
        assertEquals(
            SyncWorker.Decision.SUCCESS,
            SyncWorker.decide("""{"na_rede": true, "sincronizadas": 2, "falhas": 0, "interrompido": false}"""),
        )
        assertEquals(SyncWorker.Decision.SUCCESS, SyncWorker.decide("""{"na_rede": false}"""))
    }

    @Test
    fun errorInterruptionOrFailureRetry() {
        assertEquals(SyncWorker.Decision.RETRY, SyncWorker.decide("""{"erro": "pânico: x"}"""))
        assertEquals(
            SyncWorker.Decision.RETRY,
            SyncWorker.decide("""{"na_rede": true, "sincronizadas": 1, "falhas": 0, "interrompido": true}"""),
        )
        assertEquals(
            SyncWorker.Decision.RETRY,
            SyncWorker.decide("""{"na_rede": true, "sincronizadas": 0, "falhas": 1, "interrompido": false}"""),
        )
        assertEquals(SyncWorker.Decision.RETRY, SyncWorker.decide("not json"))
        assertEquals(SyncWorker.Decision.RETRY, SyncWorker.decide(null))
    }

    @Test
    fun onlyUploadsInTheForegroundOnTheNetworkWithPending() {
        assertEquals(3, SyncWorker.toUpload("""{"na_rede": true, "pendentes": 3, "bytes": 30}"""))
        assertEquals(0, SyncWorker.toUpload("""{"na_rede": false, "pendentes": 3, "bytes": 30}"""))
        assertEquals(0, SyncWorker.toUpload("""{"erro": "no core"}"""))
    }

    @Test
    fun uploadTextInBothLocales() {
        val pt = XmlStrings.strings(XmlStrings.PT_BR)
        val en = XmlStrings.strings(XmlStrings.EN)
        assertEquals("Enviando 1 gravação", SyncWorker.uploadText(pt, 1))
        assertEquals("Enviando 3 gravações", SyncWorker.uploadText(pt, 3))
        assertEquals("Uploading 1 recording", SyncWorker.uploadText(en, 1))
        assertEquals("Uploading 3 recordings", SyncWorker.uploadText(en, 3))
        assertEquals("On the Wi‑Fi of the eclume server", en.get("sync_on_network"))
    }
}
