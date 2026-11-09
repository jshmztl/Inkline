param(
  [string]$KeyPath = "$env:USERPROFILE\.tauri\api-workbench.key"
)

$ErrorActionPreference = 'Stop'
$appDir = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path $KeyPath)) {
  throw "未找到签名私钥：$KeyPath。请先执行 pnpm tauri signer generate -w <路径> 生成密钥。"
}

$env:TAURI_SIGNING_PRIVATE_KEY = $KeyPath
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''

Push-Location $appDir
try {
  pnpm tauri build --config src-tauri/tauri.release.conf.json
  if ($LASTEXITCODE -ne 0) { throw 'tauri build 失败' }
} finally {
  Pop-Location
}

$bundleDir = Join-Path $appDir 'src-tauri\target\release\bundle\msi'
$msi = Get-ChildItem $bundleDir -Filter '*.msi' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $msi) { throw "未找到 MSI：$bundleDir" }

$sigPath = "$($msi.FullName).sig"
if (-not (Test-Path $sigPath)) { throw "未生成签名文件：$sigPath" }

$version = (Get-Content (Join-Path $appDir 'src-tauri\tauri.conf.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$base = 'https://gitee.com/LeonAmour/api-workbench/releases/download/latest'
$fileName = [uri]::EscapeDataString($msi.Name)
$manifest = [ordered]@{
  version   = $version
  notes     = "API Workbench $version"
  pub_date  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  platforms = [ordered]@{
    'windows-x86_64' = [ordered]@{
      signature = (Get-Content $sigPath -Raw).Trim()
      url       = "$base/$fileName"
    }
  }
}

$manifestPath = Join-Path $appDir 'src-tauri\target\release\bundle\latest.json'
$json = $manifest | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ''
Write-Host '发布产物：'
Write-Host "  安装包  $($msi.FullName)"
Write-Host "  签名    $sigPath"
Write-Host "  清单    $manifestPath"
Write-Host ''
Write-Host '将上述 MSI 与 latest.json 上传到 Gitee 发行版（标签 latest）即可发布更新。'
