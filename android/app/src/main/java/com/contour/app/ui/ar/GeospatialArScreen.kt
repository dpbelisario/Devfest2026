package com.contour.app.ui.ar

import android.opengl.GLSurfaceView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.contour.app.data.model.Destination
import java.util.Locale

@Composable
fun GeospatialArScreen(
    surface: GLSurfaceView,
    state: ArUiState,
    accepted: Boolean,
    permissionsGranted: Boolean,
    running: Boolean,
    error: String?,
    onConsent: () -> Unit,
    onPermissions: () -> Unit,
    onSettings: () -> Unit,
    onPrivacy: () -> Unit,
    onGooglePrivacy: () -> Unit,
    onRetry: () -> Unit,
    onRefresh: () -> Unit,
    onSelect: (Destination) -> Unit,
    onBack: () -> Unit,
) {
    val wash = Color(0xFFF3F5F3)
    Box(Modifier.fillMaxSize().background(wash).safeDrawingPadding()) {
        AndroidView(factory = { surface }, modifier = Modifier.fillMaxSize())
        if (!running) {
            Column(Modifier.fillMaxSize().background(wash).verticalScroll(rememberScrollState()).padding(20.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp)) {
                TextButton(onClick = onBack) { Text("Back to map") }
                Text("Geospatial AR", style = MaterialTheme.typography.headlineMedium)
                Text("Prototype only. Routes are not verified evacuation guidance. Check your surroundings and follow local authorities.")
                when {
                    !accepted -> {
                        Text("The map's sample locations are fictional. AR uses a separate list of backend destinations near your actual position.")
                        Text("This feature uses Google Play Services for AR (ARCore).")
                        Text("To power this session, Google will process sensor data (e.g., camera and location).")
                        TextButton(onClick = onPrivacy) { Text("Learn how ARCore handles your data") }
                        TextButton(onClick = onGooglePrivacy) { Text("Google Privacy Policy") }
                        Button(onClick = onConsent) { Text("Agree and continue") }
                    }
                    !permissionsGranted -> {
                        Text("Camera and precise location access are required only while using AR. Approximate location is insufficient for Geospatial tracking.")
                        Button(onClick = onPermissions) { Text("Allow camera and precise location") }
                        TextButton(onClick = onSettings) { Text("Open app settings") }
                    }
                    error != null -> {
                        Text(error)
                        Button(onClick = onRetry) { Text("Retry AR") }
                    }
                    else -> { CircularProgressIndicator(); Text("Preparing AR. Complete the Google Play Services for AR installation if prompted.") }
                }
            }
        } else {
            Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.SpaceBetween) {
                Surface(color = wash, modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            TextButton(onClick = onBack) { Text("Back to map") }
                            TextButton(onClick = onRetry) { Text("Retry AR") }
                        }
                        Text(state.tracking.message)
                        state.tracking.pose?.let { pose ->
                            Text(String.format(Locale.US, "Accuracy: horizontal %.1f m · vertical %.1f m · yaw %.1f°",
                                pose.horizontalAccuracy, pose.verticalAccuracy, pose.yawAccuracy), style = MaterialTheme.typography.bodySmall)
                        }
                        Text("Prototype only • Not verified evacuation guidance", style = MaterialTheme.typography.labelMedium)
                    }
                }
                Surface(color = wash, modifier = Modifier.fillMaxWidth().heightIn(max = 280.dp)) {
                    Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (state.route != null) {
                            Text(state.destinationName ?: "Selected destination", style = MaterialTheme.typography.titleMedium)
                            Text(if (state.route.isDemo) "Synthetic demo route" else "Route requires field verification")
                            TextButton(onClick = onRefresh) { Text("Choose another destination") }
                        } else {
                            Text("Earthquake destinations", style = MaterialTheme.typography.titleMedium)
                            Text("These are separate from the fictional locations on the map.", style = MaterialTheme.typography.bodySmall)
                            state.routeError?.let { Text(it) }
                            if (state.routeLoading) LinearProgressIndicator(Modifier.fillMaxWidth())
                            when (val load = state.destinations) {
                                DestinationLoad.Waiting -> Text("Waiting for accurate device localization…")
                                DestinationLoad.Loading -> CircularProgressIndicator()
                                is DestinationLoad.Failed -> {
                                    Text(load.message)
                                    TextButton(onClick = onRefresh) { Text("Retry destinations") }
                                }
                                is DestinationLoad.Ready -> {
                                    if (load.destinations.isEmpty()) Text("No earthquake destinations are available near this position. The current backend contains limited synthetic demo data.")
                                    load.destinations.forEach { destination ->
                                        val kind = when (destination.kind) {
                                            "emergencySite" -> "Emergency site"
                                            "shelter" -> "Shelter"
                                            else -> "Unknown site type"
                                        }
                                        OutlinedButton(onClick = { onSelect(destination) }, enabled = state.tracking.localized && !state.routeLoading) {
                                            Text("${destination.name}${if (destination.isDemo) " (demo)" else ""} • $kind • Opening: ${destination.openingStatus}")
                                        }
                                    }
                                    TextButton(onClick = onRefresh) { Text("Refresh nearby destinations") }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
