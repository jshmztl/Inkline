param(
  [string]$Subject = 'CN=Inkline, O=Inkline',
  [string]$PfxPath = "$env:USERPROFILE\.tauri\inkline-codesign.pfx",
  [string]$CerPath = "$env:USERPROFILE\.tauri\inkline-codesign.cer",
  [Parameter(Mandatory = $true)]
  [string]$Password,
  [int]$Years = 3
)

$ErrorActionPreference = 'Stop'

$parent = Split-Path -Parent $PfxPath
if ($parent) {
  New-Item -ItemType Directory -Force $parent | Out-Null
}

if (Test-Path $PfxPath) {
  throw "已存在证书文件：$PfxPath。如需重新生成，请先备份并删除旧文件。"
}

$cert = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject $Subject `
  -KeyUsage DigitalSignature `
  -KeyExportPolicy Exportable `
  -CertStoreLocation Cert:\CurrentUser\My `
  -NotAfter (Get-Date).AddYears($Years)

$securePassword = ConvertTo-SecureString $Password -AsPlainText -Force
Export-PfxCertificate -Cert $cert -FilePath $PfxPath -Password $securePassword | Out-Null
Export-Certificate -Cert $cert -FilePath $CerPath | Out-Null

$base64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($PfxPath))

Write-Host ''
Write-Host '已生成自签名代码签名证书：'
Write-Host "  主题        $($cert.Subject)"
Write-Host "  指纹        $($cert.Thumbprint)"
Write-Host "  到期时间    $($cert.NotAfter.ToString('yyyy-MM-dd'))"
Write-Host "  PFX         $PfxPath"
Write-Host "  公钥证书    $CerPath"
Write-Host ''
Write-Host 'GitHub Secrets 配置：'
Write-Host '  WINDOWS_CERTIFICATE_BASE64 = 下面这段 Base64'
Write-Host '  WINDOWS_CERTIFICATE_PASSWORD = 你刚才输入的口令'
Write-Host ''
Write-Output $base64
Write-Host ''
Write-Host '本地签名构建（PowerShell）：'
Write-Host "  `$env:INKLINE_SIGN_PFX = '$PfxPath'"
Write-Host "  `$env:INKLINE_SIGN_PFX_PASSWORD = '你的口令'"
Write-Host "  `$env:INKLINE_SIGN_DESCRIPTION = 'Inkline'"
Write-Host '  pnpm release'
Write-Host ''
Write-Host '让内网终端信任此证书（管理员 PowerShell，二选一或全部执行）：'
Write-Host "  Import-Certificate -FilePath '$CerPath' -CertStoreLocation Cert:\LocalMachine\Root"
Write-Host "  Import-Certificate -FilePath '$CerPath' -CertStoreLocation Cert:\LocalMachine\TrustedPublisher"
Write-Host ''
Write-Host '注意：自签名证书不会让未部署该证书的机器跳过 SmartScreen 提示。'
