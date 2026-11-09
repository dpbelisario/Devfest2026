plugins {
 id("com.android.application") version "8.9.2" apply false
 id("com.android.library") version "8.9.2" apply false
 id("org.jetbrains.kotlin.multiplatform") version "2.2.20" apply false
 id("org.jetbrains.kotlin.android") version "2.2.20" apply false
 id("org.jetbrains.kotlin.plugin.compose") version "2.2.20" apply false
 // Applied by :app only when app/google-services.json exists (docs/push-notifications.md).
 id("com.google.gms.google-services") version "4.4.2" apply false
}
