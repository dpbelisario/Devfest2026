package com.contour.app.alert

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.contour.app.BuildConfig
import com.contour.app.WebUiActivity
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import org.json.JSONObject

/**
 * JMA warning notifications through Firebase Cloud Messaging (docs/push-notifications.md).
 *
 * The backend sends Nagoya weather warnings/advisories and Aichi-related earthquake, tsunami and
 * volcano bulletins to one FCM topic. Off until the user turns it on; turning it on asks for the
 * notification permission (Android 13+) and subscribes to the topic. No token is sent anywhere.
 * Without android/app/google-services.json the build has no Firebase and this stays unavailable.
 */
object WarningPush {
    const val CHANNEL = "disaster_warnings"
    private const val TAG = "WarningPush"
    private const val PREF = "warningPush"
    @Volatile private var loggedUnavailable = false

    /** True when this build has Firebase config and Firebase started. */
    fun isAvailable(context: Context): Boolean {
        val ok = BuildConfig.FIREBASE_CONFIGURED &&
            try { FirebaseApp.getApps(context).isNotEmpty() } catch (_: Exception) { false }
        if (!ok && !loggedUnavailable) {
            loggedUnavailable = true
            Log.i(TAG, "Warning push unavailable: no Firebase config in this build (android/app/google-services.json).")
        }
        return ok
    }

    fun isEnabled(context: Context) = prefs(context).getBoolean(PREF, false)

    /** For the setup page: {available, enabled, notifications}. */
    fun status(context: Context): JSONObject = JSONObject()
        .put("available", isAvailable(context))
        .put("enabled", isEnabled(context))
        .put("notifications", NotificationManagerCompat.from(context).areNotificationsEnabled())

    /** Subscribe to the warning topic; [done] gets true once subscribed (main thread). */
    fun enable(context: Context, done: (Boolean) -> Unit) {
        if (!isAvailable(context)) { done(false); return }
        ensureChannel(context)
        val app = context.applicationContext
        try {
            val messaging = FirebaseMessaging.getInstance()
            messaging.isAutoInitEnabled = true
            messaging.subscribeToTopic(BuildConfig.WARNING_TOPIC).addOnCompleteListener { task ->
                if (task.isSuccessful) prefs(app).edit().putBoolean(PREF, true).apply()
                else Log.w(TAG, "Topic subscribe failed", task.exception)
                done(task.isSuccessful)
            }
        } catch (e: Exception) {
            Log.w(TAG, "Topic subscribe failed", e); done(false)
        }
    }

    /** Unsubscribe; stays on (and [done] gets false) if that fails, e.g. offline. */
    fun disable(context: Context, done: (Boolean) -> Unit) {
        val app = context.applicationContext
        if (!isAvailable(context)) { prefs(app).edit().putBoolean(PREF, false).apply(); done(true); return }
        try {
            FirebaseMessaging.getInstance().unsubscribeFromTopic(BuildConfig.WARNING_TOPIC).addOnCompleteListener { task ->
                if (task.isSuccessful) prefs(app).edit().putBoolean(PREF, false).apply()
                else Log.w(TAG, "Topic unsubscribe failed", task.exception)
                done(task.isSuccessful)
            }
        } catch (e: Exception) {
            Log.w(TAG, "Topic unsubscribe failed", e); done(false)
        }
    }

    /** On app start: renew the subscription of a user who turned warnings on (cheap, idempotent). */
    fun refresh(context: Context) {
        if (isEnabled(context) && isAvailable(context)) enable(context) { }
    }

    fun ensureChannel(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        if (nm.getNotificationChannel(CHANNEL) != null) return
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Disaster warnings", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "JMA warnings for Nagoya, and earthquake, tsunami and volcano bulletins that mention Aichi"
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        })
    }

    /** Opens SEA; warnings (not advisories) open the existing alert screen via EmergencyPopup extras. */
    fun tapIntent(context: Context, payload: WarningPushPayload): Intent {
        val kind = payload.alertKind
        return if (kind != null) EmergencyPopup.alertIntent(context, kind, payload.title, payload.body)
        else Intent(context, WebUiActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }

    /**
     * A tap on a notification shown by the system while SEA was in the background starts SEA with the
     * FCM data as extras. Turns those into the alert extras WebUiActivity already understands.
     */
    fun adoptTapExtras(intent: Intent?) {
        if (intent?.getStringExtra("deliveryKey") == null) return
        val payload = WarningPushPayload.parse(WarningPushPayload.KEYS.associateWith { intent.getStringExtra(it) })
        WarningPushPayload.KEYS.forEach { intent.removeExtra(it) }
        val kind = payload?.alertKind ?: return
        intent.putExtra(EmergencyPopup.EXTRA_KIND, kind.id)
            .putExtra(EmergencyPopup.EXTRA_TITLE, payload.title)
            .putExtra(EmergencyPopup.EXTRA_TEXT, payload.body)
    }

    /** Shows a warning that arrived while SEA was in the foreground (the system shows the others). */
    fun show(context: Context, payload: WarningPushPayload) {
        ensureChannel(context)
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return
        val pi = PendingIntent.getActivity(context, payload.tag.hashCode(), tapIntent(context, payload),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_warning)
            .setContentTitle(payload.title)
            .setContentText(payload.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(payload.body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setContentIntent(pi)
            .setAutoCancel(true)
            .build()
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        try { nm.notify(payload.tag, 0, n) } catch (_: SecurityException) { }
    }

    private fun prefs(context: Context) = context.getSharedPreferences("contour", Context.MODE_PRIVATE)
}
