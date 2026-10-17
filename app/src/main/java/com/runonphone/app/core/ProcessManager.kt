package com.runonphone.app.core

import android.content.Context
import com.runonphone.app.service.RunnerService
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * Runs each project as its own `node` child process, restarting it when it exits,
 * until the user stops it. Lives as long as the app process; [RunnerService] keeps
 * that process alive in the background.
 */
object ProcessManager {
    private lateinit var ctx: Context
    private lateinit var paths: Paths
    private lateinit var runtime: NodeRuntime

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val jobs = ConcurrentHashMap<String, Job>()
    private val locks = ConcurrentHashMap<String, Mutex>()

    private val _states = MutableStateFlow<Map<String, RunState>>(emptyMap())
    val states: StateFlow<Map<String, RunState>> = _states

    /** Codes of projects whose supervisor is currently active. */
    private val _active = MutableStateFlow<Set<String>>(emptySet())
    val active: StateFlow<Set<String>> = _active

    fun init(context: Context) {
        ctx = context.applicationContext
        paths = Paths(ctx)
        runtime = NodeRuntime(ctx)
    }

    private fun lock(code: String) = locks.getOrPut(code) { Mutex() }

    private fun setState(code: String, state: RunState) = _states.update { it + (code to state) }

    // ---------------------------------------------------------------- running

    /** User pressed "run". */
    fun start(code: String) {
        ProjectStore.update(code) { it.copy(wantRunning = true) }
        RunnerService.ensureStarted(ctx)
        launchSupervisor(code)
    }

    /** User pressed "stop". */
    fun stop(code: String) {
        ProjectStore.update(code) { it.copy(wantRunning = false) }
        jobs[code]?.cancel()
    }

    fun stopAll() = ProjectStore.projects.value.forEach { stop(it.code) }

    fun restart(code: String) {
        scope.launch {
            jobs[code]?.cancelAndJoin()
            start(code)
        }
    }

    /** Starts every project the user left running (after boot, process death, app open). */
    fun resumeAll() {
        val wanted = ProjectStore.projects.value.filter { it.wantRunning }
        if (wanted.isEmpty()) return
        RunnerService.ensureStarted(ctx)
        wanted.forEach { launchSupervisor(it.code) }
    }

    private fun launchSupervisor(code: String) = synchronized(jobs) {
        if (jobs[code]?.isActive == true) return
        _active.update { it + code }
        jobs[code] = scope.launch { supervise(code) }
    }

    private suspend fun supervise(code: String) {
        val self = currentCoroutineContext()[Job]
        val log = LogWriter(paths.logFile(code))
        var process: Process? = null
        var restarts = 0
        var backoffMs = 3_000L
        try {
            setState(code, RunState(Phase.UPDATING, "בודק עדכונים…"))
            try {
                lock(code).withLock { updateIfNewer(code, log) }
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                log.system("בדיקת עדכון נכשלה, מריץ את הגרסה המותקנת: ${e.message}")
            }
            runtime.ensureInstalled()

            while (true) {
                val project = ProjectStore.get(code) ?: return
                setState(code, RunState(Phase.STARTING, restarts = restarts))
                var exitInfo: String
                val startedAt = System.currentTimeMillis()
                try {
                    val p = launchProcess(project, log)
                    process = p
                    setState(code, RunState(Phase.RUNNING, startedAt = startedAt, restarts = restarts))
                    val exit = runInterruptible { p.waitFor() }
                    process = null
                    exitInfo = "קוד יציאה $exit"
                    log.system("התהליך הסתיים ($exitInfo)")
                } catch (e: Exception) {
                    if (e is CancellationException) throw e
                    exitInfo = e.message ?: e.javaClass.simpleName
                    log.system("הפעלה נכשלה: $exitInfo")
                }
                if (System.currentTimeMillis() - startedAt > 60_000) backoffMs = 3_000L
                restarts++
                setState(
                    code,
                    RunState(Phase.RESTARTING, "נעצר ($exitInfo). הפעלה מחדש בעוד ${backoffMs / 1000} שנ׳", restarts = restarts),
                )
                delay(backoffMs)
                backoffMs = (backoffMs * 2).coerceAtMost(60_000L)
            }
        } finally {
            withContext(NonCancellable) {
                process?.let { kill(it, log) }
                log.close()
                setState(code, RunState(Phase.STOPPED))
                synchronized(jobs) {
                    if (jobs[code] === self) {
                        jobs.remove(code)
                        _active.update { it - code }
                    }
                }
            }
        }
    }

