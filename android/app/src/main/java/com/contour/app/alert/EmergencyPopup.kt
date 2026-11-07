package com.contour.app.alert

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.View
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.contour.app.R
import com.contour.app.WebUiActivity
import org.json.JSONObject

/**
 * Brings Contour to the front when an official emergency alert arrives.
 *
 * Android does not let apps open themselves from the background, so two paths are used together:
 * 1. "Display over other apps" granted: start the alert screen directly. Android 15 requires the app to
 *    have a visible overlay window at that moment, so a 1-pixel transparent one is shown briefly.
 * 2. Always: a high-priority notification with a full-screen intent. On a locked or sleeping phone
 *    Android opens the alert screen from it; otherwise it appears as a heads-up banner.
 */
object EmergencyPopup {
    const val EXTRA_KIND = "com.contour.app.ALERT_KIND"
    const val EXTRA_TITLE = "com.contour.app.ALERT_TITLE"
    const val EXTRA_TEXT = "com.contour.app.ALERT_TEXT"
    private const val CHANNEL = "emergency_popup"
    private const val NOTIFICATION_ID = 7110

    fun alertIntent(context: Context, kind: AlertKind, title: String, text: String): Intent =
        Intent(context, WebUiActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(EXTRA_KIND, kind.id)
            .putExtra(EXTRA_TITLE, title)
            .putExtra(EXTRA_TEXT, text)

    /**
     * [test]: the user's own test from the app. A real alert already sounds and vibrates (the phone's
     * emergency-alert app does that), so only the test makes its own siren and vibration.
     */
    fun show(context: Context, kind: AlertKind, title: String, text: String, test: Boolean = false) {
        val intent = alertIntent(context, kind, title, text)
        if (test) { vibrateAlarm(context); TestSiren.play() }
        postNotification(context, intent, title, text)
        if (Settings.canDrawOverlays(context)) startOverOtherApps(context, intent)
    }

    /**
     * The user's test, played like a real alert: the screen wakes, a test "official alert" notification
     * appears (lock screen or banner) with vibration and siren, and ~3.5 s later Contour pops up.
     */
    fun showTest(context: Context, kind: AlertKind, title: String, text: String) {
        wakeScreen(context)
        vibrateAlarm(context)
        TestSiren.play()
        postTestOfficialAlert(context, kind, title, text)
        Handler(Looper.getMainLooper()).postDelayed({
            val intent = alertIntent(context, kind, title, text)
            postNotification(context, intent, title, text)
            if (Settings.canDrawOverlays(context)) startOverOtherApps(context, intent)
        }, 3_500)
    }

    private const val TEST_CHANNEL = "emergency_test_alert"
    private const val TEST_NOTIFICATION_ID = 7111

    /** Stands in for the phone's official alert notification during a test (clearly marked as a test). */
    private fun postTestOfficialAlert(context: Context, kind: AlertKind, title: String, text: String) {
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        if (nm.getNotificationChannel(TEST_CHANNEL) == null) {
            nm.createNotificationChannel(NotificationChannel(TEST_CHANNEL, "Test alert", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "The test alert from Contour's menu"
                setSound(null, null)          // the test siren plays separately
                enableVibration(false)        // and so does the vibration
                lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
            })
        }
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return
        val pi = PendingIntent.getActivity(context, TEST_NOTIFICATION_ID, alertIntent(context, kind, title, text),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n = NotificationCompat.Builder(context, TEST_CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_warning)
            .setColor(0xFFB3261E.toInt())
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setTimeoutAfter(10 * 60 * 1000L)
            .build()
        try { nm.notify(TEST_NOTIFICATION_ID, n) } catch (_: SecurityException) { }
    }

    /** Turns the screen on for a few seconds so the test notification can be seen, like a real alert. */
    private fun wakeScreen(context: Context) {
        val pm = context.getSystemService(android.os.PowerManager::class.java) ?: return
        try {
            @Suppress("DEPRECATION")
            pm.newWakeLock(android.os.PowerManager.SCREEN_BRIGHT_WAKE_LOCK or android.os.PowerManager.ACQUIRE_CAUSES_WAKEUP, "contour:testalert")
                .acquire(8_000)
        } catch (_: Exception) { }
    }

    /** Strong, alarm-style vibration (like an emergency alert) for the test. */
    private fun vibrateAlarm(context: Context) {
        val pattern = longArrayOf(0, 900, 250, 900, 250, 900, 250, 900, 250, 900)
        val vibrator = if (Build.VERSION.SDK_INT >= 31)
            context.getSystemService(android.os.VibratorManager::class.java)?.defaultVibrator
        else @Suppress("DEPRECATION") context.getSystemService(android.os.Vibrator::class.java)
        val attrs = android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_ALARM).build()
        try {
            @Suppress("DEPRECATION") vibrator?.vibrate(android.os.VibrationEffect.createWaveform(pattern, -1), attrs)
        } catch (_: Exception) { }
    }

    private fun postNotification(context: Context, intent: Intent, title: String, text: String) {
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        if (nm.getNotificationChannel(CHANNEL) == null) {
            // The official alert already sounds and vibrates; this channel stays silent but urgent.
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Emergency pop-up", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Opens Contour when an official emergency alert arrives"
                setSound(null, null)
                enableVibration(false)
                lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
            })
        }
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return
        val pi = PendingIntent.getActivity(context, NOTIFICATION_ID, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title.ifBlank { "Contour" })
            .setContentText(text.ifBlank { "Open Contour for the nearest evacuation site" })
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setContentIntent(pi)
            .setFullScreenIntent(pi, true)
            .setAutoCancel(true)
            .build()
        try { nm.notify(NOTIFICATION_ID, n) } catch (_: SecurityException) { }
    }

    private fun startOverOtherApps(context: Context, intent: Intent) {
        val main = Handler(Looper.getMainLooper())
        main.post {
            val wm = context.getSystemService(WindowManager::class.java)
            val dot = View(context)
            val params = WindowManager.LayoutParams(
                1, 1,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE,
                PixelFormat.TRANSLUCENT,
            )
            val added = try { wm?.addView(dot, params); wm != null } catch (_: Exception) { false }
            try { context.startActivity(intent) } catch (_: Exception) { }
            if (added) main.postDelayed({ try { wm?.removeView(dot) } catch (_: Exception) { } }, 3_000)
        }
    }

    /** Which permissions are on, for the setup page. */
    fun status(context: Context): JSONObject {
        val listener = NotificationManagerCompat.getEnabledListenerPackages(context).contains(context.packageName)
        val notifications = NotificationManagerCompat.from(context).areNotificationsEnabled()
        val fullScreen = Build.VERSION.SDK_INT < 34 ||
            (context.getSystemService(NotificationManager::class.java)?.canUseFullScreenIntent() ?: false)
        return JSONObject()
            .put("listener", listener)
            .put("overlay", Settings.canDrawOverlays(context))
            .put("notifications", notifications)
            .put("fullScreen", fullScreen)
    }

    fun listenerComponent(context: Context) = ComponentName(context, EmergencyAlertListener::class.java)
}
