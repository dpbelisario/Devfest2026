package com.contour.app.ui.destinations

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
import com.contour.app.ui.components.DestinationCard

@Composable
fun DestinationScreen(onSelect: (Destination) -> Unit, model: DestinationViewModel = viewModel()) {
    val state by model.state.collectAsStateWithLifecycle()
    LazyColumn(Modifier.fillMaxSize().safeDrawingPadding().padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item { Text("SEAR", style = MaterialTheme.typography.headlineLarge) }
        item { Text("Scaffold preview · fixed demo origin · earthquake scenario") }
        when (val current = state) {
            DestinationState.Loading -> item { CircularProgressIndicator() }
            DestinationState.Failed -> item {
                Text("Could not load destinations. Check the API URL and connection.")
                Button(onClick = model::refresh) { Text("Retry") }
            }
            is DestinationState.Ready -> {
                if (current.destinations.isEmpty()) item { Text("No matching destinations in this area.") }
                items(current.destinations, key = { it.id }) { site -> DestinationCard(site) { onSelect(site) } }
            }
        }
    }
}
