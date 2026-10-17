package com.runonphone.app.core

import android.content.Context
import java.io.File

class Paths(context: Context) {
    private val files: File = context.filesDir

    val projectsDir = File(files, "projects")
    val runtimeDir = File(files, "runtime")
    val homeDir = File(files, "home")
    val tmpDir = File(context.cacheDir, "tmp")
    val downloadsDir = File(context.cacheDir, "downloads")

    fun projectDir(code: String) = File(projectsDir, code)
    /** The published code. Replaced on every update. */
    fun appDir(code: String) = File(projectDir(code), "app")
    /** Persistent data (sessions, databases). Never touched by updates. */
    fun dataDir(code: String) = File(projectDir(code), "data")
    fun logFile(code: String) = File(projectDir(code), "logs/output.log")
}
