package com.runonphone.app.ui

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings as AndroidSettings
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.runonphone.app.core.Phase
import com.runonphone.app.core.ProcessManager
import com.runonphone.app.core.Project
import com.runonphone.app.core.ProjectStore
import com.runonphone.app.core.RunState
import com.runonphone.app.core.Settings
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProjectsScreen(onOpenLogs: (String) -> Unit) {
    val context = LocalContext.current
    val projects by ProjectStore.projects.collectAsStateWithLifecycle()
    val states by ProcessManager.states.collectAsStateWithLifecycle()
    var showAdd by remember { mutableStateOf(false) }
    var showSettings by remember { mutableStateOf(false) }
    var permTick by remember { mutableStateOf(0) }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }

    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { permTick++ }
    LaunchedEffect(Unit) {
        while (true) {
            now = System.currentTimeMillis()
            delay(1000)
        }
    }

    val notifLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { permTick++ }
    val ensureNotificationPermission = {
        if (needsNotificationPermission(context)) notifLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    LaunchedEffect(Unit) {
        if (!Settings(context).isConfigured) showSettings = true
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    val running = states.values.count { it.phase == Phase.RUNNING }
                    Column {
                        Text("הפרויקטים שלי")
                        Text(
                            if (running == 0) "שום דבר לא רץ כרגע" else "רצים כעת: $running",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                },
                actions = {
                    IconButton(onClick = { showSettings = true }) {
                        Icon(Icons.Default.Settings, contentDescription = "הגדרות")
                    }
                },
            )
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = { showAdd = true },
                icon = { Icon(Icons.Default.Add, null) },
                text = { Text("הוסף פרויקט") },
            )
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 4.dp, bottom = 96.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            item(key = "perm-$permTick") {
                PermissionsBanner(context, onRequestNotifications = ensureNotificationPermission)
            }
            if (projects.isEmpty()) {
                item {
                    Text(
                        "אין עדיין פרויקטים.\nלחץ על \"הוסף פרויקט\" והזן את הקוד בן 6 הספרות שקיבלת מ-Claude.",
                        modifier = Modifier.fillMaxWidth().padding(top = 48.dp),
                        textAlign = TextAlign.Center,
                        style = MaterialTheme.typography.bodyLarge,
                    )
                }
            }
            items(projects, key = { it.code }) { project ->
                ProjectCard(
                    project = project,
                    state = states[project.code] ?: RunState(),
                    now = now,
                    onStart = {
                        ensureNotificationPermission()
                        ProcessManager.start(project.code)
                    },
                    onOpenLogs = { onOpenLogs(project.code) },
                )
            }
        }
    }

    if (showAdd) AddProjectDialog(onDismiss = { showAdd = false })
    if (showSettings) SettingsDialog(onDismiss = { showSettings = false })
}

private fun needsNotificationPermission(context: Context) =
    Build.VERSION.SDK_INT >= 33 &&
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED

private fun isIgnoringBatteryOptimizations(context: Context) =
    context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName)

