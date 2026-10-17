package com.runonphone.app.core

import android.content.Context
import com.runonphone.app.BuildConfig

/** Firebase connection settings. Defaults come from firebase.properties at build time. */
class Settings(context: Context) {
    private val prefs = context.getSharedPreferences("settings", Context.MODE_PRIVATE)

    var firebaseProjectId: String
        get() = prefs.getString(KEY_PROJECT, null)?.ifBlank { null } ?: BuildConfig.FIREBASE_PROJECT_ID
        set(v) = prefs.edit().putString(KEY_PROJECT, v.trim()).apply()

    var firebaseApiKey: String
        get() = prefs.getString(KEY_API, null)?.ifBlank { null } ?: BuildConfig.FIREBASE_API_KEY
        set(v) = prefs.edit().putString(KEY_API, v.trim()).apply()

    val isConfigured get() = firebaseProjectId.isNotBlank() && firebaseApiKey.isNotBlank()

    fun client() = FirestoreClient(firebaseProjectId, firebaseApiKey)

    private companion object {
        const val KEY_PROJECT = "firebaseProjectId"
        const val KEY_API = "firebaseApiKey"
    }
}
