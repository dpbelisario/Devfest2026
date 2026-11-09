import java.util.Properties
plugins {
 id("com.android.application")
 id("org.jetbrains.kotlin.android")
 id("org.jetbrains.kotlin.plugin.compose")
}
val local = Properties().apply {
 val file = rootProject.file("local.properties")
 if (file.exists()) file.inputStream().use { load(it) }
}
val apiBaseUrl = local.getProperty("EVACUATION_AR_API_BASE_URL", "https://example.invalid/")
require(apiBaseUrl.startsWith("https://") || apiBaseUrl.startsWith("http://10.0.2.2:")) { "Use HTTPS, or the Android emulator's local debug address." }
require(!apiBaseUrl.contains('"') && !apiBaseUrl.contains('\\')) { "Invalid API URL" }
// Hosted UI page (backend /app/). Set CONTOUR_UI_URL in local.properties, or -PcontourUiUrl in CI.
// Empty means: always use the copy of contour.html bundled in assets.
val uiUrl = providers.gradleProperty("contourUiUrl").orNull ?: local.getProperty("CONTOUR_UI_URL", "")
require(uiUrl.isEmpty() || uiUrl.startsWith("https://")) { "CONTOUR_UI_URL must use https." }
require(!uiUrl.contains('"') && !uiUrl.contains('\\')) { "Invalid CONTOUR_UI_URL" }
fun indoorSetting(name: String) = local.getProperty(name) ?: System.getenv(name).orEmpty()
fun quotedSetting(name: String): String {
 val value = indoorSetting(name)
 require(value.none { it == '"' || it == '\\' || it.isISOControl() }) { "Invalid $name" }
 return "\"$value\""
}
android {
 namespace = "com.contour.app"
 compileSdk = 35
 defaultConfig {
  applicationId = "com.contour.app"
  minSdk = 26
  targetSdk = 35
  // CI passes -PversionCode so each distributed build installs as an update.
  versionCode = providers.gradleProperty("versionCode").orNull?.toInt() ?: 1
  versionName = "0.1.0"
  buildConfigField("String", "API_BASE_URL", "\"$apiBaseUrl\"")
  buildConfigField("String", "UI_URL", "\"$uiUrl\"")
  buildConfigField("String", "INDOORATLAS_VENUE_ID", quotedSetting("INDOORATLAS_VENUE_ID"))
  buildConfigField("String", "INDOORATLAS_ROOM221_POI_ID", quotedSetting("INDOORATLAS_ROOM221_POI_ID"))
  buildConfigField("boolean", "INDOORATLAS_AR_FUSION", (indoorSetting("INDOORATLAS_AR_FUSION") == "true").toString())
  manifestPlaceholders["indoorAtlasApiKey"] = indoorSetting("INDOORATLAS_API_KEY")
  manifestPlaceholders["indoorAtlasApiSecret"] = indoorSetting("INDOORATLAS_API_SECRET")
  buildConfigField("boolean", "INDOORATLAS_CONFIGURED", (indoorSetting("INDOORATLAS_API_KEY").isNotBlank() && indoorSetting("INDOORATLAS_API_SECRET").isNotBlank() && indoorSetting("INDOORATLAS_VENUE_ID").isNotBlank()).toString())
  testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
 }
 buildFeatures { compose = true; buildConfig = true }
 compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
 kotlinOptions { jvmTarget = "17" }
}
dependencies {
 implementation(project(":shared"))
 implementation(platform("androidx.compose:compose-bom:2025.04.01"))
 implementation("androidx.activity:activity-compose:1.10.1")
 implementation("androidx.compose.material3:material3")
 implementation("androidx.compose.ui:ui-tooling-preview")
 debugImplementation("androidx.compose.ui:ui-tooling")
 implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.0")
 implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.0")
 implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
 implementation("org.jetbrains.kotlinx:kotlinx-coroutines-play-services:1.10.2")
 implementation("com.google.ar:core:1.48.0")
 implementation("com.google.mlkit:translate:17.0.3")
 implementation("androidx.webkit:webkit:1.12.1")
 implementation("com.indooratlas.android:indooratlas-android-sdk:3.8.1@aar")
 testImplementation("junit:junit:4.13.2")
 androidTestImplementation("androidx.test.ext:junit:1.2.1")
 androidTestImplementation("androidx.test:runner:1.6.2")
}
