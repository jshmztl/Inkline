#!/usr/bin/env sh
# Inkline 团队服务 Docker 部署脚本。
# 用法：sh deploy.sh <install|update|backup|status|logs> [选项]
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

ENV_FILE=.env
MODE_FILE=.deploy-mode
PROJECT_NAME=inkline-team
IMAGE_TAR=${INKLINE_IMAGE_TAR:-./inkline-team-server-image.tar}
COMPOSE_FILE=

log() { printf '%s\n' "$*"; }
fail() { printf '错误：%s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
用法：sh deploy.sh <命令> [选项]

命令：
  install   首次部署（默认）
  update    更新到新的服务镜像（默认先备份数据库）
  backup    备份数据库
  status    查看容器与健康状态
  logs      持续查看服务日志

选项：
  --with-db        使用内置 PostgreSQL（docker-compose.yml）
  --external-db    使用外部 PostgreSQL（docker-compose.app.yml）
  --no-backup      update 时跳过数据库备份
  --tar=路径       指定镜像包，默认 ./inkline-team-server-image.tar
EOF
}

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" "$@"
  else
    fail "未找到 Docker Compose；请先安装 docker compose 插件或 docker-compose"
  fi
}

env_get() {
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | tr -d '\r' | tail -n 1
}

find_pg_dump() {
  if command -v pg_dump >/dev/null 2>&1; then
    command -v pg_dump
    return 0
  fi
  configured=$(env_get PG_DUMP_BIN)
  if [ -n "$configured" ] && [ -x "$configured" ]; then
    printf '%s' "$configured"
    return 0
  fi
  if [ -x /opt/inkline-team/pgsql/bin/pg_dump ]; then
    printf '%s' /opt/inkline-team/pgsql/bin/pg_dump
    return 0
  fi
  return 1
}

set_env() {
  key=$1
  value=$2
  touch "$ENV_FILE"
  if grep -q "^$key=" "$ENV_FILE"; then
    tmp=$(mktemp)
    awk -v key="$key" -v value="$value" 'BEGIN { FS = OFS = "=" } $1 == key { print key "=" value; next } { print }' "$ENV_FILE" > "$tmp"
    mv "$tmp" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -tx1 -N32 /dev/urandom | tr -d ' \n'
  fi
}

random_password() {
  suffix=$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n' | cut -c1-14)
  printf 'Ink1%s\n' "$suffix"
}

ensure_env() {
  if [ ! -f "$ENV_FILE" ]; then
    [ -f env.example ] || fail "缺少 env.example"
    cp env.example "$ENV_FILE"
    chmod 600 "$ENV_FILE" 2>/dev/null || true
    log "已创建 $ENV_FILE"
  fi
  if [ -z "$(env_get JWT_SECRET)" ]; then
    set_env JWT_SECRET "$(random_hex)"
    log "已生成 JWT_SECRET"
  fi
  if [ -z "$(env_get BOOTSTRAP_ACCOUNT)" ]; then
    set_env BOOTSTRAP_ACCOUNT admin
  fi
  if [ -z "$(env_get BOOTSTRAP_PASSWORD)" ]; then
    password=$(random_password)
    set_env BOOTSTRAP_PASSWORD "$password"
    {
      printf '账号：%s\n' "$(env_get BOOTSTRAP_ACCOUNT)"
      printf '初始口令：%s\n' "$password"
      printf '首次登录会强制修改口令。\n'
    } > admin-password.txt
    chmod 600 admin-password.txt 2>/dev/null || true
    log "已生成引导账号，初始口令保存在 $SCRIPT_DIR/admin-password.txt"
  fi
}

