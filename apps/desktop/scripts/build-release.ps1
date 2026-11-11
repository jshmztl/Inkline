param(
  [string]$KeyPath = "$env:USERPROFILE\.tauri\inkline.key",
  [string]$KeyPassword = $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD,
  [string]$BaseUrl = 'https://github.com/jshmztl/Inkline/releases/latest/download',
  [string]$AssetName = ''
)

$ErrorActionPreference = 'Stop'
$appDir = Split-Path -Parent $PSScriptRoot
$legacyKeyPath = "$env:USERPROFILE\.tauri\api-workbench.key"
if (-not (Test-Path $KeyPath) -and (Test-Path $legacyKeyPath)) {
  $KeyPath = $legacyKeyPath
}

if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
  if (-not (Test-Path $KeyPath)) {
    throw "未找到签名私钥：$KeyPath。请先执行 pnpm tauri signer generate -w <路径> 生成密钥。"
  }
  $env:TAURI_SIGNING_PRIVATE_KEY = $KeyPath
}
if ($KeyPassword) {
  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $KeyPassword
}

Push-Location $appDir
try {
  pnpm tauri build --config src-tauri/tauri.release.conf.json
  if ($LASTEXITCODE -ne 0) { throw 'tauri build 失败' }
} finally {
  Pop-Location
}

$bundleRoot = Join-Path $appDir 'src-tauri\target\release\bundle'
$installer = Get-ChildItem (Join-Path $bundleRoot 'nsis') -Filter '*.exe' -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $installer) {
  $installer = Get-ChildItem (Join-Path $bundleRoot 'msi') -Filter '*.msi' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
}
if (-not $installer) { throw "未找到安装包：$bundleRoot" }

$sigPath = "$($installer.FullName).sig"
if (-not (Test-Path $sigPath)) { throw "未生成签名文件：$sigPath" }

$version = (Get-Content (Join-Path $appDir 'src-tauri\tauri.conf.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
if ($env:UPDATE_BASE_URL) { $BaseUrl = $env:UPDATE_BASE_URL }
if ($env:UPDATE_ASSET_NAME) { $AssetName = $env:UPDATE_ASSET_NAME }
$fileName = if ($AssetName) { [uri]::EscapeDataString($AssetName) } else { [uri]::EscapeDataString($installer.Name) }
$manifest = [ordered]@{
  version   = $version
  notes     = "Inkline $version"
  pub_date  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  platforms = [ordered]@{
    'windows-x86_64' = [ordered]@{
      signature = (Get-Content $sigPath -Raw).Trim()
      url       = "$BaseUrl/$fileName"
    }
  }
}

$manifestPath = Join-Path $bundleRoot 'latest.json'
$json = $manifest | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ''
Write-Host '发布产物：'
Write-Host "  安装包  $($installer.FullName)"
Write-Host "  签名    $sigPath"
Write-Host "  清单    $manifestPath"
Write-Host ''
Write-Host '将上述安装包与 latest.json 上传到 GitHub Releases（标签 latest）即可发布更新。'
