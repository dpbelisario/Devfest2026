pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement {
 repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
 repositories {
  google(); mavenCentral()
  maven {
   url = uri("https://dl.cloudsmith.io/public/indooratlas/mvn-public/maven/")
   content { includeGroup("com.indooratlas.android") }
  }
 }
}
rootProject.name = "Contour"
include(":app")
include(":shared")