select_mode() {
  if [ -n "${FORCE_MODE:-}" ]; then
    mode=$FORCE_MODE
  elif [ -f "$MODE_FILE" ]; then
    mode=$(tr -d '\r' < "$MODE_FILE")
  elif [ -n "$(env_get DATABASE_URL)" ]; then
    mode=external
  else
    mode=bundled
  fi

  printf '%s' "$mode" > "$MODE_FILE"
  if [ "$mode" = external ]; then
    [ -n "$(env_get DATABASE_URL)" ] || fail "外部数据库模式需要在 .env 中设置 DATABASE_URL"
    COMPOSE_FILE=docker-compose.app.yml
  else
    COMPOSE_FILE=docker-compose.yml
    if [ -z "$(env_get POSTGRES_PASSWORD)" ]; then
      set_env POSTGRES_PASSWORD "$(random_password)"
      log "已生成 PostgreSQL 口令并写入 $ENV_FILE"
    fi
  fi
}

require_docker() {
  command -v docker >/dev/null 2>&1 || fail "未安装 Docker"
  docker info >/dev/null 2>&1 || fail "无法连接 Docker 守护进程；请确认 Docker 已启动且当前用户有权限"
}

image_name() {
  image=$(env_get INKLINE_IMAGE)
  [ -n "$image" ] || image=inkline-team-server:latest
  case "$image" in
    *:*) ;;
    *) fail "INKLINE_IMAGE 必须带标签，例如 inkline-team-server:latest" ;;
  esac
  printf '%s' "$image"
}

build_from_binary() {
  image=$(image_name)
  [ -f inkline-team-server ] || fail "缺少静态二进制 inkline-team-server"
  chmod +x inkline-team-server 2>/dev/null || true
  log "使用静态二进制构建镜像 $image ..."
  docker build -f Dockerfile.runtime -t "$image" . >/dev/null
}

ensure_image() {
  image=$(image_name)
  if docker image inspect "$image" >/dev/null 2>&1; then
    return 0
  fi
  if [ -f "$IMAGE_TAR" ]; then
    log "载入镜像 $IMAGE_TAR ..."
    docker load -i "$IMAGE_TAR" >/dev/null
  elif [ -f inkline-team-server ] && [ -f Dockerfile.runtime ]; then
    build_from_binary
  else
    fail "镜像 $image 不存在，且找不到 $IMAGE_TAR 或静态二进制；请先上传部署包"
  fi
  docker image inspect "$image" >/dev/null 2>&1 || fail "镜像 $image 不可用；请确认 INKLINE_IMAGE 与构建时一致"
}

load_new_image() {
  image=$(image_name)
  if [ -f "$IMAGE_TAR" ]; then
    log "载入新镜像 $IMAGE_TAR ..."
    docker load -i "$IMAGE_TAR" >/dev/null
  elif [ -f inkline-team-server ] && [ -f Dockerfile.runtime ]; then
    build_from_binary
  else
    fail "找不到镜像包 $IMAGE_TAR 或静态二进制，无法更新"
  fi
  docker image inspect "$image" >/dev/null 2>&1 || fail "镜像 $image 不可用"
}

ensure_postgres_image() {
  [ "$COMPOSE_FILE" = docker-compose.yml ] || return 0
  image=$(env_get POSTGRES_IMAGE)
  [ -n "$image" ] || image=postgres:16-alpine
  if docker image inspect "$image" >/dev/null 2>&1; then
    return 0
  fi
  log "本地缺少 PostgreSQL 镜像 $image，尝试拉取 ..."
  docker pull "$image" || fail "无法拉取 PostgreSQL 镜像。离线环境请先 docker load 该镜像，或使用 --external-db 连接外部数据库"
}

wait_healthy() {
  cid=$(compose ps -q server 2>/dev/null || true)
  [ -n "$cid" ] || return 1
  i=0
  while [ "$i" -lt 60 ]; do
    state=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || echo missing)
    case "$state" in
      healthy) return 0 ;;
      exited|dead) return 1 ;;
    esac
    sleep 2
    i=$((i + 1))
  done
  return 1
}

print_summary() {
  port=$(env_get INKLINE_PORT)
  [ -n "$port" ] || port=8080
  log ""
  log "管理台：http://<服务器地址>:$port/admin/"
  log "健康检查：http://<服务器地址>:$port/readyz"
  log "模式文件：$MODE_FILE（$mode）"
  log "容器状态："
  compose ps
}

