// 一次性登录 CLI：换取长效会话 Cookie → cookies.json
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './lib/config.mjs';
import { decryptPassword } from './lib/secret.mjs';
import { makeLogger } from './lib/log.mjs';
import { Site } from './lib/site.mjs';
import { browserLogin } from './lib/browser-login.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const COOKIE_FILE = path.join(ROOT, 'cookies.json');
const log = makeLogger(path.join(ROOT, 'logs'));

async function main() {
  const cfg = loadConfig(ROOT);
  const password = decryptPassword(cfg.passwordDpapi);

  const cookies = await browserLogin({
    log,
    login: cfg.login,
    password,
    root: ROOT,
    headlessFirst: cfg.browser.headlessFirst,
    channel: cfg.browser.channel,
  });

  if (!cookies || !cookies.length) {
    log.error('登录失败：未取得 Cookie');
    process.exit(2);
  }

  const site = new Site({ cookieFile: COOKIE_FILE, log });
  site.saveCookies(cookies);
  log.ok(`已保存 ${cookies.length} 个 Cookie → cookies.json`);

  site.loadCookies();
  try {
    const st = await site.status();
    log.ok('HTTP 交叉验证通过', {
      checked: st.checked,
      user_points: st.user_points,
      serial_checkins: st.serial_checkins,
    });
    process.exit(0);
  } catch (e) {
    log.error(`HTTP 交叉验证失败：${e.message}`);
    process.exit(3);
  }
}

main().catch((e) => {
  log.error(`未捕获异常：${e.message}`);
  console.error(e);
  process.exit(1);
});
