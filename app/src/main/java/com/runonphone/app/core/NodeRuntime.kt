package com.runonphone.app.core

import android.content.Context
import android.os.Build
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * The bundled Node.js (Termux build, see tools/fetch-runtime.mjs).
 * The executable and its shared libraries ship in jniLibs/arm64-v8a, so Android
 * installs them into nativeLibraryDir, the only place apps may execute files from.
 * node finds the libraries next to itself (its RUNPATH is patched to $ORIGIN).
 */
class NodeRuntime(private val context: Context) {
    private val paths = Paths(context)

    private val nativeDir get() = File(context.applicationInfo.nativeLibraryDir)
    val nodeBinary: File get() = File(nativeDir, "libnode.so")
    private val etcDir get() = File(paths.runtimeDir, "etc")

    /** Copies runtime data files (CA certificates) out of the APK when missing or after an app update. */
    @Synchronized
    fun ensureInstalled() {
        val stamp = File(paths.runtimeDir, ".installed")
        val pkg = context.packageManager.getPackageInfo(context.packageName, 0)
        val want = "${pkg.longVersionCode}-${pkg.lastUpdateTime}"
        if (stamp.exists() && stamp.readText() == want && etcDir.exists()) return

        paths.runtimeDir.deleteRecursively()
        etcDir.mkdirs()
        val assets = context.assets
        for (name in assets.list("runtime/etc").orEmpty()) {
            assets.open("runtime/etc/$name").use { input ->
                File(etcDir, name).outputStream().use { input.copyTo(it) }
            }
        }
        // Empty OpenSSL config so OpenSSL doesn't look for Termux's path.
        File(etcDir, "openssl.cnf").writeText("")
        stamp.writeText(want)
    }

    fun version(): String = runCatching {
        context.assets.open("runtime/version.txt").bufferedReader().readText().trim()
    }.getOrDefault("?")

    /** Base environment for every node process. */
    fun environment(): Map<String, String> {
        paths.homeDir.mkdirs()
        paths.tmpDir.mkdirs()
        return mapOf(
            "LD_LIBRARY_PATH" to nativeDir.absolutePath,
            "HOME" to paths.homeDir.absolutePath,
            "TMPDIR" to paths.tmpDir.absolutePath,
            "SSL_CERT_FILE" to File(etcDir, "cert.pem").absolutePath,
            "OPENSSL_CONF" to File(etcDir, "openssl.cnf").absolutePath,
            "NODE_ENV" to "production",
            "RUN_ON_PHONE" to "1",
            "TZ" to java.util.TimeZone.getDefault().id,
            "LANG" to "en_US.UTF-8",
        )
    }

    /** Runs `node -e` as a quick self-test; returns its output. */
    fun selfTest(): String {
        ensureInstalled()
        if (Build.SUPPORTED_ABIS.none { it == "arm64-v8a" }) return "המכשיר אינו arm64 – לא נתמך"
        val pb = ProcessBuilder(
            nodeBinary.absolutePath, "-e",
            "console.log('Node ' + process.version + ' ' + process.arch + ', fetch=' + typeof fetch)",
        ).redirectErrorStream(true)
        pb.environment().putAll(environment())
        val p = pb.start()
        val out = p.inputStream.bufferedReader().readText()
        if (!p.waitFor(20, TimeUnit.SECONDS)) {
            p.destroyForcibly()
            return "תם הזמן\n$out"
        }
        return "exit=${p.exitValue()}\n$out"
    }
}