backup_database() {
  mkdir -p backup
  file="backup/inkline-team-$(date +%Y%m%d-%H%M%S).dump"
  if [ "$COMPOSE_FILE" = docker-compose.yml ]; then
    user=$(env_get POSTGRES_USER)
    [ -n "$user" ] || user=inkline
    db=$(env_get POSTGRES_DB)
    [ -n "$db" ] || db=inkline_team
    log "备份内置数据库 ..."
    compose exec -T db pg_dump -U "$user" -d "$db" -Fc > "$file" || fail "数据库备份失败"
  elif pg_dump_bin=$(find_pg_dump); then
    log "使用 pg_dump 备份外部数据库 ..."
    "$pg_dump_bin" -Fc "$(env_get DATABASE_URL)" > "$file" || fail "数据库备份失败"
  elif [ -n "$(env_get PG_DUMP_CMD)" ]; then
    log "使用 PG_DUMP_CMD 备份外部数据库 ..."
    sh -c "$(env_get PG_DUMP_CMD)" > "$file" || fail "数据库备份失败"
  else
    fail "外部数据库模式需要本机 pg_dump 或 PG_DUMP_CMD；可加 --no-backup 跳过备份"
  fi
  [ -s "$file" ] || fail "备份文件为空：$file"
  log "数据库已备份：$SCRIPT_DIR/$file"
  LAST_BACKUP=$file
}

cmd_install() {
  require_docker
  ensure_env
  select_mode
  ensure_image
  ensure_postgres_image
  log "启动服务（$mode 模式）..."
  compose up -d
  if ! wait_healthy; then
    compose logs --tail=120 server || true
    fail "服务未通过健康检查，请查看上面的日志"
  fi
  print_summary
}

cmd_update() {
  require_docker
  ensure_env
  select_mode

  cid=$(compose ps -q server 2>/dev/null || true)
  old_image=
  if [ -n "$cid" ]; then
    old_image=$(docker inspect -f '{{.Image}}' "$cid" 2>/dev/null || true)
  fi

  if [ "${NO_BACKUP:-0}" -eq 0 ]; then
    backup_database
  else
    log "已跳过数据库备份"
  fi

  [ -f "$IMAGE_TAR" ] || [ -f inkline-team-server ] || fail "找不到镜像包 $IMAGE_TAR 或静态二进制"
  image=$(image_name)
  load_new_image

  if [ -n "$old_image" ]; then
    docker tag "$old_image" "${image%:*}:previous" 2>/dev/null || true
  fi

  log "重建服务 ..."
  compose up -d --no-deps --force-recreate server
  if wait_healthy; then
    print_summary
    log "更新完成"
    return 0
  fi

  compose logs --tail=120 server || true
  if [ -n "$old_image" ]; then
    log "健康检查失败，回滚到更新前镜像 ..."
    docker tag "$old_image" "$image"
    compose up -d --no-deps --force-recreate server
    wait_healthy || true
  fi
  fail "更新失败，已尝试回滚；请检查日志与备份"
}

cmd_backup() {
  require_docker
  select_mode
  backup_database
}

cmd_status() {
  require_docker
  select_mode
  compose ps
  cid=$(compose ps -q server 2>/dev/null || true)
  if [ -n "$cid" ]; then
    docker inspect -f '镜像={{.Config.Image}} 健康={{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid"
  fi
}

cmd_logs() {
  require_docker
  select_mode
  compose logs -f --tail=200 server
}

COMMAND=${1:-install}
if [ $# -gt 0 ]; then shift; fi
NO_BACKUP=0
FORCE_MODE=

for arg in "$@"; do
  case "$arg" in
    --with-db) FORCE_MODE=bundled ;;
    --external-db) FORCE_MODE=external ;;
    --no-backup) NO_BACKUP=1 ;;
    --tar=*) IMAGE_TAR=${arg#*=} ;;
    -h|--help) usage; exit 0 ;;
    *) usage; fail "未知参数：$arg" ;;
  esac
done

case "$COMMAND" in
  install) cmd_install ;;
  update) cmd_update ;;
  backup) cmd_backup ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  help|-h|--help) usage ;;
  *) usage; exit 1 ;;
esac
