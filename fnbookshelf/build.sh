#!/bin/bash
# 飞牛书屋 fpk 打包脚本（在项目根目录 fnbookshelf/ 下运行）
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
BUILD="$ROOT/build"
STAGE="$BUILD/fpk"
TARGET="$BUILD/target"
NODE_TAR="$ROOT/appsrc/node-runtime/node.tar.gz"
VERSION="1.9.3"

echo "[1/5] 清理构建目录"
rm -rf "$BUILD"
mkdir -p "$STAGE" "$TARGET"

echo "[2/5] 展开 Node 运行时（剔除 npm/头文件/文档，安装包减重约 12MB）"
# 注意：node/bin/{npm,npx,corepack,yarn,pnpx} 都是指向 lib/node_modules/ 的软链接。
# 排除 lib/node_modules 后必须把这些软链接一并排除，否则包里会留下指向不存在文件的
# 「断链软链接」——fnOS 安装时对应用目录 chown/chmod/setfacl -R，递归遇到断链会返回
# ENOENT，安装器直接报「设置目录权限失败 / 无法安装」。1.5.0~1.6.0 正是踩了这个坑。
mkdir -p "$BUILD/node-extract"
tar -xf "$NODE_TAR" -C "$BUILD/node-extract" \
  --exclude='*/include' --exclude='*/include/*' \
  --exclude='*/lib/node_modules' --exclude='*/lib/node_modules/*' \
  --exclude='*/share/man' --exclude='*/share/man/*' \
  --exclude='*/share/doc' --exclude='*/share/doc/*' \
  --exclude='*/CHANGELOG.md' \
  --exclude='*/bin/npm' --exclude='*/bin/npx' --exclude='*/bin/corepack' \
  --exclude='*/bin/yarn' --exclude='*/bin/yarnpkg' --exclude='*/bin/pnpx'
mv "$BUILD/node-extract"/node-v*-linux-* "$TARGET/node"

# 兜底清理：任何指向不存在目标的软链接（兼容不同 Node 发行版新增的 bin 链接）
while IFS= read -r _link; do
  [ -n "$_link" ] || continue
  [ -e "$_link" ] && continue
  echo "  清理断链软链接: ${_link#$TARGET/} -> $(readlink "$_link" 2>/dev/null)"
  rm -f "$_link"
done < <(find "$TARGET" -type l 2>/dev/null)
_DANGLING="$(find "$TARGET" -type l ! -exec test -e {} \; -print 2>/dev/null | wc -l | tr -d ' ')"
if [ "$_DANGLING" != "0" ]; then
  echo "错误：仍存在 $_DANGLING 个断链软链接，安装到 fnOS 会报「设置目录权限失败」，已中止打包" >&2
  find "$TARGET" -type l ! -exec test -e {} \; -print >&2
  exit 1
fi
echo "  软链接自检通过（无断链）"

echo "[3/5] 复制应用文件"
cp -r "$ROOT/appsrc/server" "$TARGET/server"
cp -r "$ROOT/appsrc/www" "$TARGET/www"
rm -rf "$TARGET/server/data" "$TARGET/server/testdata"

echo "[4/5] 生成 app.tgz 与包结构"
tar -czf "$STAGE/app.tgz" -C "$TARGET" server www node

# 断链自检（针对最终产物）：本应用不需要任何符号链接。Node 官方包里的 bin/{npm,npx,
# corepack} 都指向 lib/node_modules，精简后必须一并去掉，否则 fnOS 安装阶段递归 chown /
# chmod / setfacl 会因断链返回 ENOENT，报「设置目录权限失败」。这里直接检查归档本身，
# 不依赖解包目录在 Windows 上是否保留软链接。
_LINKS="$(tar -tvzf "$STAGE/app.tgz" | grep -c '^l' || true)"
if [ "${_LINKS:-0}" != "0" ]; then
  echo "错误：app.tgz 内仍有 ${_LINKS} 个符号链接，安装到 fnOS 可能报「设置目录权限失败」，已中止打包：" >&2
  tar -tvzf "$STAGE/app.tgz" | grep '^l' >&2
  exit 1
fi
echo "  产物自检通过（app.tgz 内 0 个符号链接）"

cp "$ROOT/manifest" "$STAGE/"
cp "$ROOT/ICON.PNG" "$ROOT/ICON_256.PNG" "$STAGE/"
cp -r "$ROOT/cmd" "$ROOT/config" "$ROOT/ui" "$ROOT/wizard" "$STAGE/"
chmod +x "$STAGE"/cmd/*

# manifest 格式自检（1.8.3 踩过的坑）：
# fnOS 的「本地安装」按「键=值」逐行解析 manifest，非空行里出现第二个等号
# （例如把 #/library?col=xxx 这种带 = 的地址写进 changelog）、或出现没有等号的
# 续行，都会让安装器直接报「不是有效的 fpk 文件」。这里在打包前就拦住。
_MANIFEST_BAD="$(awk 'NF && gsub(/=/,"&") != 1 { print NR": "$0 }' "$STAGE/manifest")"
if [ -n "$_MANIFEST_BAD" ]; then
  echo "错误：manifest 每行必须恰好一个等号（键=值，不许续行、不许值里带 =），已中止打包：" >&2
  echo "$_MANIFEST_BAD" >&2
  exit 1
fi
_CR="$(printf '\r')"
if LC_ALL=C grep -q "$_CR" "$STAGE/manifest"; then
  echo "错误：manifest 含 CRLF 换行（安装器可能解析失败），已中止打包。" >&2
  exit 1
fi
echo "  manifest 格式自检通过（每行一个等号、无续行、LF 换行）"

echo "[5/5] 打包 fpk"
OUT="$ROOT/fnbookshelf_${VERSION}_x86.fpk"
tar -czf "$OUT" -C "$STAGE" manifest ICON.PNG ICON_256.PNG cmd config ui wizard app.tgz
# 清理中间产物；某些受限环境会拦截批量删除，失败不影响打包结果
rm -rf "$BUILD" 2>/dev/null || true

echo "完成: $OUT ($(du -h "$OUT" | cut -f1))"
