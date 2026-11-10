package com.contour.app.indoor.camera

import android.opengl.GLES20
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer

internal fun floats(vararg values: Float): FloatBuffer =
    ByteBuffer.allocateDirect(values.size * 4).order(ByteOrder.nativeOrder()).asFloatBuffer().apply {
        put(values); position(0)
    }

internal fun program(vertex: String, fragment: String): Int {
    fun shader(type: Int, source: String): Int {
        val id = GLES20.glCreateShader(type)
        GLES20.glShaderSource(id, source); GLES20.glCompileShader(id)
        val status = IntArray(1)
        GLES20.glGetShaderiv(id, GLES20.GL_COMPILE_STATUS, status, 0)
        if (status[0] == 0) { GLES20.glDeleteShader(id); error("AR shader compilation failed") }
        return id
    }
    val vertexId = shader(GLES20.GL_VERTEX_SHADER, vertex)
    val fragmentId = shader(GLES20.GL_FRAGMENT_SHADER, fragment)
    val id = GLES20.glCreateProgram()
    GLES20.glAttachShader(id, vertexId); GLES20.glAttachShader(id, fragmentId)
    GLES20.glLinkProgram(id)
    GLES20.glDeleteShader(vertexId); GLES20.glDeleteShader(fragmentId)
    val status = IntArray(1)
    GLES20.glGetProgramiv(id, GLES20.GL_LINK_STATUS, status, 0)
    check(status[0] != 0) { "AR shader linking failed" }
    return id
}
