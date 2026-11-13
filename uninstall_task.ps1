# 卸载 2DFan 每日自动签到计划任务（不删除脚本与日志）
$ErrorActionPreference = 'Stop'
$TaskName = '2DFan-DailyCheckin'

$t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $t) {
  Write-Host "计划任务 $TaskName 不存在，无需卸载" -ForegroundColor Yellow
  return
}

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "已删除计划任务：$TaskName" -ForegroundColor Green
