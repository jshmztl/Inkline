param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$FileParts
)

$ErrorActionPreference = 'Stop'

$file = ($FileParts -join ' ').Trim().Trim('"')
if (-not $file) {
  throw '未提供待签名文件'
}

if ($env:INKLINE_SIGN_DEBUG -eq '1') {
  Add-Content -Path (Join-Path $env:TEMP 'inkline-sign-debug.log') `
    -Value ("PWD=" + $PWD.Path + " FILE=" + $file)
}

$pfx = $env:INKLINE_SIGN_PFX
$password = $env:INKLINE_SIGN_PFX_PASSWORD

if (-not $pfx -or -not (Test-Path $pfx)) {
  Write-Host '未配置 INKLINE_SIGN_PFX，跳过 Windows 代码签名'
  exit 0
}

function Find-SignTool {
  if ($env:INKLINE_SIGNTOOL -and (Test-Path $env:INKLINE_SIGNTOOL)) {
    return $env:INKLINE_SIGNTOOL
  }

  $command = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $kits = "${env:ProgramFiles(x86)}\Windows Kits\10\bin"
  if (Test-Path $kits) {
    $candidate = Get-ChildItem $kits -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match '\\x64\\' } |
      Sort-Object FullName -Descending |
      Select-Object -First 1
    if ($candidate) {
      return $candidate.FullName
    }
  }

  throw '未找到 signtool.exe，请安装 Windows SDK 或设置 INKLINE_SIGNTOOL'
}

$timestampUrl = $env:INKLINE_SIGN_TIMESTAMP_URL
if (-not $timestampUrl) {
  $timestampUrl = 'http://timestamp.digicert.com'
}

$signTool = Find-SignTool
$arguments = @(
  'sign',
  '/fd', 'sha256',
  '/f', $pfx
)
if ($password) {
  $arguments += @('/p', $password)
}
$arguments += @('/tr', $timestampUrl, '/td', 'sha256')
if ($env:INKLINE_SIGN_DESCRIPTION) {
  $arguments += @('/d', $env:INKLINE_SIGN_DESCRIPTION)
}
$arguments += $file

& $signTool @arguments
if ($LASTEXITCODE -ne 0) {
  throw "signtool 签名失败：$file"
}

Write-Host "已签名 $file"
