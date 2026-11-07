package com.contour.app.indoor

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.contour.app.ui.theme.ContourTheme
import kotlin.math.min

class IndoorActivity : ComponentActivity() {
    private lateinit var model: IndoorViewModel
    private val permissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        if (hasPermissions()) model.start() else model.permissionDenied()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        model = ViewModelProvider(this)[IndoorViewModel::class.java]
        setContent {
            ContourTheme {
                val state by model.state.collectAsStateWithLifecycle()
                IndoorScreen(state, model.configured, onStart = {
                    if (hasPermissions()) model.start() else permissions.launch(requiredPermissions())
                }, onStop = model::stop, onRetry = model::retryMap, onBack = { finish() }, onSettings = {
                    startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
                })
            }
        }
    }

    private fun requiredPermissions(): Array<String> = buildList {
        add(Manifest.permission.ACCESS_FINE_LOCATION)
        add(Manifest.permission.ACCESS_COARSE_LOCATION)
        if (Build.VERSION.SDK_INT >= 31) add(Manifest.permission.BLUETOOTH_SCAN)
    }.toTypedArray()

    private fun hasPermissions() = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED &&
        (Build.VERSION.SDK_INT < 31 || checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED)

    override fun onPause() {
        // No background tracking or retained dot after leaving this feature.
        model.stop()
        super.onPause()
    }
}

@Composable
private fun IndoorScreen(
    state: IndoorState,
    configured: Boolean,
    onStart: () -> Unit,
    onStop: () -> Unit,
    onRetry: () -> Unit,
    onBack: () -> Unit,
    onSettings: () -> Unit,
) {
    Column(Modifier.fillMaxSize().safeDrawingPadding().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            TextButton(onClick = onBack) { Text("Back") }
            Text("Indoor navigation", style = MaterialTheme.typography.titleLarge)
        }
        Text("Positioning preview • Follow posted emergency signs and staff instructions.", style = MaterialTheme.typography.bodySmall)
        if (!configured) {
            Text("Indoor positioning is not configured in this build. Add your IndoorAtlas client SDK credentials and rebuild.")
        } else {
            Text("Starting uses IndoorAtlas to process device location and sensor data. A surveyed venue is required.", style = MaterialTheme.typography.bodySmall)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = if (state.running) onStop else onStart) { Text(if (state.running) "Stop" else "Start positioning") }
                TextButton(onClick = onSettings) { Text("App settings") }
            }
        }
        Text(state.message)
        state.plan?.let { plan ->
            Text("${plan.name} • Floor ${plan.floorLevel}", style = MaterialTheme.typography.titleMedium)
        }
        state.accuracyMeters?.let { Text("Reported accuracy: ±${it.toInt().coerceAtLeast(1)} m • Cone shows phone direction") }
        if (state.loadingMap) LinearProgressIndicator(Modifier.fillMaxWidth())
        if (state.mapError) Button(onClick = onRetry, enabled = state.running) { Text("Retry floor image") }
        if (state.bitmap != null && state.plan != null) {
            IndoorFloorMap(state, Modifier.weight(1f).fillMaxWidth())
            Text("Pinch to zoom; drag to pan. Floor switches automatically when detected.", style = MaterialTheme.typography.bodySmall)
        } else {
            Box(Modifier.weight(1f).fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant).padding(16.dp)) {
                Text(if (state.loadingMap) "Loading floor map…" else "No floor image available. Positioning works only in a prepared venue.")
            }
        }
        Text("Evacuation routing is not configured. No route or exit is inferred from the floor image.", style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun IndoorFloorMap(state: IndoorState, modifier: Modifier) {
    val plan = state.plan ?: return
    val bitmap = state.bitmap ?: return
    val image = remember(bitmap) { bitmap.asImageBitmap() }
    var zoom by remember(plan.id) { mutableFloatStateOf(1f) }
    var pan by remember(plan.id) { mutableStateOf(Offset.Zero) }
    Column(modifier) {
        TextButton(onClick = { zoom = 1f; pan = Offset.Zero }) { Text("Reset map") }
        Canvas(Modifier.weight(1f).fillMaxWidth().background(Color.White)
            .semantics { contentDescription = "Indoor floor plan. ${if (state.position == null) "Position unavailable" else "Estimated position displayed"}" }
            .pointerInput(plan.id) {
                detectTransformGestures { _, movement, scale, _ ->
                    zoom = (zoom * scale).coerceIn(1f, 6f)
                    pan = Offset((pan.x + movement.x).coerceIn(-size.width * zoom, size.width * zoom),
                        (pan.y + movement.y).coerceIn(-size.height * zoom, size.height * zoom))
                }
            }) {
            val fit = min(size.width / image.width, size.height / image.height)
            val scale = fit * zoom
            val origin = Offset((size.width - image.width * scale) / 2, (size.height - image.height * scale) / 2) + pan
            withTransform({ translate(origin.x, origin.y); scale(scale, scale, Offset.Zero) }) {
                drawImage(image)
            }
            state.position?.let { point ->
                // SDK coordinates refer to original image dimensions; decoded images may be sampled.
                val sx = image.width.toFloat() / plan.bitmapWidth
                val sy = image.height.toFloat() / plan.bitmapHeight
                val center = origin + Offset(point.x * sx * scale, point.y * sy * scale)
                val radius = point.accuracyPixels * min(sx, sy) * scale
                drawCircle(Color(0x263467D5), radius, center)
                drawCircle(Color(0xFF3467D5), radius, center, style = Stroke(1.dp.toPx()))
                state.heading?.let { heading ->
                    withTransform({ rotate(heading, center) }) {
                        val reach = 38.dp.toPx()
                        val cone = Path().apply {
                            moveTo(center.x, center.y)
                            lineTo(center.x - reach * .45f, center.y - reach)
                            lineTo(center.x + reach * .45f, center.y - reach)
                            close()
                        }
                        drawPath(cone, Color(0x663467D5))
                    }
                }
                drawCircle(Color.White, 9.dp.toPx(), center)
                drawCircle(Color(0xFF3467D5), 6.dp.toPx(), center)
            }
        }
    }
}
