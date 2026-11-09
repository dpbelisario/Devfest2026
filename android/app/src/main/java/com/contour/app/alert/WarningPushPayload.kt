package com.contour.app.alert

/**
 * Data of one JMA warning push from the contour-jobs backend (FCM topic message, see
 * docs/push-notifications.md). Only the fields the app uses are read; anything that does not look
 * like an official JMA bulletin is rejected. Pure logic, so it can be unit-tested.
 */
data class WarningPushPayload(
    val deliveryKey: String,
    val bulletinType: String,
    val title: String,
    val body: String,
    /** Alert screen to open on tap, or null to just open the app (e.g. advisories). */
    val alertKind: AlertKind?,
) {
    /** Same tag as the backend's Android notification tag, so a newer bulletin replaces the older. */
    val tag: String get() = "jma-$bulletinType"

    companion object {
        /** FCM data keys sent by backend/src/services/jobs/warningPush.ts. */
        val KEYS = listOf("deliveryKey", "bulletinType", "sourceUrl", "publishedAt", "source", "alertKind", "title", "body")
        private val TYPES = setOf("VPWW53", "VXSE53", "VTSE41", "VFVO50")
        private val TAP_KINDS = setOf(AlertKind.TSUNAMI, AlertKind.EMERGENCY_WARNING, AlertKind.OTHER_EMERGENCY)

        fun parse(data: Map<String, String?>): WarningPushPayload? {
            val key = data["deliveryKey"] ?: return null
            if (!key.startsWith("jma:https://www.data.jma.go.jp/")) return null
            val type = data["bulletinType"]?.takeIf { it in TYPES } ?: return null
            val title = data["title"].orEmpty().trim().take(200)
            if (title.isEmpty()) return null
            val kind = data["alertKind"]?.let { AlertKind.fromId(it) }?.takeIf { it in TAP_KINDS }
            return WarningPushPayload(key, type, title, data["body"].orEmpty().trim().take(500), kind)
        }
    }
}