    private fun launchProcess(project: Project, log: LogWriter): Process {
        val m = project.manifest
        val appDir = paths.appDir(project.code)
        val entry = File(appDir, m.entry)
        if (!entry.exists()) throw IOException("קובץ הכניסה '${m.entry}' לא נמצא")
        val dataDir = paths.dataDir(project.code).apply { mkdirs() }

        val cmd = buildList {
            add(runtime.nodeBinary.absolutePath)
            addAll(m.nodeOptions)
            add(entry.absolutePath)
            addAll(m.args)
        }
        val pb = ProcessBuilder(cmd).directory(appDir).redirectErrorStream(true)
        pb.environment().apply {
            putAll(runtime.environment())
            putAll(m.env)
            put("PORT", project.port.toString())
            put("DATA_DIR", dataDir.absolutePath)
            put("APP_DIR", appDir.absolutePath)
            put("PROJECT_CODE", project.code)
        }
        log.system("מפעיל ${m.name} v${project.installedVersion}: node ${m.entry} (PORT=${project.port})")
        val p = pb.start()
        Thread({
            val buf = ByteArray(8192)
            runCatching {
                p.inputStream.use { input ->
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        log.write(buf, n)
                    }
                }
            }
        }, "log-${project.code}").apply { isDaemon = true }.start()
        return p
    }

    private fun kill(p: Process, log: LogWriter) {
        p.destroy()
        if (!p.waitFor(5, TimeUnit.SECONDS)) {
            p.destroyForcibly()
            p.waitFor(3, TimeUnit.SECONDS)
        }
        log.system("נעצר")
    }

    // ------------------------------------------------------- install / update

    /** Installs if the cloud has a newer version. Returns true when something was installed. */
    private fun updateIfNewer(code: String, log: LogWriter?, progress: (Float) -> Unit = {}): Boolean {
        val settings = Settings(ctx)
        if (!settings.isConfigured) return false
        val project = ProjectStore.get(code) ?: return false
        val remote = settings.client().getProject(code)
            ?: throw IOException("הפרויקט $code לא נמצא בענן")
        if (remote.version <= project.installedVersion && paths.appDir(code).exists()) return false
        log?.system("מוריד גרסה ${remote.version}…")
        Installer(paths, settings.client()).install(remote, progress)
        ProjectStore.update(code) {
            it.copy(installedVersion = remote.version, manifest = Manifest.parse(remote.manifestJson))
        }
        log?.system("עודכן לגרסה ${remote.version}")
        return true
    }

    /** Downloads and adds a project by its 6-digit code. Returns its name. */
    suspend fun add(code: String, progress: (Float) -> Unit): String = withContext(Dispatchers.IO) {
        lock(code).withLock {
            val settings = Settings(ctx)
            val remote = settings.client().getProject(code)
                ?: throw IOException("לא נמצא פרויקט עם הקוד $code")
            val existing = ProjectStore.get(code)
            if (existing != null) {
                jobs[code]?.cancelAndJoin()
            }
            Installer(paths, settings.client()).install(remote, progress)
            val manifest = Manifest.parse(remote.manifestJson)
            ProjectStore.upsert(
                Project(
                    code = code,
                    manifest = manifest,
                    installedVersion = remote.version,
                    port = existing?.port ?: ProjectStore.nextFreePort(),
                    wantRunning = existing?.wantRunning ?: false,
                    addedAt = existing?.addedAt ?: System.currentTimeMillis(),
                ),
            )
            if (existing?.wantRunning == true) launchSupervisor(code)
            manifest.name
        }
    }

    /** Manual update. Returns true if a newer version was installed. */
    suspend fun update(code: String, progress: (Float) -> Unit): Boolean = withContext(Dispatchers.IO) {
        val wasRunning = jobs[code]?.isActive == true
        jobs[code]?.cancelAndJoin()
        try {
            lock(code).withLock {
                setState(code, RunState(Phase.UPDATING, "מעדכן…"))
                val log = LogWriter(paths.logFile(code))
                try {
                    updateIfNewer(code, log, progress)
                } finally {
                    log.close()
                    setState(code, RunState(Phase.STOPPED))
                }
            }
        } finally {
            if (wasRunning) launchSupervisor(code)
        }
    }

    suspend fun delete(code: String) = withContext(Dispatchers.IO) {
        ProjectStore.update(code) { it.copy(wantRunning = false) }
        jobs[code]?.cancelAndJoin()
        lock(code).withLock {
            paths.projectDir(code).deleteRecursively()
            ProjectStore.remove(code)
            _states.update { it - code }
        }
    }

    fun clearLog(code: String) {
        val f = paths.logFile(code)
        f.writeText("")
        File(f.parentFile, f.name + ".1").delete()
    }

    fun logFile(code: String): File = paths.logFile(code)

    fun selfTest(): String = runtime.selfTest()

    fun runtimeVersion(): String = runtime.version()
}
