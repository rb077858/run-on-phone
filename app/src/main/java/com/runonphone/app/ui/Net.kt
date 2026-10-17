package com.runonphone.app.ui

import java.net.Inet4Address
import java.net.NetworkInterface

/** The phone's local-network IPv4 address (e.g. on Wi-Fi), or null. */
fun lanAddress(): String? = runCatching {
    NetworkInterface.getNetworkInterfaces().toList()
        .filter { it.isUp && !it.isLoopback }
        .sortedBy { if (it.name.startsWith("wlan")) 0 else 1 }
        .flatMap { it.inetAddresses.toList() }
        .filterIsInstance<Inet4Address>()
        .firstOrNull { it.isSiteLocalAddress }
        ?.hostAddress
}.getOrNull()
