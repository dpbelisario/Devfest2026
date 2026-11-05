package com.contour.app.ui.ar

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.contour.app.ar.DevicePose
import com.contour.app.ar.GeospatialState
import com.contour.app.data.ContourRepository
import com.contour.app.data.model.Destination
import com.contour.app.data.model.NavigationRoute
import com.contour.app.data.remote.ApiException
import com.contour.app.guidance.GeoMath
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import org.json.JSONException

sealed interface DestinationLoad {
    data object Waiting : DestinationLoad
    data object Loading : DestinationLoad
    data class Ready(val destinations: List<Destination>) : DestinationLoad
    data class Failed(val message: String) : DestinationLoad
}

data class ArUiState(
    val tracking: GeospatialState = GeospatialState(),
    val destinations: DestinationLoad = DestinationLoad.Waiting,
    val route: NavigationRoute? = null,
    val destinationName: String? = null,
    val routeLoading: Boolean = false,
    val routeError: String? = null,
)

/** Network work uses the repository's IO dispatcher; only immutable state crosses from rendering. */
class GeospatialArViewModel : ViewModel() {
    private val repository = ContourRepository()
    private val mutableState = MutableStateFlow(ArUiState())
    val state = mutableState.asStateFlow()
    private var latestPose: DevicePose? = null
    private var destinationJob: Job? = null
    private var routeJob: Job? = null
    private var searched = false

    fun onTrackingState(tracking: GeospatialState) {
        latestPose = tracking.pose.takeIf { tracking.localized }
        mutableState.update { it.copy(tracking = tracking) }
        if (latestPose != null && !searched) refreshDestinations()
    }

    fun sessionPaused() {
        latestPose = null
        mutableState.update { it.copy(tracking = GeospatialState("AR paused. Localizing again on resume.")) }
    }

    fun refreshDestinations() {
        routeJob?.cancel(); destinationJob?.cancel()
        mutableState.update { it.copy(route = null, destinationName = null, routeError = null, routeLoading = false) }
        val pose = latestPose
        if (pose == null) {
            searched = false
            mutableState.update { it.copy(destinations = DestinationLoad.Waiting) }
            return
        }
        searched = true
        mutableState.update { it.copy(destinations = DestinationLoad.Loading) }
        destinationJob = viewModelScope.launch {
            try {
                val rows = repository.destinations(pose.latitude, pose.longitude)
                mutableState.update { it.copy(destinations = DestinationLoad.Ready(rows)) }
            } catch (error: CancellationException) { throw error }
            catch (_: IOException) { destinationFailure() }
            catch (_: JSONException) { destinationFailure() }
        }
    }

    private fun destinationFailure() {
        mutableState.update { it.copy(destinations = DestinationLoad.Failed("Could not load destinations. Check the backend connection and retry.")) }
    }

    fun select(destination: Destination) {
        val pose = latestPose
        if (pose == null) {
            mutableState.update { it.copy(routeError = "Wait for accurate localization before selecting a destination.") }
            return
        }
        routeJob?.cancel()
        mutableState.update { it.copy(route = null, routeLoading = true, routeError = null, destinationName = destination.name) }
        routeJob = viewModelScope.launch {
            try {
                val route = repository.directions(destination.id, pose.latitude, pose.longitude)
                if (GeoMath.distance(pose.latitude, pose.longitude, route.waypoints.first()) > route.maxOriginDistanceMeters) {
                    throw IOException("Unsupported route origin")
                }
                mutableState.update { it.copy(route = route, routeLoading = false) }
            } catch (error: CancellationException) { throw error }
            catch (error: IOException) {
                val message = if (error is ApiException && error.statusCode == 422)
                    "No saved route starts at your current position. No AR arrows were created."
                    else "Could not load a valid route. Check the connection or choose another destination."
                mutableState.update { it.copy(routeLoading = false, routeError = message) }
            } catch (_: JSONException) {
                mutableState.update { it.copy(routeLoading = false, routeError = "The backend returned an invalid route. No AR arrows were created.") }
            }
        }
    }
}
