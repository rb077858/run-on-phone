package com.runonphone.app.service

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.runonphone.app.App
import com.runonphone.app.R
import com.runonphone.app.core.ProcessManager
import com.runonphone.app.core.ProjectStore
import com.runonphone.app.ui.MainActivity
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/**
 * Foreground service that keeps the app process (and therefore the node child
 * processes) alive in the background, holding a wake lock while anything runs.
 */
class RunnerService : Service() {
    private val scope = MainScope()
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        goForeground(buildNotification(emptyList()))
        acquireLocks()
        scope.launch {
            combine(ProcessManager.active, ProjectStore.projects) { active, projects ->
                active to projects
            }.collect { (active, projects) ->
                val names = projects.filter { it.code in active }.map { it.manifest.name }
                val manager = getSystemService(android.app.NotificationManager::class.java)
                manager.notify(NOTIFICATION_ID, buildNotification(names))
                if (active.isEmpty() && projects.none { it.wantRunning }) {
                    stopSelf()
                }
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        goForeground(buildNotification(currentNames()))
        if (intent?.action == ACTION_STOP_ALL) {
            ProcessManager.stopAll()
        } else {
            ProcessManager.resumeAll()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        wakeLock?.takeIf { it.isHeld }?.release()
        wifiLock?.takeIf { it.isHeld }?.release()
        super.onDestroy()
    }

    private fun currentNames(): List<String> {
        val active = ProcessManager.active.value
        return ProjectStore.projects.value.filter { it.code in active }.map { it.manifest.name }
    }

    private fun goForeground(notification: Notification) {
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            notification,
            ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
        )
    }

    @Suppress("DEPRECATION")
    private fun acquireLocks() {
        wakeLock = getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "RunOnPhone::runner")
            .apply { setReferenceCounted(false); acquire() }
        wifiLock = (applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager)
            .createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "RunOnPhone::wifi")
            .apply { setReferenceCounted(false); acquire() }
    }

    private fun buildNotification(names: List<String>): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val stopAll = PendingIntent.getService(
            this, 1, Intent(this, RunnerService::class.java).setAction(ACTION_STOP_ALL),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val title = when (names.size) {
            0 -> "מוכן"
            1 -> "פרויקט אחד רץ"
            else -> "${names.size} פרויקטים רצים"
        }
        return NotificationCompat.Builder(this, App.CHANNEL_RUNNER)
            .setSmallIcon(R.drawable.ic_stat_run)
            .setContentTitle(title)
            .setContentText(names.joinToString(", "))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(open)
            .addAction(0, "עצור הכל", stopAll)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    companion object {
        private const val NOTIFICATION_ID = 1
        private const val ACTION_STOP_ALL = "com.runonphone.app.STOP_ALL"

        fun ensureStarted(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, RunnerService::class.java))
        }
    }
}
