package io.github.holetz.eclume.movel.gravador

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceTest {
    @Test
    fun onlyUnmeteredWifiCountsAsEclumesNetwork() {
        assertTrue(Connectivity.isUnmeteredWifi(wifi = true, unmetered = true))
        assertFalse(Connectivity.isUnmeteredWifi(wifi = true, unmetered = false))
        assertFalse(Connectivity.isUnmeteredWifi(wifi = false, unmetered = true))
    }

    @Test
    fun batteryPercentage() {
        assertEquals(12, Device.percentage(12, 100))
        assertEquals(50, Device.percentage(128, 256))
        assertEquals(100, Device.percentage(-1, 100))
        assertEquals(100, Device.percentage(40, 0))
    }

    @Test
    fun batteryOptimizationExemption() {
        assertEquals("concedida", Device.exemption(granted = true, alreadyAsked = true))
        assertEquals("pedir", Device.exemption(granted = false, alreadyAsked = false))
        assertEquals("recusada", Device.exemption(granted = false, alreadyAsked = true))
    }

    @Test
    fun announcementTxtBecomesText() {
        val txt = Discovery.txtAsText(
            mapOf(
                "url" to "https://192.0.2.10:8443".toByteArray(),
                "ca" to "3f9a".toByteArray(),
                "empty" to null,
            ),
        )
        assertEquals("https://192.0.2.10:8443", txt["url"])
        assertEquals("3f9a", txt["ca"])
        assertEquals("", txt["empty"])
    }

    @Test
    fun appFileProviderAuthority() {
        assertEquals(
            "io.github.holetz.eclume.movel.fileprovider",
            Updater.authority("io.github.holetz.eclume.movel"),
        )
    }
}
