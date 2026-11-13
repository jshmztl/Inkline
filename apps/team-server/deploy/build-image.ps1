param(
  [string]$Version = "dev",
  [switch]$NoDocker
)

$ErrorActionPreference = "Stop"

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$crate = Join-Path $repo "apps\team-server"
$output = Join-Path $repo "output\inkline-team-deploy"
$linker = Join-Path $env:USERPROFILE ".rustup\toolchains\stable-x86_64-pc-windows-msvc\lib\rustlib\x86_64-pc-windows-msvc\bin\rust-lld.exe"

if (-not (Test-Path $linker)) {
  throw "找不到 rust-lld：$linker"
}

Write-Host "构建静态 musl 二进制 ..."
rustup target add x86_64-unknown-linux-musl | Out-Null
$env:CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER = $linker
cargo build --release --target x86_64-unknown-linux-musl --manifest-path (Join-Path $crate "Cargo.toml")

$binary = Join-Path $crate "target\x86_64-unknown-linux-musl\release\inkline-team-server"
if (-not (Test-Path $binary)) {
  throw "构建产物不存在：$binary"
}

New-Item -ItemType Directory -Force -Path $output | Out-Null
Copy-Item $binary (Join-Path $output "inkline-team-server") -Force
foreach ($name in @("Dockerfile.runtime", "docker-compose.yml", "docker-compose.app.yml", "env.example", "deploy.sh")) {
  Copy-Item (Join-Path $PSScriptRoot $name) (Join-Path $output $name) -Force
}

Write-Host "部署包已生成：$output"
Write-Host "目标服务器操作："
Write-Host "  cd /opt/inkline-team"
Write-Host "  sh deploy.sh install --with-db"

$docker = Get-Command docker -ErrorAction SilentlyContinue
if ($NoDocker -or -not $docker) {
  Write-Host "未检测到可用 Docker，跳过本地镜像构建；服务器会使用静态二进制与 Dockerfile.runtime 自动构建镜像。"
  exit 0
}

try {
  docker info | Out-Null
  $image = "inkline-team-server:$Version"
  Write-Host "构建镜像 $image ..."
  docker build -f (Join-Path $output "Dockerfile.runtime") -t $image -t "inkline-team-server:latest" $output
  $tar = Join-Path $output "inkline-team-server-image.tar"
  Write-Host "导出镜像包：$tar"
  docker save $image "inkline-team-server:latest" -o $tar
} catch {
  Write-Warning "本地 Docker 不可用，跳过镜像构建：$($_.Exception.Message)"
  Write-Host "服务器会使用静态二进制与 Dockerfile.runtime 自动构建镜像。"
}
