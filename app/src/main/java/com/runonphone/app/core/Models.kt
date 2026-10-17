package com.runonphone.app.core

import org.json.JSONArray
import org.json.JSONObject

/** A button the project offers, e.g. an admin panel served by the project itself. */
data class UiLink(
    val label: String,
    /** Path on the project's local HTTP server, e.g. "/admin". Used when [url] is null. */
    val path: String?,
    /** Absolute URL (for panels hosted elsewhere). */
    val url: String?,
) {
    fun resolve(port: Int): String = url ?: ("http://127.0.0.1:$port" + (path ?: "/"))

    fun toJson(): JSONObject = JSONObject().apply {
        put("label", label)
        path?.let { put("path", it) }
        url?.let { put("url", it) }
    }

    companion object {
        fun fromJson(o: JSONObject) = UiLink(
            label = o.optString("label", "פתח"),
            path = o.optString("path").ifBlank { null },
            url = o.optString("url").ifBlank { null },
        )
    }
}

/** The project description published from the PC (run-on-phone.json, minus build-only fields). */
data class Manifest(
    val name: String,
    val description: String,
    val entry: String,
    val args: List<String>,
    val nodeOptions: List<String>,
    val env: Map<String, String>,
    val ui: List<UiLink>,
    val raw: String,
) {
    companion object {
        fun parse(json: String): Manifest {
            val o = JSONObject(json)
            return Manifest(
                name = o.optString("name", "פרויקט"),
                description = o.optString("description", ""),
                entry = o.optString("entry", "index.js"),
                args = o.optJSONArray("args").toStringList(),
                nodeOptions = o.optJSONArray("nodeOptions").toStringList(),
                env = o.optJSONObject("env")?.let { e ->
                    e.keys().asSequence().associateWith { e.optString(it) }
                } ?: emptyMap(),
                ui = o.optJSONArray("ui")?.let { a ->
                    (0 until a.length()).mapNotNull { a.optJSONObject(it)?.let(UiLink::fromJson) }
                } ?: emptyList(),
                raw = json,
            )
        }
    }
}

fun JSONArray?.toStringList(): List<String> =
    if (this == null) emptyList() else (0 until length()).map { optString(it) }

data class Project(
    val code: String,
    val manifest: Manifest,
    val installedVersion: Long,
    /** Local port handed to the project as PORT. */
    val port: Int,
    /** True while the user wants it running (survives reboots and crashes). */
    val wantRunning: Boolean,
    val addedAt: Long,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("code", code)
        put("manifest", manifest.raw)
        put("installedVersion", installedVersion)
        put("port", port)
        put("wantRunning", wantRunning)
        put("addedAt", addedAt)
    }

    companion object {
        fun fromJson(o: JSONObject) = Project(
            code = o.getString("code"),
            manifest = Manifest.parse(o.getString("manifest")),
            installedVersion = o.optLong("installedVersion"),
            port = o.getInt("port"),
            wantRunning = o.optBoolean("wantRunning"),
            addedAt = o.optLong("addedAt"),
        )
    }
}

enum class Phase { STOPPED, UPDATING, STARTING, RUNNING, RESTARTING, ERROR }

data class RunState(
    val phase: Phase = Phase.STOPPED,
    val message: String? = null,
    val startedAt: Long? = null,
    val restarts: Int = 0,
)
