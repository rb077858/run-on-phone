import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

val firebaseProps = Properties().apply {
    val f = rootProject.file("firebase.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

fun quoted(value: String?): String = "\"" + (value ?: "").trim().replace("\"", "\\\"") + "\""

android {
    namespace = "com.runonphone.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.runonphone.app"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"

        buildConfigField("String", "FIREBASE_PROJECT_ID", quoted(firebaseProps.getProperty("projectId")))
        buildConfigField("String", "FIREBASE_API_KEY", quoted(firebaseProps.getProperty("apiKey")))

        // The bundled Node.js runtime is built for 64-bit ARM only.
        ndk { abiFilters += "arm64-v8a" }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Signed with the debug key so a release build can be installed directly.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        jniLibs {
            // libnode.so is really the node executable. It and its libraries must be
            // extracted to nativeLibraryDir (the only place Android lets an app exec
            // binaries from) and must not be stripped (they are patched ELF files).
            useLegacyPackaging = true
            keepDebugSymbols += "**/*.so"
        }
    }

    lint {
        disable += setOf("GradleDependency", "NewerVersionAvailable", "AndroidGradlePluginVersion", "OldTargetApi")
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

// Downloads the Node.js runtime (tools/fetch-runtime.mjs) when it is missing.
val fetchNodeRuntime by tasks.registering(Exec::class) {
    val marker = file("src/main/jniLibs/arm64-v8a/libnode.so")
    onlyIf { !marker.exists() }
    workingDir = rootProject.projectDir
    commandLine("node", "tools/fetch-runtime.mjs")
}
tasks.named("preBuild") { dependsOn(fetchNodeRuntime) }

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.foundation)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.core)
    implementation(libs.kotlinx.coroutines.android)

    debugImplementation(libs.androidx.compose.ui.tooling)
}
