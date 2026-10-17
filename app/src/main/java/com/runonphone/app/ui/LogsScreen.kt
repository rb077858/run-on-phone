package com.runonphone.app.ui

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.runonphone.app.core.LogWriter
import com.runonphone.app.core.ProcessManager
import com.runonphone.app.core.ProjectStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LogsScreen(code: String, onBack: () -> Unit) {
    val projects by ProjectStore.projects.collectAsStateWithLifecycle()
    val name = projects.firstOrNull { it.code == code }?.manifest?.name ?: code
    var text by remember { mutableStateOf("") }
    var follow by remember { mutableStateOf(true) }
    val vScroll = rememberScrollState()

    LaunchedEffect(code) {
        while (true) {
            text = withContext(Dispatchers.IO) { LogWriter.tail(ProcessManager.logFile(code)) }
            delay(1000)
        }
    }
    LaunchedEffect(text, follow) {
        if (follow) vScroll.scrollTo(vScroll.maxValue)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("לוגים · $name") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "חזרה") }
                },
                actions = {
                    TextButton(onClick = { follow = !follow }) { Text(if (follow) "עצור גלילה" else "גלול לסוף") }
                    TextButton(onClick = { ProcessManager.clearLog(code); text = "" }) { Text("נקה") }
                },
            )
        },
    ) { padding ->
        CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
            SelectionContainer(
                Modifier.fillMaxSize().padding(padding).verticalScroll(vScroll).horizontalScroll(rememberScrollState()),
            ) {
                Text(
                    text.ifEmpty { "(אין עדיין פלט)" },
                    modifier = Modifier.padding(10.dp),
                    fontFamily = FontFamily.Monospace,
                    fontSize = 11.sp,
                    lineHeight = 14.sp,
                    style = MaterialTheme.typography.bodySmall,
                    softWrap = false,
                )
            }
        }
    }
}
