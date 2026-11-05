package com.contour.app.ui.navigation

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.contour.app.data.model.Destination

@Composable
fun NavigationScreen(destination: Destination, onBack: () -> Unit, model: NavigationViewModel = viewModel()) {
    val state by model.state.collectAsStateWithLifecycle()
    LaunchedEffect(destination.id) { model.load(destination.id) }
    BackHandler(onBack = onBack)
    LazyColumn(Modifier.fillMaxSize().safeDrawingPadding().padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item { TextButton(onClick = onBack) { Text("Back") } }
        item { Text(destination.name, style = MaterialTheme.typography.headlineSmall) }
        item { Text("Fixed-origin demo route preview. Open 3D AR from the map for native Geospatial AR using your actual position.") }
        when (val current = state) {
            NavigationState.Loading -> item { CircularProgressIndicator() }
            NavigationState.Failed -> item {
                Text("Could not load this demo route.")
                Button(onClick = { model.load(destination.id) }) { Text("Retry") }
            }
            is NavigationState.Ready -> items(current.route.waypoints) { point -> Text(point.instruction) }
        }
    }
}
