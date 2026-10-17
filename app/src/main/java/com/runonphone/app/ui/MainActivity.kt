package com.runonphone.app.ui

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import com.runonphone.app.core.ProcessManager

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // In case the app process was killed while projects were meant to run.
        ProcessManager.resumeAll()
        setContent {
            AppTheme {
                var logsFor by rememberSaveable { mutableStateOf<String?>(null) }
                val code = logsFor
                if (code == null) {
                    ProjectsScreen(onOpenLogs = { logsFor = it })
                } else {
                    BackHandler { logsFor = null }
                    LogsScreen(code = code, onBack = { logsFor = null })
                }
            }
        }
    }
}
