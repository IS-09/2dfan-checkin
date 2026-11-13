// 每日签到主程序
//
// 路径选择（依据服务端 /checkin/status.json 的 skip_captcha）：
//   skip_captcha = true  → 纯 HTTP 直接 POST /checkin
//   skip_captcha = false → 走无头 Chrome 取 Turnstile token 再 POST（本账号当前是这种情况）
//
// 安全原则（"一日只签一次"）：服务器 checked 是唯一事实来源。
// 任何写操作前后都重新确认状态；重试前必先重查，避免网络抖动导致重复签到。
//
// 用法：
//   node checkin_daily.mjs            正常签到
//   node checkin_daily.mjs --dry-run  只读状态，不签到
//   node checkin_daily.mjs --force    忽略 cooldown 标记强行尝试

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './lib/config.mjs';
import { decryptPassword } from './lib/secret.mjs';
import { makeLogger } from './lib/log.mjs';
import { Site, AuthError } from './lib/site.mjs';
import { browserLogin } from './lib/browser-login.mjs';
import { browserCheckin } from './lib/browser-checkin.mjs';
import { notifyFail } from './lib/notify.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const COOKIE_FILE = path.join(ROOT, 'cookies.json');
const STATE_FILE = path.join(ROOT, 'state.json');
const LOG_DIR = path.join(ROOT, 'logs');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const FORCE = argv.includes('--force');

const log = makeLogger(LOG_DIR);

const EXIT = {
  OK_SIGNED: 0,
  OK_ALREADY: 0,
  OK_DRY: 0,
  ERR_UNKNOWN: 1,
  ERR_AUTH: 2,
  ERR_COOLDOWN: 4,
  ERR_UNVERIFIED: 5,
  ERR_CAPTCHA: 6,
  ERR_NET: 7,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return { consecutive_failures: 0, last: null, history: [] };
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

function record(state, result, detail) {
  const entry = { date: today(), at: new Date().toISOString(), result, ...detail };
  state.last = entry;
  state.history = [entry, ...(state.history || [])].slice(0, 60);
  state.consecutive_failures = String(result).startsWith('OK_') ? 0 : (state.consecutive_failures || 0) + 1;
  writeState(state);
  return state;
}

function newSite() {
  const s = new Site({ cookieFile: COOKIE_FILE, log });
  s.loadCookies();
  return s;
}

async function relogin(cfg) {
  log.warn('会话失效，启动浏览器自动重新登录');
  const password = decryptPassword(cfg.passwordDpapi);
  const cookies = await browserLogin({
    log,
    login: cfg.login,
    password,
    root: ROOT,
    headlessFirst: cfg.browser.headlessFirst,
    channel: cfg.browser.channel,
  });
  if (!cookies || !cookies.length) return null;
  const site = newSite();
  site.saveCookies(cookies);
  site.loadCookies();
  log.ok('已自动重新登录并更新 Cookie');
  return site;
}

/** 纯 HTTP 签到路径（仅当服务端 skip_captcha=true 时可用） */
async function httpCheckin(cfg, site, before) {
  let last = null;
  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    if (attempt > 1) {
      const st = await site.status().catch(() => null);
      if (st?.checked === true) break;
    }
    log.info(`HTTP 提交签到（第 ${attempt}/${cfg.maxAttempts} 次）`);
    try {
      last = await site.checkin();
    } catch (e) {
      last = { ok: false, status: 0, errorCode: 'network', message: e.message };
    }
    if (last.ok) break;

    log.warn('签到未成功', { status: last.status, errorCode: last.errorCode, message: String(last.message || '').slice(0, 160) });
    if (String(last.errorCode || '').includes('captcha')) return { path: 'http', captcha: true, last };
    if (attempt < cfg.maxAttempts) await sleep(cfg.retryDelayMs * attempt);
  }
  return { path: 'http', captcha: false, last };
}

