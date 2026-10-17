package com.runonphone.app.core

import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Appends to a log file, rotating it to "<name>.1" when it grows past [maxBytes]. */
class LogWriter(private val file: File, private val maxBytes: Long = 1_000_000) {
    private var out: FileOutputStream? = null
    private val time = SimpleDateFormat("HH:mm:ss", Locale.US)

    @Synchronized
    fun write(bytes: ByteArray, len: Int) {
        val o = out ?: open()
        o.write(bytes, 0, len)
        o.flush()
        if (file.length() > maxBytes) rotate()
    }

    @Synchronized
    fun system(message: String) {
        val line = "\n[run-on-phone ${time.format(Date())}] $message\n".toByteArray()
        write(line, line.size)
    }

    @Synchronized
    fun close() {
        runCatching { out?.close() }
        out = null
    }

    private fun open(): FileOutputStream {
        file.parentFile?.mkdirs()
        return FileOutputStream(file, true).also { out = it }
    }

    private fun rotate() {
        close()
        val old = File(file.parentFile, file.name + ".1")
        old.delete()
        file.renameTo(old)
    }

    companion object {
        /** Last [maxBytes] of the log (including the rotated part if needed). */
        fun tail(file: File, maxBytes: Int = 64_000): String {
            val old = File(file.parentFile, file.name + ".1")
            val cur = if (file.exists()) readTail(file, maxBytes) else ""
            if (cur.length >= maxBytes || !old.exists()) return cur
            return readTail(old, maxBytes - cur.length) + cur
        }

        private fun readTail(f: File, maxBytes: Int): String {
            java.io.RandomAccessFile(f, "r").use { raf ->
                val len = raf.length()
                val start = (len - maxBytes).coerceAtLeast(0)
                raf.seek(start)
                val buf = ByteArray((len - start).toInt())
                raf.readFully(buf)
                return String(buf, Charsets.UTF_8)
            }
        }
    }
}
