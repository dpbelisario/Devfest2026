import java.util.Properties

plugins {
    id("com.android.application")
}

// Hosted UI page (backend /app/). Set CONTOUR_UI_URL in local.properties, or -PcontourUiUrl in CI.
// Empty means: always use the copy of contour.html bundled in assets.
val localProps = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}
val uiUrl = providers.gradleProperty("contourUiUrl").orNull
    ?: localProps.getProperty("CONTOUR_UI_URL", "")
require(uiUrl.isEmpty() || uiUrl.startsWith("https://")) { "CONTOUR_UI_URL must use https." }
require(!uiUrl.contains('"') && !uiUrl.contains('\\')) { "Invalid CONTOUR_UI_URL" }

android {
    namespace = "com.contour.app"
    compileSdk {
        version = release(37) {
            minorApiLevel = 0
        }
    }

    defaultConfig {
        // Same id as the Firebase App Distribution app, so CI builds install as updates.
        applicationId = "com.contour.app"
        minSdk = 26
        targetSdk = 36
        // CI passes -PversionCode so each distributed build installs as an update.
        versionCode = providers.gradleProperty("versionCode").orNull?.toInt() ?: 1
        versionName = "1.0"
        buildConfigField("String", "UI_URL", "\"$uiUrl\"")
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.19.1")
    implementation("androidx.activity:activity-ktx:1.13.0")
    implementation("androidx.webkit:webkit:1.18.0")
}
