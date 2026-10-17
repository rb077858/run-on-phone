package com.runonphone.app.core

import android.util.Base64
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * Minimal read-only Firestore client over the REST API (no Firebase SDK needed).
 *
 * Layout written by publisher/publish.mjs:
 *   projects/{code}                      { manifest, version, chunkCount, sha256, size, updatedAt }
 *   projects/{code}/chunks/v{version}_{i} { data: bytes }
 */
class FirestoreClient(private val projectId: String, private val apiKey: String) {

    data class RemoteProject(
        val code: String,
        val version: Long,
        val manifestJson: String,
        val chunkCount: Int,
        val sha256: String,
        val size: Long,
    )

    /** Returns null when no project has this code. */
    fun getProject(code: String): RemoteProject? {
        val f = getFields("projects/$code") ?: return null
        return RemoteProject(
            code = code,
            version = f.long("version"),
            manifestJson = f.string("manifest"),
            chunkCount = f.long("chunkCount").toInt(),
            sha256 = f.string("sha256"),
            size = f.long("size"),
        )
    }

    fun getChunk(code: String, version: Long, index: Int): ByteArray {
        val f = getFields("projects/$code/chunks/v${version}_$index")
            ?: throw IOException("חסר חלק $index של הקוד (גרסה $version)")
        val b64 = f.optJSONObject("data")?.optString("bytesValue")
            ?: throw IOException("חלק $index פגום")
        return Base64.decode(b64, Base64.DEFAULT)
    }

    private fun getFields(docPath: String): JSONObject? {
        if (projectId.isBlank() || apiKey.isBlank()) {
            throw IOException("Firebase לא מוגדר – פתח הגדרות והזן Project ID ו-API Key")
        }
        val url = URL(
            "https://firestore.googleapis.com/v1/projects/$projectId/databases/(default)/documents/" +
                docPath + "?key=" + URLEncoder.encode(apiKey, "UTF-8"),
        )
        val conn = url.openConnection() as HttpURLConnection
        conn.connectTimeout = 15_000
        conn.readTimeout = 60_000
        try {
            val code = conn.responseCode
            if (code == 404) return null
            if (code == 403) throw IOException("אין הרשאת קריאה ב-Firestore (בדוק את חוקי האבטחה)")
            if (code !in 200..299) {
                val err = conn.errorStream?.bufferedReader()?.readText().orEmpty()
                throw IOException("Firestore החזיר $code: ${err.take(300)}")
            }
            val body = conn.inputStream.bufferedReader().readText()
            return JSONObject(body).optJSONObject("fields") ?: JSONObject()
        } finally {
            conn.disconnect()
        }
    }

    private fun JSONObject.string(name: String): String =
        optJSONObject(name)?.optString("stringValue").orEmpty()

    private fun JSONObject.long(name: String): Long {
        val v = optJSONObject(name) ?: return 0
        return v.optString("integerValue").toLongOrNull()
            ?: v.optDouble("doubleValue", 0.0).toLong()
    }
}
