package com.contour.app.alert

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WarningPushPayloadTest {
    // Synthetic test data, not an official bulletin.
    private val data = mapOf(
        "deliveryKey" to "jma:https://www.data.jma.go.jp/developer/xml/data/20261105010000_0_VPWW53_230000.xml",
        "bulletinType" to "VPWW53",
        "title" to "名古屋市: 大雨警報 / Nagoya: heavy rain warning",
        "body" to "気象庁 10:00 発表 / Source: JMA, 10:00 JST",
        "alertKind" to "alert",
    )

    @Test fun parsesBackendData() {
        val payload = WarningPushPayload.parse(data)!!
        assertEquals("VPWW53", payload.bulletinType)
        assertEquals(AlertKind.OTHER_EMERGENCY, payload.alertKind)
        assertEquals("jma-VPWW53", payload.tag)
    }

    @Test fun advisoriesOpenTheAppWithoutTheAlertScreen() {
        assertNull(WarningPushPayload.parse(data + ("alertKind" to ""))!!.alertKind)
        // Only kinds the backend sends may open the alert screen.
        assertNull(WarningPushPayload.parse(data + ("alertKind" to "eew"))!!.alertKind)
    }

    @Test fun rejectsAnythingThatIsNotAJmaBulletin() {
        assertNull(WarningPushPayload.parse(data + ("deliveryKey" to "jma:https://example.com/x.xml")))
        assertNull(WarningPushPayload.parse(data + ("bulletinType" to "OTHER")))
        assertNull(WarningPushPayload.parse(data + ("title" to " ")))
        assertNull(WarningPushPayload.parse(data - "deliveryKey"))
    }
}
