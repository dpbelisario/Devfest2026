package com.contour.app.alert

import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.Test

class EmergencyAlertClassifierTest {
    @Test fun wireKindsRoundTripAndUnknownKindsAreRejected() {
        AlertKind.entries.forEach { assertEquals(it, AlertKind.fromId(it.id)) }
        assertNull(AlertKind.fromId("unknown"))
        assertNull(AlertKind.fromId(""))
    }
    private val cb = "com.google.android.cellbroadcastreceiver"

    @Test fun earthquakeEarlyWarningOpensTheApp() =
        assertEquals(AlertKind.EARTHQUAKE, EmergencyAlertClassifier.classify(cb, "緊急地震速報", "強い揺れに備えてください（気象庁）"))

    @Test fun englishPhoneEarthquakeWarning() =
        assertEquals(AlertKind.EARTHQUAKE, EmergencyAlertClassifier.classify(cb, "Earthquake Early Warning", "Prepare for strong shaking"))

    @Test fun tsunamiWarning() =
        assertEquals(AlertKind.TSUNAMI, EmergencyAlertClassifier.classify(cb, "津波警報", "海岸から離れてください"))

    @Test fun evacuationOrderFromCarrierAreaMail() =
        assertEquals(AlertKind.EVACUATION, EmergencyAlertClassifier.classify("com.nttdocomo.android.areamail", "緊急速報", "名古屋市 避難指示 発令"))

    @Test fun emergencyWarning() =
        assertEquals(AlertKind.EMERGENCY_WARNING, EmergencyAlertClassifier.classify(cb, "緊急速報", "大雨特別警報が発表されました"))

    @Test fun ordinaryAppNeverOpens() =
        assertNull(EmergencyAlertClassifier.classify("jp.naver.line.android", "緊急地震速報", "冗談です"))

    @Test fun drillIsIgnored() =
        assertNull(EmergencyAlertClassifier.classify(cb, "緊急速報", "【訓練】避難指示 発令"))

    @Test fun shellOnlyInDebug() {
        assertNull(EmergencyAlertClassifier.classify("com.android.shell", "緊急地震速報", "test"))
        assertEquals(AlertKind.EARTHQUAKE, EmergencyAlertClassifier.classify("com.android.shell", "緊急地震速報", "強い揺れ", allowShell = true))
    }

    @Test fun unrelatedAlertTextIsIgnored() =
        assertNull(EmergencyAlertClassifier.classify(cb, "Cell broadcast", "Network information"))
}
