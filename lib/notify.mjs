// 桌面通知（尽力而为，失败绝不影响主流程）
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PS = (title, message) => `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Warning
$n.Visible = $true
$n.ShowBalloonTip(15000, @'
${title}
'@, @'
${message}
'@, [System.Windows.Forms.ToolTipIcon]::Warning)
Start-Sleep -Seconds 16
$n.Dispose()
`;

export function notifyFail(title, message) {
  let file = null;
  try {
    file = path.join(os.tmpdir(), `2dfan_notify_${process.pid}_${Date.now().toString(36)}.ps1`);
    // PS 5.1 按 GBK 读无 BOM 文件会把中文读坏，这里写 UTF-8 with BOM
    fs.writeFileSync(file, '\uFEFF' + PS(title, message), 'utf8');
    spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', file], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 25000,
    });
    return true;
  } catch {
    return false;
  } finally {
    try {
      if (file && fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
  }
}
