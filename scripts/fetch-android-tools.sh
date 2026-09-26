#!/usr/bin/env bash
# Gets the minimal Android toolchain used by build-apk.sh, without Gradle:
#   android.jar (API 34) and aapt2 from the Android SDK when ANDROID_HOME is set,
#   otherwise from public mirrors (checksums pinned); dx and apksig from Maven Central.
set -euo pipefail
TOOLS="$(cd "$(dirname "$0")/.." && pwd)/android/tools"
mkdir -p "$TOOLS"
cd "$TOOLS"

fetch() { # url file sha256
  if [ -f "$2" ] && echo "$3  $2" | sha256sum -c --status; then return; fi
  echo "[tools] downloading $2"
  curl -fsSL --retry 3 -o "$2.tmp" "$1"
  echo "$3  $2.tmp" | sha256sum -c --status || { echo "[tools] checksum mismatch for $2" >&2; rm -f "$2.tmp"; exit 1; }
  mv "$2.tmp" "$2"
}

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [ -n "$SDK" ] && [ -f "$SDK/platforms/android-34/android.jar" ]; then
  cp "$SDK/platforms/android-34/android.jar" android.jar
else
  fetch https://raw.githubusercontent.com/Sable/android-platforms/master/android-34/android.jar android.jar \
    6cea1df3efb77103ac3e2beb9bf4718964b0e0869ab16d39d29d5cbae1c147ad
fi

BT_AAPT2=""
if [ -n "$SDK" ] && [ -d "$SDK/build-tools" ]; then
  BT_AAPT2="$(ls -d "$SDK"/build-tools/*/aapt2 2>/dev/null | sort -V | tail -1 || true)"
fi
if [ -n "$BT_AAPT2" ]; then
  cp "$BT_AAPT2" aapt2
else
  # Apktool ships a prebuilt aapt2 for Linux.
  fetch https://github.com/iBotPeaches/Apktool/releases/download/v2.12.1/apktool_2.12.1.jar apktool.jar \
    66cf4524a4a45a7f56567d08b2c9b6ec237bcdd78cee69fd4a59c8a0243aeafa
  [ -f aapt2 ] || { unzip -o -q -j apktool.jar prebuilt/linux/aapt2_64 -d . && mv aapt2_64 aapt2; }
fi
chmod +x aapt2

fetch https://repo.maven.apache.org/maven2/com/jakewharton/android/repackaged/dalvik-dx/16.0.1/dalvik-dx-16.0.1.jar dx.jar \
  1e4b645628e3bdb097b5331d669e177ef235a551582a8c646dbe36865e541907
fetch https://repo.maven.apache.org/maven2/com/android/tools/build/apksig/2.3.0/apksig-2.3.0.jar apksig.jar \
  9637078c0016244e4be0941836295365a7e2e5b164c59cb7885783c40460bfee
echo "[tools] ready: $(./aapt2 version 2>&1 | head -1)"
