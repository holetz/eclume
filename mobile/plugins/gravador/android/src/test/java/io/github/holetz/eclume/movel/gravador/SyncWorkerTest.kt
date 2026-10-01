package io.github.holetz.eclume.movel.gravador

import org.junit.Assert.assertEquals
import org.junit.Test

class SyncWorkerTest {
    @Test
    fun subiuTudoOuNadaASubirESucesso() {
        assertEquals(
            SyncWorker.Decisao.SUCESSO,
            SyncWorker.decidir("""{"na_rede": true, "sincronizadas": 2, "falhas": 0, "interrompido": false}"""),
        )
        assertEquals(SyncWorker.Decisao.SUCESSO, SyncWorker.decidir("""{"na_rede": false}"""))
    }

    @Test
    fun erroInterrupcaoOuFalhaRepetem() {
        assertEquals(SyncWorker.Decisao.REPETIR, SyncWorker.decidir("""{"erro": "pânico: x"}"""))
        assertEquals(
            SyncWorker.Decisao.REPETIR,
            SyncWorker.decidir("""{"na_rede": true, "sincronizadas": 1, "falhas": 0, "interrompido": true}"""),
        )
        assertEquals(
            SyncWorker.Decisao.REPETIR,
            SyncWorker.decidir("""{"na_rede": true, "sincronizadas": 0, "falhas": 1, "interrompido": false}"""),
        )
        assertEquals(SyncWorker.Decisao.REPETIR, SyncWorker.decidir("não é json"))
        assertEquals(SyncWorker.Decisao.REPETIR, SyncWorker.decidir(null))
    }

    @Test
    fun soSobeEmPrimeiroPlanoNaRedeComPendentes() {
        assertEquals(3, SyncWorker.aSubir("""{"na_rede": true, "pendentes": 3, "bytes": 30}"""))
        assertEquals(0, SyncWorker.aSubir("""{"na_rede": false, "pendentes": 3, "bytes": 30}"""))
        assertEquals(0, SyncWorker.aSubir("""{"erro": "sem núcleo"}"""))
        assertEquals("Enviando 1 gravação", SyncWorker.textoDoEnvio(1))
        assertEquals("Enviando 3 gravações", SyncWorker.textoDoEnvio(3))
    }
}
