package com.runonphone.app.ui

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView

/** Shows a project's web panel (admin, sign-up, WhatsApp QR...) in a WebView. */
class WebPanelActivity : ComponentActivity() {
    @OptIn(ExperimentalMaterial3Api::class)
    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val url = intent.getStringExtra(EXTRA_URL) ?: return finish()
        val title = intent.getStringExtra(EXTRA_TITLE).orEmpty()

        setContent {
            AppTheme {
                var webView by remember { mutableStateOf<WebView?>(null) }
                BackHandler {
                    val w = webView
                    if (w != null && w.canGoBack()) w.goBack() else finish()
                }
                Scaffold(
                    topBar = {
                        TopAppBar(
                            title = { Text(title) },
                            navigationIcon = {
                                IconButton(onClick = { finish() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "סגור") }
                            },
                            actions = {
                                IconButton(onClick = { webView?.reload() }) { Icon(Icons.Default.Refresh, "רענן") }
                                TextButton(onClick = {
                                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(webView?.url ?: url)))
                                }) { Text("בדפדפן") }
                            },
                        )
                    },
                ) { padding ->
                    AndroidView(
                        modifier = Modifier.fillMaxSize().padding(padding),
                        factory = { ctx ->
                            WebView(ctx).apply {
                                settings.javaScriptEnabled = true
                                settings.domStorageEnabled = true
                                settings.loadWithOverviewMode = true
                                settings.useWideViewPort = true
                                webViewClient = object : WebViewClient() {
                                    override fun onReceivedError(
                                        view: WebView, request: WebResourceRequest, error: WebResourceError,
                                    ) {
                                        if (request.isForMainFrame) {
                                            view.loadDataWithBaseURL(
                                                null,
                                                "<html dir='rtl'><body style='font-family:sans-serif;padding:24px'>" +
                                                    "<h3>הדף לא נטען</h3><p>${error.description}</p>" +
                                                    "<p>ודא שהפרויקט רץ (לחץ הרצה), חכה כמה שניות ולחץ רענן.</p>" +
                                                    "<p dir='ltr'>$url</p></body></html>",
                                                "text/html", "utf-8", url,
                                            )
                                        }
                                    }
                                }
                                loadUrl(url)
                                webView = this
                            }
                        },
                    )
                }
            }
        }
    }

    companion object {
        private const val EXTRA_URL = "url"
        private const val EXTRA_TITLE = "title"

        fun intent(context: Context, title: String, url: String) =
            Intent(context, WebPanelActivity::class.java)
                .putExtra(EXTRA_URL, url)
                .putExtra(EXTRA_TITLE, title)
    }
}
