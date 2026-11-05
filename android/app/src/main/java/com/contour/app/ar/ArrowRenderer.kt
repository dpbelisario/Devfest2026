package com.contour.app.ar

import android.opengl.GLES20
import android.opengl.Matrix
import com.contour.app.ar.rendering.floats
import com.contour.app.ar.rendering.program
import com.google.ar.core.Pose

/** A one-metre ground arrow pointing toward the next route waypoint. GL thread only. */
class ArrowRenderer {
    private var shader = 0
    private val model = FloatArray(16)
    private val modelView = FloatArray(16)
    private val mvp = FloatArray(16)
    // Identity anchor rotation uses east/up/south: the arrow's tip points north (-Z).
    private val vertices = floats(
        -0.55f, 0f, 0f, 0f, 0f, -1.2f, 0.55f, 0f, 0f,
        -0.18f, 0f, 0f, 0.18f, 0f, 0f, -0.18f, 0f, 0.6f,
        -0.18f, 0f, 0.6f, 0.18f, 0f, 0f, 0.18f, 0f, 0.6f,
    )

    fun create() {
        shader = program("""
            uniform mat4 uMvp;
            attribute vec3 aPosition;
            void main() { gl_Position = uMvp * vec4(aPosition, 1.0); }
        """.trimIndent(), """
            precision mediump float;
            void main() { gl_FragColor = vec4(0.09, 0.65, 0.30, 1.0); }
        """.trimIndent())
    }

    fun draw(pose: Pose, bearing: Float, view: FloatArray, projection: FloatArray) {
        pose.toMatrix(model, 0)
        Matrix.rotateM(model, 0, -bearing, 0f, 1f, 0f)
        Matrix.multiplyMM(modelView, 0, view, 0, model, 0)
        Matrix.multiplyMM(mvp, 0, projection, 0, modelView, 0)
        GLES20.glUseProgram(shader)
        GLES20.glDisable(GLES20.GL_CULL_FACE)
        GLES20.glUniformMatrix4fv(GLES20.glGetUniformLocation(shader, "uMvp"), 1, false, mvp, 0)
        val position = GLES20.glGetAttribLocation(shader, "aPosition")
        vertices.position(0)
        GLES20.glEnableVertexAttribArray(position)
        GLES20.glVertexAttribPointer(position, 3, GLES20.GL_FLOAT, false, 0, vertices)
        GLES20.glDrawArrays(GLES20.GL_TRIANGLES, 0, 9)
        GLES20.glDisableVertexAttribArray(position)
    }
}
