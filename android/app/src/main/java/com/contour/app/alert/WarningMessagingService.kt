package com.contour.app.alert

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Receives JMA warning pushes while SEA is in the foreground (in the background Android shows the
 * notification itself on the "Disaster warnings" channel). Topic messaging only: the device token
 * is not sent to the backend, so onNewToken has nothing to do.
 */
class WarningMessagingService : FirebaseMessagingService() {

    override fun onMessageReceived(message: RemoteMessage) {
        if (!WarningPush.isEnabled(this)) return   // turned off while a message was in flight
        val payload = WarningPushPayload.parse(message.data) ?: return
        WarningPush.show(applicationContext, payload)
    }

    override fun onNewToken(token: String) = Unit
}
