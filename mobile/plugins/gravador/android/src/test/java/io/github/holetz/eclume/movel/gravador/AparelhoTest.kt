package io.github.holetz.eclume.movel.gravador

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AparelhoTest {
    @Test
    fun soWifiNaoMedidoContaComoRedeDoEclume() {
        assertTrue(Conectividade.ehWifiNaoMedido(wifi = true, naoMedida = true))
        assertFalse(Conectividade.ehWifiNaoMedido(wifi = true, naoMedida = false))
        assertFalse(Conectividade.ehWifiNaoMedido(wifi = false, naoMedida = true))
    }

    @Test
    fun porcentagemDaBateria() {
        assertEquals(12, Dispositivo.porcentagem(12, 100))
        assertEquals(50, Dispositivo.porcentagem(128, 256))
        assertEquals(100, Dispositivo.porcentagem(-1, 100))
        assertEquals(100, Dispositivo.porcentagem(40, 0))
    }

    @Test
    fun isencaoDaOtimizacaoDeBateria() {
        assertEquals("concedida", Dispositivo.isencao(concedida = true, jaPediu = true))
        assertEquals("pedir", Dispositivo.isencao(concedida = false, jaPediu = false))
        assertEquals("recusada", Dispositivo.isencao(concedida = false, jaPediu = true))
    }

    @Test
    fun txtDoAnuncioViraTexto() {
        val txt = Descoberta.txtEmTexto(
            mapOf(
                "url" to "https://192.168.15.199:8443".toByteArray(),
                "ca" to "3f9a".toByteArray(),
                "vazia" to null,
            ),
        )
        assertEquals("https://192.168.15.199:8443", txt["url"])
        assertEquals("3f9a", txt["ca"])
        assertEquals("", txt["vazia"])
    }

    @Test
    fun autoridadeDoFileProviderDoApp() {
        assertEquals(
            "io.github.holetz.eclume.movel.fileprovider",
            Atualizador.autoridade("io.github.holetz.eclume.movel"),
        )
    }
}