async function main() {
  const cfg = loadConfig(ROOT);
  const state = readState();

  log.info(`===== 开始签到 ${new Date().toLocaleString('zh-CN')}${DRY ? '（dry-run）' : ''} =====`);

  let site = newSite();
  log.info(`已载入 ${site.jar.size} 个 Cookie`);

  let status;
  try {
    status = await site.status();
  } catch (e) {
    if (!(e instanceof AuthError)) throw e;
    log.warn(`会话失效（${e.message}）`);
    site = await relogin(cfg);
    if (!site) {
      log.error('自动重新登录失败，需人工执行 login_once.mjs');
      record(state, 'ERR_AUTH', { message: e.message });
      return EXIT.ERR_AUTH;
    }
    status = await site.status();
  }

  log.info('当前状态', {
    checked: status.checked,
    user_points: status.user_points,
    serial_checkins: status.serial_checkins,
    cooldown: status.cooldown,
    skip_captcha: status.skip_captcha,
  });

  // 1. 今天已经签过 —— 直接成功退出，绝不重复提交
  if (status.checked === true) {
    log.ok('今日已签到，无需操作', { serial_checkins: status.serial_checkins });
    record(state, 'OK_ALREADY', { user_points: status.user_points, serial_checkins: status.serial_checkins });
    return EXIT.OK_ALREADY;
  }

  if (DRY) {
    log.ok('dry-run：今日尚未签到（未执行签到动作）');
    return EXIT.OK_DRY;
  }

  // cooldown 只作提示：它表示"刚刚签过、等次日重置"，跨日边界上可能与 checked 不同步。
  // 因此不硬跳过，照常尝试；真失败时再归类为 ERR_COOLDOWN，避免误判成"今天不用签"。
  const cooldownHint = status.cooldown === true && !FORCE;
  if (cooldownHint) {
    log.warn(`站点标记 cooldown（${status.cooldown_at || '时间未知'}），仍尝试签到`);
  }

  const before = { user_points: status.user_points, serial_checkins: status.serial_checkins };
  let outcome;

  if (status.skip_captcha === true) {
    outcome = await httpCheckin(cfg, site, before);
  } else {
    // 需要 Turnstile：走浏览器（先无头，失败自动退有头）
    let r = await browserCheckin({
      log,
      root: ROOT,
      channel: cfg.browser.channel,
      allowHeaded: cfg.headedFallback,
    });

    if (r.reason === 'auth') {
      const re = await relogin(cfg);
      if (!re) {
        record(state, 'ERR_AUTH', { message: '浏览器内会话失效且自动登录失败' });
        return EXIT.ERR_AUTH;
      }
      site = re;
      r = await browserCheckin({
        log,
        root: ROOT,
        channel: cfg.browser.channel,
        allowHeaded: cfg.headedFallback,
      });
    }

    // 浏览器可能刷新过 Cookie，同步回 HTTP 侧
    if (r.cookies && r.cookies.length) {
      site.saveCookies(r.cookies);
      site.loadCookies();
    }

    const captchaBlocked = r.reason === 'timeout' || r.reason === 'no-button';
    outcome = { path: 'browser', captcha: captchaBlocked, last: r };

    if (!r.ok) {
      log.error('浏览器签到未成功', {
        reason: String(r.reason).slice(0, 200),
        headedTried: !!r.headedTried,
        snapshot: r.snapshot ? path.basename(r.snapshot) : null,
        post: r.post,
      });
    }
  }

  // 2. 不信任 POST 的返回值，必须用 status.json 复核
  const verify = await site.status().catch((e) => {
    log.error(`复核状态失败：${e.message}`);
    return null;
  });

  if (verify?.checked === true) {
    const gained = before.user_points == null ? null : verify.user_points - before.user_points;
    log.ok('签到成功并已复核', {
      via: outcome.path,
      user_points: verify.user_points,
      gained,
      serial_checkins: verify.serial_checkins,
      before_serial: before.serial_checkins,
    });
    record(state, 'OK_SIGNED', {
      via: outcome.path,
      user_points: verify.user_points,
      gained,
      serial_checkins: verify.serial_checkins,
    });
    return EXIT.OK_SIGNED;
  }

  if (cooldownHint) {
    log.warn('签到未成功且站点处于 cooldown，可能需等次日重置后再签', { cooldown_at: status.cooldown_at });
    record(state, 'ERR_COOLDOWN', { via: outcome.path, cooldown_at: status.cooldown_at });
    return EXIT.ERR_COOLDOWN;
  }

  if (outcome.captcha) {
    log.error('未取得验证码 token，签到无法完成（可能需要人工在浏览器完成验证）', {
      snapshot: outcome.last?.snapshot ? path.basename(outcome.last.snapshot) : null,
    });
    record(state, 'ERR_CAPTCHA', {
      via: outcome.path,
      snapshot: outcome.last?.snapshot ? path.basename(outcome.last.snapshot) : null,
    });
    return EXIT.ERR_CAPTCHA;
  }

  log.error('签到后复核仍为未签到', {
    via: outcome.path,
    last: outcome.last && { status: outcome.last.status, message: String(outcome.last.message || outcome.last.body || '').slice(0, 200) },
  });
  record(state, 'ERR_UNVERIFIED', {
    via: outcome.path,
    message: String(outcome.last?.message || outcome.last?.body || '').slice(0, 200),
  });
  return EXIT.ERR_UNVERIFIED;
}

main()
  .then((code) => {
    const state = readState();
    if (code !== 0 && (state.consecutive_failures || 0) >= 2) {
      const ok = notifyFail('2DFan 自动签到失败', `已连续 ${state.consecutive_failures} 次失败，请查看 logs 目录。`);
      log.info(`已尝试弹出失败通知（${ok ? '已调用' : '调用失败'}）`);
    }
    process.exit(code);
  })
  .catch((e) => {
    log.error(`未捕获异常：${e.message}`);
    console.error(e);
    process.exit(EXIT.ERR_UNKNOWN);
  });
