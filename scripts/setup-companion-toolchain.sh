#!/bin/bash
# Prerequisite install for the companion-APK route (tv-remote-tui).
# x86_64 macOS 26.3: brew's openjdk@17 is Tier 3 (builds from source) -> use the
# Temurin tarball instead. No sudo, lands under ~/.local/jdk.
set -uo pipefail

JDK_DIR="$HOME/.local/jdk"
JH="$JDK_DIR/temurin-17/Contents/Home"
mkdir -p "$JDK_DIR"

if [ ! -x "$JH/bin/javac" ]; then
  echo "=== downloading Temurin 17 (mac x64) ==="
  curl -fL --retry 3 --retry-delay 2 \
    -o /tmp/temurin17.tar.gz \
    "https://api.adoptium.net/v3/binary/latest/17/ga/mac/x64/jdk/hotspot/normal/eclipse"
  echo "download exit=$? size=$(stat -f%z /tmp/temurin17.tar.gz 2>/dev/null)"
  rm -rf "$JDK_DIR"/jdk-17*
  tar xzf /tmp/temurin17.tar.gz -C "$JDK_DIR" || exit 1
  mv "$JDK_DIR"/jdk-17* "$JDK_DIR/temurin-17" || exit 1
fi

echo "=== java ==="
"$JH/bin/java" -version 2>&1
"$JH/bin/javac" -version 2>&1

export JAVA_HOME="$JH"
export PATH="$JH/bin:$PATH"

SDK="$HOME/Library/Android/sdk"
SM="$SDK/cmdline-tools/latest/bin/sdkmanager"
echo "=== sdkmanager ==="
"$SM" --version 2>&1 | tail -2

echo "=== licenses ==="
yes | "$SM" --sdk_root="$SDK" --licenses >/dev/null 2>&1
echo "licenses exit=$?"

echo "=== install build-tools + platform ==="
"$SM" --sdk_root="$SDK" "build-tools;35.0.0" "platforms;android-36" 2>&1 | tail -4

echo "=== build-tools present ==="
ls "$SDK/build-tools" 2>&1
BT=$(ls -d "$SDK"/build-tools/*/ 2>/dev/null | sort -V | tail -1)
echo "BT=$BT"
"$BT/aapt2" version 2>&1
"$BT/d8" --version 2>&1 | head -2
"$BT/apksigner" --version 2>&1
echo "=== DONE ==="
