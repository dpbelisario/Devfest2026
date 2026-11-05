package com.contour.app.ar

import android.app.Activity
import com.google.ar.core.ArCoreApk
import com.google.ar.core.Config
import com.google.ar.core.Session

/** Activity-owned ARCore resources. Pause the GL surface before pause/close. */
class GeospatialSession {
    var session: Session? = null
        private set
    private var installRequested = false

    /** Returns false while Play Services for AR installation is in progress. */
    fun resume(activity: Activity): Boolean {
        if (session == null) {
            if (ArCoreApk.getInstance().requestInstall(activity, !installRequested) == ArCoreApk.InstallStatus.INSTALL_REQUESTED) {
                installRequested = true
                return false
            }
            val created = Session(activity)
            try {
                check(created.isGeospatialModeSupported(Config.GeospatialMode.ENABLED)) {
                    "This device does not support Geospatial AR. Use a supported physical Android phone."
                }
                created.configure(created.config.apply {
                    geospatialMode = Config.GeospatialMode.ENABLED
                    focusMode = Config.FocusMode.AUTO
                })
                session = created
            } catch (error: Exception) {
                created.close()
                throw error
            }
        }
        session?.resume()
        return true
    }

    fun pause() { session?.pause() }
    fun close() { session?.close(); session = null; installRequested = false }
}
