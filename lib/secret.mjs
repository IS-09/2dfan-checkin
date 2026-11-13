// 密码解密：setup 时用 Windows DPAPI（CurrentUser 作用域）加密，运行时解密。
//
// 为什么不用 execFileSync 的默认管道：DSH 沙箱禁止程序打开命名管道，
// `stdio: 'pipe'` 会直接 EPERM。这里改为 stdio:'ignore' + PowerShell 写临时文件，
// 密码不经管道、不进 argv、不进日志，临时文件读完立即删除。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PS_DECRYPT = [
  'Add-Type -AssemblyName System.Security;',
  '$b=[Convert]::FromBase64String($env:DF_ENC);',
  "$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');",
  '$s=[Text.Encoding]::UTF8.GetString($p);',
  'Set-Content -LiteralPath $env:DF_OUT -Value $s -Encoding UTF8 -NoNewline',
].join(' ');

export function decryptPassword(encBase64) {
  if (!encBase64) throw new Error('config.json 里没有 password_dpapi');

  const out = path.join(os.tmpdir(), `2dfan_pw_${process.pid}_${Date.now().toString(36)}.tmp`);
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_DECRYPT], {
      stdio: 'ignore',
      env: { ...process.env, DF_ENC: encBase64, DF_OUT: out },
      windowsHide: true,
    });
    if (r.error) throw new Error(`调用 PowerShell 失败：${r.error.code || r.error.message}`);
    if (r.status !== 0) throw new Error(`PowerShell 解密失败，退出码 ${r.status}`);
    if (!fs.existsSync(out)) throw new Error('解密未产生输出文件');

    const pwd = fs.readFileSync(out, 'utf8').replace(/^\uFEFF/, '').replace(/\r?\n$/, '');
    if (!pwd) throw new Error('DPAPI 解密得到空密码');
    return pwd;
  } finally {
    try {
      if (fs.existsSync(out)) fs.unlinkSync(out);
    } catch {
      /* 清理失败不阻断 */
    }
  }
}
