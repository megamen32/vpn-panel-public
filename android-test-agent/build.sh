#!/usr/bin/env bash
# Dependency-free APK build using an Android SDK already installed on the runner.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -n "${ANDROID_SDK_ROOT:-}" ]]; then
  SDK_ROOT="$ANDROID_SDK_ROOT"
elif [[ -n "${ANDROID_HOME:-}" ]]; then
  SDK_ROOT="$ANDROID_HOME"
elif [[ -f "$HOME/Android/Sdk/platforms/android-36/android.jar" ]]; then
  SDK_ROOT="$HOME/Android/Sdk"
else
  SDK_ROOT="/usr/lib/android-sdk"
fi
BUILD_TOOLS="${BUILD_TOOLS:-$SDK_ROOT/build-tools/35.0.0}"
ANDROID_JAR="${ANDROID_JAR:-$SDK_ROOT/platforms/android-36/android.jar}"
if [[ ! -f "$ANDROID_JAR" ]]; then
  echo "Android platform jar not found: $ANDROID_JAR" >&2
  exit 1
fi
OUT="$SCRIPT_DIR/build"
rm -rf "$OUT"
mkdir -p "$OUT/classes" "$OUT/dex"

javac -source 17 -target 17 -encoding UTF-8 -classpath "$ANDROID_JAR" -d "$OUT/classes" \
  "$SCRIPT_DIR/src/com/bezrabotnyi/vpntestagent/VpnTestInstrumentation.java" \
  "$SCRIPT_DIR/src/com/bezrabotnyi/vpntestagent/CellularForwarderService.java" \
  "$SCRIPT_DIR/src/com/bezrabotnyi/vpntestagent/BenchmarkDeviceReceiver.java" \
  "$SCRIPT_DIR/src/com/bezrabotnyi/vpntestagent/BenchmarkDeviceService.java"
jar cf "$OUT/classes.jar" -C "$OUT/classes" .
"$BUILD_TOOLS/d8" --lib "$ANDROID_JAR" --output "$OUT/dex" "$OUT/classes.jar"
"$BUILD_TOOLS/aapt2" link -I "$ANDROID_JAR" --manifest "$SCRIPT_DIR/AndroidManifest.xml" -o "$OUT/unsigned.apk"
(cd "$OUT/dex" && zip -q "$OUT/unsigned.apk" classes.dex)
"$BUILD_TOOLS/zipalign" -f 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"
KEYSTORE="${VPN_TEST_KEYSTORE:-$HOME/.android/vpn-test-agent.keystore}"
if [[ ! -f "$KEYSTORE" ]]; then
  keytool -genkeypair -keystore "$KEYSTORE" -storepass android -keypass android -alias vpntest \
    -dname "CN=VPN Test Agent" -keyalg RSA -keysize 2048 -validity 3650 >/dev/null
fi
"$BUILD_TOOLS/apksigner" sign --ks "$KEYSTORE" --ks-pass pass:android --key-pass pass:android \
  --out "$OUT/vpn-test-agent.apk" "$OUT/aligned.apk"
echo "$OUT/vpn-test-agent.apk"
