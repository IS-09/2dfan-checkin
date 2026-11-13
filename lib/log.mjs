// 极简日志：控制台 + logs/YYYY-MM.log 双写。绝不打密码与 Cookie 值。
import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { info: 'INFO', warn: 'WARN', error: 'ERROR', ok: 'OK  ' };

function localStamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return {
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time:
      `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
      `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`,
  };
}

export function makeLogger(logDir) {
  fs.mkdirSync(logDir, { recursive: true });

  function log(level, msg, extra) {
    const { date, time } = localStamp();
    const tail = extra === undefined ? '' : ' ' + JSON.stringify(extra);
    const line = `[${time}] ${LEVELS[level] || level.toUpperCase()} ${msg}${tail}`;
    (level === 'error' || level === 'warn' ? console.error : console.log)(line);
    try {
      fs.appendFileSync(path.join(logDir, `${date}.log`), line + '\n', 'utf8');
    } catch {
      /* 日志写失败不影响主流程 */
    }
  }

  return {
    info: (m, e) => log('info', m, e),
    warn: (m, e) => log('warn', m, e),
    error: (m, e) => log('error', m, e),
    ok: (m, e) => log('ok', m, e),
    raw: log,
  };
}