@SuppressLint("BatteryLife")
private fun requestBatteryExemption(context: Context) {
    val intent = Intent(AndroidSettings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))
    runCatching { context.startActivity(intent) }.onFailure {
        context.startActivity(Intent(AndroidSettings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
    }
}

@Composable
private fun PermissionsBanner(context: Context, onRequestNotifications: () -> Unit) {
    val needNotif = needsNotificationPermission(context)
    val needBattery = !isIgnoringBatteryOptimizations(context)
    if (!needNotif && !needBattery) return
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("כדי שהפרויקטים ירוצו ברקע בלי הפרעה:", style = MaterialTheme.typography.titleSmall)
            if (needBattery) {
                Text("• יש לאשר לאפליקציה לפעול בלי הגבלת סוללה.")
                Button(onClick = { requestBatteryExemption(context) }) { Text("אשר פעילות ברקע") }
            }
            if (needNotif) {
                Text("• יש לאשר התראות (מציגות מה רץ, ומונעות מהמערכת לעצור את האפליקציה).")
                Button(onClick = onRequestNotifications) { Text("אשר התראות") }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ProjectCard(
    project: Project,
    state: RunState,
    now: Long,
    onStart: () -> Unit,
    onOpenLogs: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var menu by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf<String?>(null) }
    val active = project.wantRunning || state.phase != Phase.STOPPED

    Card(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(project.manifest.name, style = MaterialTheme.typography.titleMedium)
                    Text(
                        "קוד ${project.code} · גרסה ${project.installedVersion} · פורט ${project.port}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                StatusChip(state)
                Box {
                    IconButton(onClick = { menu = true }) { Icon(Icons.Default.MoreVert, "עוד") }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        DropdownMenuItem(text = { Text("בדוק עדכון") }, onClick = {
                            menu = false
                            busy = "מעדכן…"
                            scope.launch {
                                val msg = runCatching { ProcessManager.update(project.code) {} }
                                    .fold({ if (it) "עודכן לגרסה החדשה" else "כבר בגרסה האחרונה" }, { "שגיאה: ${it.message}" })
                                busy = null
                                Toast.makeText(context, msg, Toast.LENGTH_LONG).show()
                            }
                        })
                        DropdownMenuItem(text = { Text("הפעל מחדש") }, onClick = {
                            menu = false
                            ProcessManager.restart(project.code)
                        })
                        DropdownMenuItem(text = { Text("מחק פרויקט") }, onClick = {
                            menu = false
                            confirmDelete = true
                        })
                    }
                }
            }
            if (project.manifest.description.isNotBlank()) {
                Text(project.manifest.description, style = MaterialTheme.typography.bodyMedium)
            }
            state.message?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            }
            if (state.phase == Phase.RUNNING && state.startedAt != null) {
                Text(
                    "פועל " + formatDuration(now - state.startedAt) +
                        if (state.restarts > 0) " · הופעל מחדש ${state.restarts} פעמים" else "",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            busy?.let {
                Text(it, style = MaterialTheme.typography.bodySmall)
                LinearProgressIndicator(Modifier.fillMaxWidth())
            }

            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (active) {
                    Button(
                        onClick = { ProcessManager.stop(project.code) },
                        colors = androidx.compose.material3.ButtonDefaults.buttonColors(
                            containerColor = MaterialTheme.colorScheme.error,
                        ),
                    ) { Text("עצור") }
                } else {
                    Button(onClick = onStart, enabled = busy == null) { Text("הרצה") }
                }
                OutlinedButton(onClick = onOpenLogs) { Text("לוגים") }
                project.manifest.ui.forEach { link ->
                    FilledTonalButton(onClick = {
                        context.startActivity(
                            WebPanelActivity.intent(context, link.label, link.resolve(project.port)),
                        )
                    }) { Text(link.label) }
                }
            }
            if (project.manifest.ui.any { it.url == null }) {
                lanAddress()?.let { ip ->
                    Text(
                        "גישה ממחשב באותה רשת: http://$ip:${project.port}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }

    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("למחוק את ${project.manifest.name}?") },
            text = { Text("הקוד וכל הנתונים שלו בטלפון (כולל חיבור לוואטסאפ, אם יש) יימחקו. הקוד בענן לא נמחק, ואפשר להוסיף שוב עם אותו קוד.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmDelete = false
                    scope.launch { ProcessManager.delete(project.code) }
                }) { Text("מחק", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("ביטול") } },
        )
    }
}

@Composable
private fun StatusChip(state: RunState) {
    val (label, color) = when (state.phase) {
        Phase.RUNNING -> "רץ" to Color(0xFF2E7D32)
        Phase.STARTING -> "מופעל…" to Color(0xFF1565C0)
        Phase.UPDATING -> "מתעדכן…" to Color(0xFF1565C0)
        Phase.RESTARTING -> "קרס, מנסה שוב" to Color(0xFFE65100)
        Phase.ERROR -> "שגיאה" to Color(0xFFC62828)
        Phase.STOPPED -> "עצור" to Color(0xFF757575)
    }
    AssistChip(onClick = {}, label = { Text(label, color = color) })
}

private fun formatDuration(ms: Long): String {
    val s = ms / 1000
    val d = s / 86400
    val h = (s % 86400) / 3600
    val m = (s % 3600) / 60
    return when {
        d > 0 -> "${d} ימים ${h} שע׳"
        h > 0 -> "${h} שע׳ ${m} דק׳"
        m > 0 -> "${m} דק׳"
        else -> "${s} שנ׳"
    }
}

@Composable
private fun AddProjectDialog(onDismiss: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var code by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var progress by remember { mutableStateOf<Float?>(null) }

    AlertDialog(
        onDismissRequest = { if (progress == null) onDismiss() },
        title = { Text("הוספת פרויקט") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("הזן את הקוד בן 6 הספרות ש-Claude נתן לך:")
                OutlinedTextField(
                    value = code,
                    onValueChange = { v -> code = v.filter(Char::isDigit).take(6); error = null },
                    singleLine = true,
                    enabled = progress == null,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                    textStyle = MaterialTheme.typography.headlineSmall.copy(
                        fontFamily = FontFamily.Monospace,
                        textAlign = TextAlign.Center,
                    ),
                    modifier = Modifier.fillMaxWidth(),
                )
                progress?.let {
                    Text("מוריד ומתקין…")
                    LinearProgressIndicator(progress = { it }, modifier = Modifier.fillMaxWidth())
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = {
            TextButton(
                enabled = code.length == 6 && progress == null,
                onClick = {
                    progress = 0f
                    scope.launch {
                        runCatching {
                            ProcessManager.add(code) { p -> scope.launch { progress = p } }
                        }.onSuccess { name ->
                            Toast.makeText(context, "\"$name\" נוסף. לחץ הרצה כדי להפעיל.", Toast.LENGTH_LONG).show()
                            onDismiss()
                        }.onFailure {
                            progress = null
                            error = it.message ?: it.toString()
                        }
                    }
                },
            ) { Text("הוסף") }
        },
        dismissButton = {
            TextButton(enabled = progress == null, onClick = onDismiss) { Text("ביטול") }
        },
    )
}

@Composable
private fun SettingsDialog(onDismiss: () -> Unit) {
    val context = LocalContext.current
    val settings = remember { Settings(context) }
    val scope = rememberCoroutineScope()
    var projectId by remember { mutableStateOf(settings.firebaseProjectId) }
    var apiKey by remember { mutableStateOf(settings.firebaseApiKey) }
    var testOutput by remember { mutableStateOf<String?>(null) }
    var testing by remember { mutableStateOf(false) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("הגדרות") },
        text = {
            Column(
                Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text("חיבור ל-Firebase (מאיפה מורידים את הפרויקטים):", style = MaterialTheme.typography.titleSmall)
                OutlinedTextField(
                    value = projectId, onValueChange = { projectId = it },
                    label = { Text("Project ID") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = apiKey, onValueChange = { apiKey = it },
                    label = { Text("Web API Key") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                )
                Text("Node.js: ${ProcessManager.runtimeVersion()}", style = MaterialTheme.typography.bodySmall)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedButton(enabled = !testing, onClick = {
                        testing = true
                        scope.launch {
                            testOutput = withContext(Dispatchers.IO) {
                                runCatching { ProcessManager.selfTest() }.getOrElse { "שגיאה: ${it.message}" }
                            }
                            testing = false
                        }
                    }) { Text("בדוק ש-Node עובד") }
                    if (testing) {
                        Spacer(Modifier.width(10.dp))
                        CircularProgressIndicator(Modifier.size(20.dp))
                    }
                }
                testOutput?.let {
                    Text(it, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
                }
                OutlinedButton(onClick = {
                    context.startActivity(
                        Intent(AndroidSettings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")),
                    )
                }) { Text("הגדרות האפליקציה במערכת") }
                Text(
                    "טיפ: בטלפונים של Samsung/Xiaomi כדאי גם לאפשר \"הפעלה אוטומטית\" ולהגדיר סוללה ל\"ללא הגבלה\" עבור האפליקציה.",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        },
        confirmButton = {
            TextButton(onClick = {
                settings.firebaseProjectId = projectId
                settings.firebaseApiKey = apiKey
                onDismiss()
            }) { Text("שמור") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("סגור") } },
    )
}
