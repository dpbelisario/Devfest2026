#!/bin/sh
set -eu
if [ -z "${JAVA_HOME:-}" ]; then
    JAVA_HOME=$(/usr/libexec/java_home -v 17 2>/dev/null) || JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
fi
if [ ! -x "$JAVA_HOME/bin/java" ]; then
    echo "Set JAVA_HOME to an installed JDK 17 before building Contour." >&2
    exit 1
fi
export JAVA_HOME
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
cd "$SRCROOT/../android"
./gradlew :shared:embedAndSignAppleFrameworkForXcode
