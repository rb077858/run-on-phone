package com.runonphone.app.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.runonphone.app.core.ProjectStore

/** Restarts the projects that were running before a reboot or an app update. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (ProjectStore.projects.value.any { it.wantRunning }) {
            RunnerService.ensureStarted(context)
        }
    }
}
