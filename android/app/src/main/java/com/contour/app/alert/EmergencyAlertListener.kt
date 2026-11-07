package com.contour.app.alert

import android.app.Notification
import android.content.pm.ApplicationInfo
import android.os.SystemClock
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/**
 * Sees every notification once the user turns on notification access for Contour, and reacts only
 * to the phone's official emergency alerts (緊急速報メール / ETWS): those open Contour's alert screen.
 * Nothing is stored or sent anywhere; other notifications are ignored immediately.
 */
class EmergencyAlertListener : NotificationListenerService() {

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        val debug = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        if (!EmergencyAlertClassifier.isAlertPackage(sbn.packageName, debug)) return
        val extras = sbn.notification.extras
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()
        val text = (extras.getCharSequence(Notification.EXTRA_BIG_TEXT) ?: extras.getCharSequence(Notification.EXTRA_TEXT))?.toString()
        val kind = EmergencyAlertClassifier.classify(sbn.packageName, title, text, debug) ?: return

        // Alert apps often post and then update the same alert: open once per alert.
        val key = "${kind.id}|$title|${text?.take(80)}"
        val now = SystemClock.elapsedRealtime()
        synchronized(Companion) {
            if (key == lastKey && now - lastAt < DEDUPE_MS) return
            lastKey = key; lastAt = now
        }
        EmergencyPopup.show(applicationContext, kind, title.orEmpty(), text.orEmpty())
    }

    companion object {
        private const val DEDUPE_MS = 10 * 60 * 1000L
        private var lastKey: String? = null
        private var lastAt = 0L
    }
}
