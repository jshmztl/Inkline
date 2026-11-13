#!/usr/bin/env sh
# 在 Linux/macOS 上构建静态二进制，并生成可上传的部署包。
set -eu

VERSION=${1:-dev}
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
CRATE="$ROOT/apps/team-server"
OUT="$ROOT/output/inkline-team-deploy"

command -v cargo >/dev/null 2>&1 || { echo "缺少 cargo" >&2; exit 1; }
rustup target add x86_64-unknown-linux-musl >/dev/null

echo "构建静态 musl 二进制 ..."
cargo build --release --target x86_64-unknown-linux-musl --manifest-path "$CRATE/Cargo.toml"

BINARY="$CRATE/target/x86_64-unknown-linux-musl/release/inkline-team-server"
[ -f "$BINARY" ] || { echo "构建产物不存在：$BINARY" >&2; exit 1; }

mkdir -p "$OUT"
cp "$BINARY" "$OUT/inkline-team-server"
chmod +x "$OUT/inkline-team-server"
for name in Dockerfile.runtime docker-compose.yml docker-compose.app.yml env.example deploy.sh; do
  cp "$(dirname -- "$0")/$name" "$OUT/$name"
done

echo "部署包已生成：$OUT"
echo "目标服务器：cd /opt/inkline-team && sh deploy.sh install --with-db"

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  IMAGE="inkline-team-server:$VERSION"
  echo "构建镜像 $IMAGE ..."
  docker build -f "$OUT/Dockerfile.runtime" -t "$IMAGE" -t inkline-team-server:latest "$OUT"
  echo "导出镜像包 ..."
  docker save "$IMAGE" inkline-team-server:latest -o "$OUT/inkline-team-server-image.tar"
else
  echo "未检测到可用 Docker，跳过镜像构建；服务器会使用静态二进制自动构建。"
fi
