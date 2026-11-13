# 2DFan 每日自动签到 —— 注册 Windows 计划任务
# 触发：每日 00:05、00:35 与 09:05（补跑），以及登录后 2 分钟（补跑）
# 脚本本身幂等：已签到直接退出，所以多触发不会重复签到。
#
# 运行：右键「使用 PowerShell 运行」，或在 PowerShell 里执行
#   powershell -ExecutionPolicy Bypass -File .\install_task.ps1

$ErrorActionPreference = 'Stop'

$Root    = $PSScriptRoot
$TaskName = '2DFan-DailyCheckin'
$Script  = Join-Path $Root 'checkin_daily.mjs'

if (-not (Test-Path $Script)) { throw "找不到 $Script" }

# 定位 node.exe：优先 PATH，其次常见安装位置
$Node = $null
$cmd = Get-Command node -ErrorAction SilentlyContinue
if ($cmd) { $Node = $cmd.Source }
if (-not $Node) {
  $cands = @(
    "$env:ProgramFiles\nodejs\node.exe",
    "${env:ProgramFiles(x86)}\nodejs\node.exe",
    "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
  )
  foreach ($p in $cands) {
    if ($p -and (Test-Path $p)) { $Node = $p; break }
  }
}
if (-not $Node) { throw '找不到 node.exe，请确认 Node.js 已安装并已加入 PATH' }

$User = "$env:USERDOMAIN\$env:USERNAME"
$Today = Get-Date
$Start1 = $Today.Date.AddDays(1).AddHours(0).AddMinutes(5)
$Start2 = $Today.Date.AddDays(1).AddHours(0).AddMinutes(35)
$Start3 = $Today.Date.AddDays(1).AddHours(9).AddMinutes(5)

$Xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>2DFan 每日自动签到（00:05 主触发，00:35 与登录后补跑；脚本幂等）</Description>
    <URI>\$TaskName</URI>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>$($Start1.ToString('yyyy-MM-ddTHH:mm:ss'))</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
    </CalendarTrigger>
    <CalendarTrigger>
      <StartBoundary>$($Start2.ToString('yyyy-MM-ddTHH:mm:ss'))</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
    </CalendarTrigger>
    <CalendarTrigger>
      <StartBoundary>$($Start3.ToString('yyyy-MM-ddTHH:mm:ss'))</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
    </CalendarTrigger>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <Delay>PT2M</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$User</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT30M</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT10M</Interval>
      <Count>2</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$Node</Command>
      <Arguments>"$Script"</Arguments>
      <WorkingDirectory>$Root</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@

$tmp = Join-Path $env:TEMP "2dfan_task_$([guid]::NewGuid().ToString('N')).xml"
# schtasks 要求 XML 为 Unicode
[IO.File]::WriteAllText($tmp, $Xml, [Text.Encoding]::Unicode)

try {
  & schtasks.exe /Create /TN $TaskName /XML $tmp /F | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "schtasks 创建失败，退出码 $LASTEXITCODE" }
}
finally {
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
}

$info = Get-ScheduledTaskInfo -TaskName $TaskName
$task = Get-ScheduledTask -TaskName $TaskName

Write-Host ''
Write-Host '计划任务已创建' -ForegroundColor Green
Write-Host ("  名称      : {0}" -f $TaskName)
Write-Host ("  状态      : {0}" -f $task.State)
Write-Host ("  运行账户  : {0}（仅登录时运行）" -f $User)
Write-Host ("  node      : {0}" -f $Node)
Write-Host ("  脚本      : {0}" -f $Script)
Write-Host ("  下次运行  : {0}" -f $info.NextRunTime)
Write-Host ("  触发器数  : {0}" -f $task.Triggers.Count)
Write-Host ''
Write-Host '手动试跑一次（可选）：' -ForegroundColor Yellow
Write-Host ("  schtasks /Run /TN {0}" -f $TaskName)
Write-Host '卸载：' -ForegroundColor Yellow
Write-Host ("  powershell -ExecutionPolicy Bypass -File `"{0}`"" -f (Join-Path $Root 'uninstall_task.ps1'))
