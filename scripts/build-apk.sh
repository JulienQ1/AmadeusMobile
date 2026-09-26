#!/usr/bin/env bash
# Builds the Android APK without Gradle: web app (Vite) -> aapt2 -> javac -> dx -> apksig.
#
# Signing key, in order of preference:
#   1. ANDROID_KEYSTORE_BASE64 + ANDROID_KEYSTORE_PASSWORD (+ ANDROID_KEY_ALIAS) environment variables
#   2. android/signing/amadeus-personal.p12 + android/signing/keystore.properties (local only, git-ignored)
#   3. a throwaway key generated in android/build (updates will then need a reinstall)
# Environment: VERSION_CODE, VERSION_NAME (defaults: git commit count, web/package.json version),
#              SKIP_WEB=1 to reuse an existing web/dist.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AND="$ROOT/android"
OUT="$AND/build"
TOOLS="$AND/tools"
MIN_SDK=24
TARGET_SDK=34
VERSION_NAME="${VERSION_NAME:-$(node -p "require('$ROOT/web/package.json').version")}"
VERSION_CODE="${VERSION_CODE:-$(git -C "$ROOT" rev-list --count HEAD 2>/dev/null || echo 1)}"
APK_NAME="${APK_NAME:-RealAmadeusMobile-$VERSION_NAME.apk}"

"$ROOT/scripts/fetch-android-tools.sh"
ANDROID_JAR="$TOOLS/android.jar"
AAPT2="$TOOLS/aapt2"

if [ "${SKIP_WEB:-0}" != "1" ]; then
  echo "[apk] building web app"
  (cd "$ROOT/web" && npm ci --no-audit --no-fund && npm run fetch:live2d && npm test && npm run build)
fi
[ -f "$ROOT/web/dist/index.html" ] || { echo "[apk] web/dist missing" >&2; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT/assets/www" "$OUT/gen" "$OUT/classes" "$OUT/signer"
cp -R "$ROOT/web/dist/." "$OUT/assets/www/"

echo "[apk] resources"
"$AAPT2" compile --dir "$AND/res" -o "$OUT/res.zip"
"$AAPT2" link -o "$OUT/unsigned.apk" -I "$ANDROID_JAR" \
  --manifest "$AND/AndroidManifest.xml" \
  --min-sdk-version "$MIN_SDK" --target-sdk-version "$TARGET_SDK" \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
  -A "$OUT/assets" --java "$OUT/gen" \
  -0 png -0 webp -0 woff2 -0 woff \
  "$OUT/res.zip"

echo "[apk] code"
# shellcheck disable=SC2046
javac -nowarn -Xlint:-options -source 8 -target 8 -bootclasspath "$ANDROID_JAR" -proc:none -encoding UTF-8 \
  -d "$OUT/classes" $(find "$OUT/gen" "$AND/java" -name '*.java')
java -cp "$TOOLS/dx.jar" com.android.dx.command.Main --dex --min-sdk-version="$MIN_SDK" \
  --output="$OUT/classes.dex" "$OUT/classes"
(cd "$OUT" && zip -q -X unsigned.apk classes.dex)

echo "[apk] signing"
KEYSTORE=""
if [ -n "${ANDROID_KEYSTORE_BASE64:-}" ]; then
  KEYSTORE="$OUT/ci.p12"
  echo "$ANDROID_KEYSTORE_BASE64" | base64 -d > "$KEYSTORE"
  STOREPASS="$ANDROID_KEYSTORE_PASSWORD"
  ALIAS="${ANDROID_KEY_ALIAS:-amadeus}"
elif [ -f "$AND/signing/amadeus-personal.p12" ]; then
  KEYSTORE="$AND/signing/amadeus-personal.p12"
  STOREPASS="$(grep '^password=' "$AND/signing/keystore.properties" | cut -d= -f2-)"
  ALIAS="$(grep '^alias=' "$AND/signing/keystore.properties" | cut -d= -f2-)"
else
  echo "[apk] WARNING: no signing key configured, using a throwaway key"
  KEYSTORE="$OUT/throwaway.p12"
  STOREPASS="throwaway"
  ALIAS="amadeus"
  keytool -genkeypair -keystore "$KEYSTORE" -storetype PKCS12 -storepass "$STOREPASS" -alias "$ALIAS" \
    -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Real Amadeus Mobile (throwaway)" >/dev/null 2>&1
fi
javac -nowarn -cp "$TOOLS/apksig.jar" -d "$OUT/signer" "$AND/buildtools/ApkSign.java" "$AND/buildtools/ZipAlign.java"
java -cp "$OUT/signer" ZipAlign "$OUT/unsigned.apk" "$OUT/aligned.apk"
# apksig 2.3.0 (the last version on Maven Central) uses JDK-internal X.509 classes.
java --add-exports java.base/sun.security.x509=ALL-UNNAMED --add-exports java.base/sun.security.pkcs=ALL-UNNAMED \
  --add-exports java.base/sun.security.util=ALL-UNNAMED \
  -cp "$TOOLS/apksig.jar:$OUT/signer" ApkSign "$OUT/aligned.apk" "$OUT/$APK_NAME" "$KEYSTORE" "$STOREPASS" "$ALIAS" "$MIN_SDK"

echo "[apk] done: android/build/$APK_NAME ($(du -h "$OUT/$APK_NAME" | cut -f1)) versionCode=$VERSION_CODE versionName=$VERSION_NAME"
