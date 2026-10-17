package com.runonphone.app.core

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONArray
import java.io.File

/** The list of installed projects, persisted to files/projects.json. */
object ProjectStore {
    private lateinit var file: File
    private val _projects = MutableStateFlow<List<Project>>(emptyList())
    val projects: StateFlow<List<Project>> = _projects

    const val FIRST_PORT = 3101

    fun init(context: Context) {
        file = File(context.filesDir, "projects.json")
        _projects.value = runCatching {
            val a = JSONArray(file.readText())
            (0 until a.length()).map { Project.fromJson(a.getJSONObject(it)) }
        }.getOrDefault(emptyList())
    }

    fun get(code: String): Project? = _projects.value.firstOrNull { it.code == code }

    @Synchronized
    fun upsert(project: Project) {
        val list = _projects.value.toMutableList()
        val i = list.indexOfFirst { it.code == project.code }
        if (i >= 0) list[i] = project else list.add(project)
        save(list)
    }

    @Synchronized
    fun update(code: String, change: (Project) -> Project) {
        val current = get(code) ?: return
        upsert(change(current))
    }

    @Synchronized
    fun remove(code: String) = save(_projects.value.filterNot { it.code == code })

    @Synchronized
    fun nextFreePort(): Int {
        val used = _projects.value.map { it.port }.toSet()
        var p = FIRST_PORT
        while (p in used) p++
        return p
    }

    private fun save(list: List<Project>) {
        _projects.value = list
        val tmp = File(file.parentFile, file.name + ".tmp")
        tmp.writeText(JSONArray(list.map { it.toJson() }).toString(2))
        tmp.renameTo(file)
    }
}
