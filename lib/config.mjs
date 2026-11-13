// 配置读取：容错 BOM（PS 5.1 的 Set-Content -Encoding utf8 会写 BOM）
import fs from 'node:fs';
import path from 'node:path';

export function readJson(file, fallback = null) {
  try {
    const txt = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(txt);
  } catch {
    return fallback;
  }
}

export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

export function loadConfig(rootDir) {
  const cfg = readJson(path.join(rootDir, 'config.json'));
  if (!cfg) throw new Error('config.json 缺失或不是合法 JSON');
  if (!cfg.login || !cfg.password_dpapi) throw new Error('config.json 缺少 login / password_dpapi');
  return {
    site: cfg.site || 'https://2dfan.com',
    login: cfg.login,
    passwordDpapi: cfg.password_dpapi,
    maxAttempts: cfg.max_attempts ?? 3,
    retryDelayMs: cfg.retry_delay_ms ?? 15000,
    notifyFailures: cfg.notify_failures ?? 2,
    headedFallback: cfg.headed_fallback !== false,
    browser: { channel: cfg.browser?.channel || 'chrome', headlessFirst: cfg.browser?.headless_first !== false },
  };
}
