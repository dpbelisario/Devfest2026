package com.contour.app.alert

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import kotlin.math.PI
import kotlin.math.sin

/**
 * A short siren (rising and falling tone) for the user's test alert. Generated in code, so no sound
 * file is needed. Plays on the alarm stream, so it is heard at alarm volume. Real alerts do not use
 * this: the phone's own emergency-alert app makes the sound.
 */
object TestSiren {
    private const val RATE = 22_050
    private const val SECONDS = 6
    @Volatile private var track: AudioTrack? = null

    fun play() {
        Thread {
            stop()
            val n = RATE * SECONDS
            val pcm = ShortArray(n)
            var phase = 0.0
            for (i in 0 until n) {
                val t = i.toDouble() / RATE
                // "Wail": the pitch sweeps 650 Hz -> 1350 Hz -> 650 Hz once per 1.5 s.
                val cycle = (t % 1.5) / 1.5
                val sweep = if (cycle < 0.5) cycle * 2 else (1 - cycle) * 2
                val freq = 650 + 700 * sweep
                phase += 2 * PI * freq / RATE
                val fade = minOf(1.0, t * 8, (SECONDS - t) * 8)   // no clicks at start and end
                pcm[i] = (sin(phase) * 0.8 * fade * Short.MAX_VALUE).toInt().toShort()
            }
            try {
                val t = AudioTrack.Builder()
                    .setAudioAttributes(AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                    .setAudioFormat(AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(RATE)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                    .setTransferMode(AudioTrack.MODE_STATIC)
                    .setBufferSizeInBytes(n * 2)
                    .build()
                t.write(pcm, 0, n)
                track = t
                t.play()
                Thread.sleep(SECONDS * 1000L + 300)
                if (track === t) stop()
            } catch (_: Exception) { }
        }.start()
    }

    fun stop() {
        val t = track ?: return
        track = null
        try { t.stop() } catch (_: Exception) { }
        t.release()
    }
}
