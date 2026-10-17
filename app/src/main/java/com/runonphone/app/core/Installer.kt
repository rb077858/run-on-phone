package com.runonphone.app.core

import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.zip.ZipInputStream

/** Downloads a published project from Firestore and unpacks it into its app/ folder. */
class Installer(private val paths: Paths, private val client: FirestoreClient) {

    /** [progress] receives 0..1. Must not be called while the project is running. */
    fun install(remote: FirestoreClient.RemoteProject, progress: (Float) -> Unit = {}) {
        paths.downloadsDir.mkdirs()
        val zip = File(paths.downloadsDir, "${remote.code}.zip")
        val digest = MessageDigest.getInstance("SHA-256")
        try {
            zip.outputStream().buffered().use { out ->
                for (i in 0 until remote.chunkCount) {
                    val bytes = client.getChunk(remote.code, remote.version, i)
                    digest.update(bytes)
                    out.write(bytes)
                    progress((i + 1f) / (remote.chunkCount + 1))
                }
            }
            val sha = digest.digest().joinToString("") { "%02x".format(it) }
            if (remote.sha256.isNotBlank() && !sha.equals(remote.sha256, ignoreCase = true)) {
                throw IOException("הקובץ שהורד פגום (sha256 לא תואם). נסה שוב.")
            }

            val target = paths.appDir(remote.code)
            val staging = File(target.parentFile, "app.new")
            staging.deleteRecursively()
            unzip(zip, staging)
            val old = File(target.parentFile, "app.old")
            old.deleteRecursively()
            if (target.exists() && !target.renameTo(old)) throw IOException("לא ניתן להחליף את הגרסה הקודמת")
            if (!staging.renameTo(target)) throw IOException("לא ניתן להתקין את הגרסה החדשה")
            old.deleteRecursively()
            paths.dataDir(remote.code).mkdirs()
            progress(1f)
        } finally {
            zip.delete()
        }
    }

    private fun unzip(zip: File, dest: File) {
        dest.mkdirs()
        val root = dest.canonicalPath + File.separator
        ZipInputStream(zip.inputStream().buffered()).use { zin ->
            while (true) {
                val entry = zin.nextEntry ?: break
                val out = File(dest, entry.name)
                if (!out.canonicalPath.startsWith(root)) throw IOException("נתיב לא חוקי בקובץ: ${entry.name}")
                if (entry.isDirectory) {
                    out.mkdirs()
                } else {
                    out.parentFile?.mkdirs()
                    out.outputStream().use { zin.copyTo(it) }
                }
            }
        }
    }
}
