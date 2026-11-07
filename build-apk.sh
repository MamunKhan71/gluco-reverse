#!/usr/bin/env bash
# Builds the Android app: android/app/build/outputs/apk/debug/app-debug.apk
set -e
cd "$(dirname "$0")"
export JAVA_HOME="${JAVA_HOME:-$(ls -d "$LOCALAPPDATA"/Java/jdk-21* | head -1)}"
export ANDROID_HOME="${ANDROID_HOME:-$LOCALAPPDATA/Android/Sdk}"
npx cap sync android
cd android && ./gradlew assembleDebug --console=plain
cp app/build/outputs/apk/debug/app-debug.apk ../sugar-helper.apk
echo "APK: $(cd .. && pwd)/sugar-helper.apk"
