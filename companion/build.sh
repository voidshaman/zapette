#!/usr/bin/env bash
# Builds the companion APK with the SDK command-line tools only: aapt2 + javac +
# d8 + zipalign + apksigner. No Gradle, no network, no Kotlin.
#
#   companion/build.sh            -> <repo>/dist/tv-companion.apk
#   companion/build.sh --debug    keeps the intermediate tree at companion/build
#
# Self-locating: JAVA_HOME and the Android SDK are discovered, and a missing one
# fails with a sentence rather than a stack of javac noise.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
build="$here/build"
out="$root/dist/tv-companion.apk"
ks="$HOME/.tv-companion/android.keystore"

debug=0
[ "${1:-}" = "--debug" ] && debug=1

# --- JDK 17 -------------------------------------------------------------------
find_java() {
  local c
  if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/javac" ]; then
    echo "$JAVA_HOME"; return 0
  fi
  for c in "$HOME/.local/jdk/temurin-17/Contents/Home" "$HOME/.local/jdk"/*/Contents/Home \
           /Library/Java/JavaVirtualMachines/*/Contents/Home; do
    if [ -x "$c/bin/javac" ]; then echo "$c"; return 0; fi
  done
  return 1
}

if ! JAVA_HOME="$(find_java)"; then
  echo "build.sh: no JDK found. Set JAVA_HOME, or run scripts/setup-companion-toolchain.sh" >&2
  exit 1
fi
export JAVA_HOME

# --- Android SDK --------------------------------------------------------------
find_sdk() {
  local d
  for d in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" "$HOME/Library/Android/sdk" "$HOME/Android/Sdk"; do
    if [ -n "$d" ] && [ -d "$d/platforms" ] && [ -d "$d/build-tools" ]; then echo "$d"; return 0; fi
  done
  return 1
}

if ! sdk="$(find_sdk)"; then
  echo "build.sh: no Android SDK found. Set ANDROID_HOME, or run scripts/setup-companion-toolchain.sh" >&2
  exit 1
fi

bt="$(ls -d "$sdk"/build-tools/*/ 2>/dev/null | sort -V | tail -1)"
bt="${bt%/}"
platform="$(ls -d "$sdk"/platforms/android-*/ 2>/dev/null | sort -V | tail -1)"
platform="${platform%/}"
android_jar="$platform/android.jar"

for tool in "$bt/aapt2" "$bt/d8" "$bt/zipalign" "$bt/apksigner"; do
  if [ ! -x "$tool" ]; then
    echo "build.sh: missing $tool - install build-tools with sdkmanager" >&2
    exit 1
  fi
done
if [ ! -f "$android_jar" ]; then
  echo "build.sh: missing $android_jar - install a platform with sdkmanager" >&2
  exit 1
fi

echo "JAVA_HOME  $JAVA_HOME"
echo "build-tools $bt"
echo "platform   $platform"

# --- signing key --------------------------------------------------------------
if [ ! -f "$ks" ]; then
  echo "creating keystore $ks"
  mkdir -p "$(dirname "$ks")"
  "$JAVA_HOME/bin/keytool" -genkeypair -keystore "$ks" \
    -storepass android -keypass android -alias tvcompanion \
    -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=tv-companion, O=zapette" >/dev/null
fi

# --- build --------------------------------------------------------------------
rm -rf "$build"
mkdir -p "$build/res" "$build/classes" "$build/dex" "$root/dist"

echo "aapt2 compile"
"$bt/aapt2" compile --dir "$here/res" -o "$build/res/res.zip"

echo "aapt2 link"
"$bt/aapt2" link \
  -o "$build/base.apk" \
  -I "$android_jar" \
  --manifest "$here/AndroidManifest.xml" \
  --min-sdk-version 30 --target-sdk-version 30 \
  "$build/res/res.zip"

echo "javac"
find "$here/src" -name '*.java' > "$build/sources.txt"
"$JAVA_HOME/bin/javac" -nowarn --release 8 -cp "$android_jar" \
  -d "$build/classes" @"$build/sources.txt"

echo "d8"
find "$build/classes" -name '*.class' > "$build/classes.txt"
"$bt/d8" --min-api 30 --lib "$android_jar" --output "$build/dex" @"$build/classes.txt"

echo "package"
(cd "$build/dex" && zip -q -X "$build/base.apk" classes.dex)

echo "zipalign"
"$bt/zipalign" -f -p 4 "$build/base.apk" "$build/aligned.apk"

echo "apksigner"
"$bt/apksigner" sign \
  --ks "$ks" --ks-pass pass:android --key-pass pass:android --ks-key-alias tvcompanion \
  --out "$out" "$build/aligned.apk"

"$bt/apksigner" verify --print-certs "$out" | head -3
[ "$debug" = 1 ] || rm -rf "$build"

echo "built $out ($(du -h "$out" | cut -f1 | tr -d ' '), $(wc -c < "$out" | tr -d ' ') bytes)"
