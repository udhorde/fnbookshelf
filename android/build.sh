#!/bin/bash
# 飞的牛书屋 Android 客户端打包脚本（不依赖 Gradle，用 SDK 的 aapt2 / d8 / apksigner 直接出包）
set -e
cd "$(dirname "$0")"
ROOT="$(pwd)"

TOOLS="$ROOT/tools"
SDK="$TOOLS/sdk"
BT="$SDK/build-tools/34.0.0"
ANDROID_JAR="$SDK/platforms/android-34/android.jar"
JDK="$TOOLS/jdk-17.0.21+9"
export JAVA_HOME="$(cygpath -w "$JDK")"
JAVA="$JDK/bin/java"
JAVAC="$JDK/bin/javac"
KEYTOOL="$JDK/bin/keytool"
AAPT2="$BT/aapt2.exe"
D8="$BT/d8.bat"
ZIPALIGN="$BT/zipalign.exe"
APKSIGNER="$BT/apksigner.bat"

VERSION="1.9.4"
VCODE="10904"
KS="$ROOT/keystore/fnb.jks"
# 签名口令不入库：优先环境变量 FNB_KS_PASS，其次本地 keystore/.kspass（同样被 gitignore），都没有就现生成一个
KS_PASS_FILE="$ROOT/keystore/.kspass"
if [ -n "${FNB_KS_PASS:-}" ]; then
  KSPASS="$FNB_KS_PASS"
elif [ -f "$KS_PASS_FILE" ]; then
  KSPASS="$(tr -d '\r\n' < "$KS_PASS_FILE")"
else
  KSPASS=""
fi

W() { cygpath -w "$1"; }

for f in "$AAPT2" "$D8" "$ZIPALIGN" "$APKSIGNER" "$JAVAC" "$ANDROID_JAR"; do
  if [ ! -e "$f" ]; then echo "缺少构建工具：$f" >&2; exit 1; fi
done

# 签名密钥只生成一次，以后升级包必须用同一把，否则装不上（要先卸载）
if [ ! -f "$KS" ]; then
  mkdir -p "$ROOT/keystore"
  # 没给口令时随机生成一个，并写进 keystore/.kspass 方便下次构建复用
  if [ -z "$KSPASS" ]; then
    KSPASS="$(head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)"
    printf '%s' "$KSPASS" > "$KS_PASS_FILE"
    chmod 600 "$KS_PASS_FILE" 2>/dev/null || true
    echo "已生成随机的签名口令，保存在 keystore/.kspass（不入库，请自行备份）"
  fi
  "$KEYTOOL" -genkeypair -v -keystore "$(W "$KS")" -alias fnb -keyalg RSA -keysize 2048 \
    -validity 10950 -storepass "$KSPASS" -keypass "$KSPASS" \
    -dname "CN=FnBookshelf, OU=Mobile, O=FnBookshelf, L=None, ST=None, C=CN" >/dev/null 2>&1
  echo "已生成签名密钥：keystore/fnb.jks（请连同安装包一起备份，升级要用同一把）"
fi

if [ -z "$KSPASS" ]; then
  echo "找不到签名口令：请设置环境变量 FNB_KS_PASS，或在 keystore/.kspass 里写一行口令。" >&2
  exit 1
fi

build() {
  local name="$1" manifest="$2" resdirs="$3" srcdirs="$4" assetdirs="$5" outname="$6"
  local b="$ROOT/build/$name"
  echo "== 构建 $name"
  rm -rf "$b"
  mkdir -p "$b/res" "$b/gen" "$b/classes" "$b/dex" "$b/assets"

  for d in $resdirs; do cp -r "$ROOT/$d/." "$b/res/"; done
  for d in $assetdirs; do cp -r "$ROOT/$d/." "$b/assets/"; done
  cp "$ROOT/$manifest" "$b/AndroidManifest.xml"

  "$AAPT2" compile --dir "$(W "$b/res")" -o "$(W "$b/res.zip")"
  "$AAPT2" link -o "$(W "$b/app.unsigned.apk")" \
    -I "$(W "$ANDROID_JAR")" \
    --manifest "$(W "$b/AndroidManifest.xml")" \
    -R "$(W "$b/res.zip")" \
    -A "$(W "$b/assets")" \
    --java "$(W "$b/gen")" \
    --min-sdk-version 21 --target-sdk-version 34 \
    --version-code "$VCODE" --version-name "$VERSION" \
    --auto-add-overlay

  # javac 是 Windows 程序，sources.txt 里只能放相对路径（/d/... 会被读成 \d\...）
  : > "$b/sources.txt"
  for d in $srcdirs; do
    ( cd "$ROOT" && find "$d" -name '*.java' ) >> "$b/sources.txt"
  done
  ( cd "$ROOT" && find "build/$name/gen" -name '*.java' ) >> "$b/sources.txt"
  if ! "$JAVAC" -encoding UTF-8 -nowarn -source 8 -target 8 \
      -bootclasspath "$(W "$ANDROID_JAR")" -classpath "$(W "$ANDROID_JAR")" \
      -d "$(W "$b/classes")" @"$(W "$b/sources.txt")" > "$b/javac.log" 2>&1; then
    cat "$b/javac.log"
    echo "javac 失败" >&2
    exit 1
  fi
  if [ -z "$(find "$b/classes" -name '*.class' | head -1)" ]; then
    echo "编译失败：没有产出 class 文件" >&2
    exit 1
  fi

  ( cd "$b/classes" && "$D8" --lib "$(W "$ANDROID_JAR")" --min-api 21 --output "$(W "$b/dex")" \
      $(find . -name '*.class') >/dev/null )

  python "$(W "$ROOT/tools/adddex.py")" "$(W "$b/app.unsigned.apk")" "$(W "$b/dex/classes.dex")"

  "$ZIPALIGN" -f -p 4 "$(W "$b/app.unsigned.apk")" "$(W "$b/app.aligned.apk")"
  "$APKSIGNER" sign --ks "$(W "$KS")" --ks-pass "pass:$KSPASS" --key-pass "pass:$KSPASS" \
    --v1-signing-enabled true --v2-signing-enabled true --min-sdk-version 21 \
    --out "$(W "$ROOT/out/$outname")" "$(W "$b/app.aligned.apk")"

  echo "   -> out/$outname  $(stat -c%s "$ROOT/out/$outname") 字节"
}

mkdir -p "$ROOT/out"
build phone AndroidManifest-phone.xml "res-common res-phone" "src/core src/phone" "assets-common assets-phone" "fnbookshelf-android-phone-$VERSION.apk"
build tv AndroidManifest-tv.xml "res-common res-tv" "src/core src/tv" "assets-common assets-tv" "fnbookshelf-android-tv-$VERSION.apk"

echo
echo "== 校验签名"
for f in "$ROOT/out"/*.apk; do
  echo "-- $(basename "$f")"
  "$APKSIGNER" verify --print-certs "$(W "$f")" | head -4
done
