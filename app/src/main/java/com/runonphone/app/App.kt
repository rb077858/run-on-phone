package com.runonphone.app

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import com.runonphone.app.core.ProcessManager
import com.runonphone.app.core.ProjectStore

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        ProjectStore.init(this)
        ProcessManager.init(this)
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(
                CHANNEL_RUNNER,
                "פרויקטים רצים",
                NotificationManager.IMPORTANCE_LOW,
            ).apply { description = "מציג אילו פרויקטים רצים ברקע" },
        )
    }

    companion object {
        const val CHANNEL_RUNNER = "runner"
    }
}
