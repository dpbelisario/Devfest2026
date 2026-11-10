package com.contour.app.indoor

import kotlin.math.ceil
import kotlin.math.ln
import kotlin.math.roundToInt

/** Experimental Engineering II floor estimate. Steps corroborate pressure changes, never an absolute floor. */
class FloorEstimator(
    private val groundMslMeters: Double = 37.4,
    private val floorHeightMeters: Double = 3.5,
    private val phoneHeightMeters: Double = 1.2,
) {
    data class Estimate(val floor: Int?, val source: String, val uncertaintyFloors: Int?)

    private var anchorFloor: Int? = null
    private var anchorPressure: Double? = null
    private var pressure: Double? = null
    private var steps = 0
    private var anchorSteps = 0
    private var candidateFloor: Int? = null
    private var candidateSince = 0L
    private var source = "unknown"
    private var uncertainty: Int? = null
    private var relativeFloor: Int? = null
    private var visualAnchorY: Double? = null
    private var visualCandidateFloor: Int? = null
    private var visualCandidateSince = 0L

    fun estimate() = Estimate(relativeFloor ?: anchorFloor, source, uncertainty)

    /** Input MUST be mean-sea-level altitude, not raw GPS ellipsoid altitude. */
    fun observeMslAltitude(meters: Double, accuracyMeters: Double) {
        if (anchorFloor != null || !meters.isFinite() || !accuracyMeters.isFinite() || accuracyMeters !in 0.0..20.0) return
        val floor = ((meters - groundMslMeters - phoneHeightMeters) / floorHeightMeters).roundToInt() + 1
        if (floor !in 1..4) return
        anchorFloor = floor
        anchorPressure = pressure
        anchorSteps = steps
        source = "altitude-estimate"
        uncertainty = ceil((accuracyMeters + 2.0) / floorHeightMeters).toInt().coerceAtLeast(1)
    }

    /** An authenticated, accurate building fix can anchor relative sensors without inventing a start. */
    fun observeIndoorFloor(floor: Int) {
        if (floor !in 1..4 || (anchorFloor == floor && source != "altitude-estimate")) return
        correctFloor(floor)
        source = "indooratlas-estimate"
        uncertainty = 1
    }

    /** A correction rebases all relative sensing and survives later noisy GPS readings. */
    fun correctFloor(floor: Int) {
        if (floor !in 1..4) return
        anchorFloor = floor
        relativeFloor = null
        anchorPressure = pressure
        anchorSteps = steps
        candidateFloor = null
        visualAnchorY = null
        visualCandidateFloor = null
        source = "corrected"
        uncertainty = 0
    }

    fun step() { steps++ }

    /** ARCore visual-inertial height changes are relative to a known floor and a stable tracking origin. */
    fun observeVisualHeight(yMeters: Double?, elapsedMillis: Long) {
        if (yMeters == null || !yMeters.isFinite()) {
            visualAnchorY = null
            visualCandidateFloor = null
            return
        }
        val floor = anchorFloor ?: return
        val baseline = visualAnchorY
        if (baseline == null) { visualAnchorY = yMeters; return }
        val change = yMeters - baseline
        if (kotlin.math.abs(change) < floorHeightMeters * 0.85) { visualCandidateFloor = null; return }
        val next = floor + (change / floorHeightMeters).roundToInt()
        if (next !in 1..4 || next == floor) { visualCandidateFloor = null; return }
        if (visualCandidateFloor != next) { visualCandidateFloor = next; visualCandidateSince = elapsedMillis; return }
        if (elapsedMillis - visualCandidateSince < 2500) return
        anchorFloor = next
        relativeFloor = next
        visualAnchorY = yMeters
        visualCandidateFloor = null
        anchorPressure = pressure
        anchorSteps = steps
        source = "camera-motion-estimate"
        uncertainty = (uncertainty ?: 1).coerceAtLeast(1)
    }

    fun observePressure(hpa: Double, elapsedMillis: Long) {
        if (!hpa.isFinite() || hpa !in 300.0..1100.0) return
        pressure = pressure?.let { it + (hpa - it) * 0.15 } ?: hpa
        val floor = anchorFloor ?: return
        if (anchorPressure == null) { anchorPressure = pressure; anchorSteps = steps; return }
        val elevationChange = 8434.5 * ln(anchorPressure!! / pressure!!)
        val delta = (elevationChange / floorHeightMeters).roundToInt()
        val next = floor + delta
        if (delta == 0 || next !in 1..4 || steps - anchorSteps < 4) {
            candidateFloor = null
            return
        }
        if (candidateFloor != next) { candidateFloor = next; candidateSince = elapsedMillis; return }
        if (elapsedMillis - candidateSince < 2500) return
        anchorFloor = next
        relativeFloor = next
        anchorPressure = pressure
        anchorSteps = steps
        candidateFloor = null
        visualAnchorY = null
        visualCandidateFloor = null
        source = "pressure-and-steps-estimate"
        uncertainty = (uncertainty ?: 1).coerceAtLeast(1)
    }
}
