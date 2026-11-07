package com.contour.app.alert

/** Kinds of official emergency alerts that make Contour open by itself. */
enum class AlertKind(val id: String) {
    EARTHQUAKE("eew"),
    TSUNAMI("tsunami"),
    EMERGENCY_WARNING("special"),
    EVACUATION("evac"),
    OTHER_EMERGENCY("alert");

    companion object {
        /** Reject unknown wire values instead of interpreting them as an earthquake. */
        fun fromId(id: String): AlertKind? = entries.firstOrNull { it.id == id }
    }
}

/**
 * Decides whether a posted notification is an official emergency alert (Japan's 緊急速報メール /
 * ETWS cell broadcast, shown by the phone's emergency-alert app) that is urgent enough to open
 * Contour. Pure logic, so it can be unit-tested.
 *
 * Only notifications from the phone's emergency-alert app count, so ordinary notifications (chat,
 * news, a dropped phone) never open the app. Drills and tests are ignored.
 */
object EmergencyAlertClassifier {

    /** Emergency-alert apps: Android's cell broadcast receiver and carrier "area mail" apps. */
    private val ALERT_PACKAGE_HINTS = listOf("cellbroadcast", "areamail", "emergencyalert", "etws")

    /** Debug builds also accept `adb shell cmd notification post …`, which posts as com.android.shell. */
    private const val SHELL_PACKAGE = "com.android.shell"

    private val DRILL_WORDS = listOf("訓練", "テスト", "test message", "drill", "exercise")

    private val RULES: List<Pair<AlertKind, List<String>>> = listOf(
        AlertKind.EARTHQUAKE to listOf("緊急地震速報", "earthquake early warning", "earthquake warning", "地震速報"),
        AlertKind.TSUNAMI to listOf("大津波警報", "津波警報", "津波", "tsunami"),
        AlertKind.EMERGENCY_WARNING to listOf("特別警報", "emergency warning"),
        AlertKind.EVACUATION to listOf("緊急安全確保", "避難指示", "避難勧告", "高齢者等避難", "evacuation"),
        AlertKind.OTHER_EMERGENCY to listOf("緊急速報", "extreme alert", "severe alert", "emergency alert", "presidential alert", "national alert"),
    )

    fun isAlertPackage(packageName: String, allowShell: Boolean): Boolean {
        val p = packageName.lowercase()
        return ALERT_PACKAGE_HINTS.any { p.contains(it) } || (allowShell && p == SHELL_PACKAGE)
    }

    /**
     * @return the alert kind, or null when this notification must not open the app.
     * [allowShell] is true only in debug builds (testing with adb).
     */
    fun classify(packageName: String, title: String?, text: String?, allowShell: Boolean = false): AlertKind? {
        if (!isAlertPackage(packageName, allowShell)) return null
        val all = listOfNotNull(title, text).joinToString("\n").lowercase()
        if (all.isBlank()) return null
        if (DRILL_WORDS.any { all.contains(it) }) return null
        return RULES.firstOrNull { (_, words) -> words.any { all.contains(it) } }?.first
    }
}
