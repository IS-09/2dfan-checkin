# 生成 config.json：把密码用 Windows DPAPI（CurrentUser 作用域）加密后写入。
# 明文密码只在内存里存在，不落盘、不打印。
#
# 用法：powershell -ExecutionPolicy Bypass -File .\setup_config.ps1

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security

$Root = $PSScriptRoot
$Target = Join-Path $Root 'config.json'
$Example = Join-Path $Root 'config.example.json'

Write-Host '=== 2dfan 自动签到 · 配置生成 ===' -ForegroundColor Cyan
Write-Host '密码会被 DPAPI 加密后写入 config.json，只有当前 Windows 账户能解开。' -ForegroundColor DarkGray
Write-Host ''

if (Test-Path $Target) {
  $ans = Read-Host 'config.json 已存在，覆盖吗？(y/N)'
  if ($ans -notmatch '^[Yy]') { Write-Host '已取消，未做修改。' -ForegroundColor Yellow; return }
}

$Login = Read-Host '2dfan 登录名（邮箱或用户名）'
if ([string]::IsNullOrWhiteSpace($Login)) { throw '登录名不能为空' }

$sec = Read-Host '密码（输入时不回显）' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
try {
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

if ([string]::IsNullOrEmpty($plain)) { throw '密码不能为空' }

$enc = [Security.Cryptography.ProtectedData]::Protect(
  [Text.Encoding]::UTF8.GetBytes($plain), $null, 'CurrentUser'
)
$b64 = [Convert]::ToBase64String($enc)
$plain = $null  # 尽早丢弃明文引用

# 以 config.example.json 为模板，只替换账号与密文
$cfg = Get-Content $Example -Raw -Encoding UTF8 | ConvertFrom-Json
$cfg.login = $Login
$cfg.password_dpapi = $b64

$json = $cfg | ConvertTo-Json -Depth 6
# 必须无 BOM：Node 的 JSON.parse 不接受 BOM
[IO.File]::WriteAllText($Target, $json, (New-Object Text.UTF8Encoding $false))

# 回环校验：能解开且与输入一致
$check = [Text.Encoding]::UTF8.GetString(
  [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($b64), $null, 'CurrentUser')
) -eq (Read-Host '为确认无误，请再输入一次密码' -AsSecureString | ForEach-Object {
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($_)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
})

Write-Host ''
Write-Host "已写入 $Target" -ForegroundColor Green
if ($check) {
  Write-Host '密码校验：一致 ✅' -ForegroundColor Green
} else {
  Write-Host '密码校验：两次输入不一致，请重新运行本脚本 ⚠' -ForegroundColor Yellow
}
Write-Host ''
Write-Host '下一步：' -ForegroundColor Yellow
Write-Host '  1) node login_once.mjs                     # 登录一次，换取 Cookie'
Write-Host '  2) powershell -ExecutionPolicy Bypass -File .\install_task.ps1   # 注册每日任务'
