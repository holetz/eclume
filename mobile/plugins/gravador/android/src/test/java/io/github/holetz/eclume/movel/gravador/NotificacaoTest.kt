package io.github.holetz.eclume.movel.gravador

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NotificacaoTest {
    private val gravando = SessaoNaNotificacao(
        audioMs = 42 * 60_000L + 10_000L,
        pausada = false,
        marcadores = 2,
        espacoLivre = "cerca de 9 h",
    )

    @Test
    fun relogioDoTempoDeAudio() {
        assertEquals("00:42:10", TextosDaNotificacao.relogio(gravando.audioMs))
        assertEquals("01:00:00", TextosDaNotificacao.relogio(3_600_000L))
        assertEquals("00:00:00", TextosDaNotificacao.relogio(-5L))
    }

    @Test
    fun gravandoUsaOCronometroEPausadoMostraOTempoParado() {
        assertEquals("Gravando", TextosDaNotificacao.titulo(gravando))
        assertEquals("Pausado · 00:42:10", TextosDaNotificacao.titulo(gravando.copy(pausada = true)))
        // O cronômetro do sistema conta a partir de agora menos o tempo de áudio.
        assertEquals(1_000_000L - gravando.audioMs, TextosDaNotificacao.inicioDoCronometro(1_000_000L, gravando))
    }

    @Test
    fun marcadoresEEspacoLivre() {
        assertEquals("2 marcadores · espaço para cerca de 9 h", TextosDaNotificacao.texto(gravando))
        assertEquals("1 marcador", TextosDaNotificacao.texto(gravando.copy(marcadores = 1, espacoLivre = null)))
        assertEquals(
            "Microfone desconectado · reconectando",
            TextosDaNotificacao.texto(gravando.copy(reconectando = true)),
        )
        assertEquals("Silenciado pelo sistema", TextosDaNotificacao.texto(gravando.copy(silenciada = true)))
    }

    @Test
    fun respostaDoNucleoTemTresCasos() {
        val comSessao = RespostaDoNucleo.ler(
            """{"sessao": {"audio_ms": 1000, "pausada": false, "marcadores": [{}], "microfone": "ok"},
                "espaco_livre": "cerca de 9 h"}""",
        )
        assertEquals(
            RespostaDoNucleo.ComSessao(SessaoNaNotificacao(1000, false, 1, "cerca de 9 h")),
            comSessao,
        )
        assertEquals(RespostaDoNucleo.SemSessao, RespostaDoNucleo.ler("""{"sessao": null}"""))
        assertEquals(
            RespostaDoNucleo.Erro("pânico: núcleo quebrado"),
            RespostaDoNucleo.ler("""{"erro": "pânico: núcleo quebrado"}"""),
        )
        assertTrue(RespostaDoNucleo.ler("não é json") is RespostaDoNucleo.Erro)
        assertTrue(RespostaDoNucleo.ler(null) is RespostaDoNucleo.Erro)
        assertNull(SessaoNaNotificacao.doEstado("""{"erro": "x"}"""))
    }

    @Test
    fun avisoDeQuandoAGravacaoPara() {
        assertEquals("A gravação parou", TextosDaNotificacao.PAROU)
        assertEquals("pouco espaço livre · 00:12:30 salvos", TextosDaNotificacao.parou("pouco espaço livre", 750_000L))
        assertEquals("o microfone parou", TextosDaNotificacao.parou("o microfone parou", null))
    }

    @Test
    fun acoesDaNotificacaoViramAcoesDoNucleo() {
        assertEquals("pausar", ServicoDeGravacao.acaoDoNucleo(ServicoDeGravacao.PAUSAR))
        assertEquals("continuar", ServicoDeGravacao.acaoDoNucleo(ServicoDeGravacao.CONTINUAR))
        assertEquals("marcar", ServicoDeGravacao.acaoDoNucleo(ServicoDeGravacao.MARCAR))
        assertEquals("parar", ServicoDeGravacao.acaoDoNucleo(ServicoDeGravacao.PARAR))
        assertNull(ServicoDeGravacao.acaoDoNucleo(ServicoDeGravacao.ATUALIZAR))
        assertNull(ServicoDeGravacao.acaoDoNucleo(null))
    }
}
