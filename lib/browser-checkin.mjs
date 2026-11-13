// 浏览器签到
//
// 为什么必须用浏览器：签到接口要求 Turnstile 验证码（本账号 skip_captcha=false），
// 纯 HTTP POST 必然返回 422 captcha_failed。验证码 token 由站点的 Vue 组件
// 动态 window.turnstile.render 生成，且只存在于组件内部状态里。
//
// 所以这里不自己抓 token、也不自己拼 POST，而是：
//   打开 /checkin → 点站点自己的「签到」按钮 → 让它的前端取 token 并提交 → 轮询复核。
//
// 两层保险（参考同类项目的踩坑经验）：
//   1. 无头失败自动退回「有头」重试 —— Cloudflare 有时把无头判为可疑，
//      降级成阿里云滑块；有头窗口在多数情况下能自动过。
//   2. 最终失败时保存截图 + HTML 到 debug/，便于事后定位页面到底长什么样。

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

import { UA } from './net.mjs';
import { resolverRules } from './dns.mjs';

const CHECKIN_URL = 'https://2dfan.com/checkin';
const SNAPSHOT_KEEP = 10; // 保留最近 N 组快照

const STATUS_FETCH = async () => {
  try {
    const r = await fetch('/checkin/status.json', {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    });
    if (r.status !== 200) return { httpStatus: r.status };
    return { httpStatus: 200, ...(await r.json()) };
  } catch (e) {
    return { httpStatus: -1, error: String(e) };
  }
};

let log0 = () => {};

function launchOpts(rules, channel, headless) {
  return {
    channel,
    headless,
    viewport: { width: 1280, height: 920 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    userAgent: UA,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-breakpad',
      `--host-resolver-rules=${rules}`,
    ],
  };
}

async function launch(profileDir, rules, channel, headless) {
  try {
    return await chromium.launchPersistentContext(profileDir, launchOpts(rules, channel, headless));
  } catch (e) {
    log0(`配置目录启动失败（${String(e.message).slice(0, 80)}），改用临时目录`);
    const opts = launchOpts(rules, channel, headless);
    opts.args = [`--host-resolver-rules=${rules}`];
    return chromium.launchPersistentContext(profileDir + '-tmp', opts);
  }
}

/**
 * 把当前页面状态落盘：截图 + HTML。失败只记日志，不影响主流程。
 * 导出是为了能单独验证，也方便将来别处复用。
 */
export async function captureSnapshot(page, rootDir, log, tag = 'checkin') {
  const dir = path.join(rootDir, 'debug');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const base = path.join(dir, `${tag}-${stamp}`);

    let png = false;
    let html = false;
    try {
      await page.screenshot({ path: base + '.png', fullPage: false });
      png = true;
    } catch (e) {
      log.warn(`截图失败：${e.message.slice(0, 80)}`);
    }
    try {
      fs.writeFileSync(base + '.html', await page.content(), 'utf8');
      html = true;
    } catch (e) {
      log.warn(`保存 HTML 失败：${e.message.slice(0, 80)}`);
    }

    // 只保留最近 SNAPSHOT_KEEP 组
    try {
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.startsWith(tag + '-'))
        .sort();
      const stamps = [...new Set(files.map((f) => f.replace(/\.(png|html)$/, '')))];
      for (const old of stamps.slice(0, Math.max(0, stamps.length - SNAPSHOT_KEEP))) {
        for (const ext of ['.png', '.html']) {
          const f = path.join(dir, old + ext);
          if (fs.existsSync(f)) fs.unlinkSync(f);
        }
      }
    } catch {
      /* 清理失败不阻断 */
    }

    if (png || html) log.info(`已保存故障快照：${path.basename(base)}.png/.html`);
    return base;
  } catch (e) {
    log.warn(`保存快照整体失败：${e.message.slice(0, 100)}`);
    return null;
  }
}

async function attempt({ headless, timeoutMs, rules, root, channel, log }) {
  const tag = headless ? '无头' : '有头';
  log.info(`启动 Chrome（${tag}模式）`);

  const ctx = await launch(path.join(root, '.chrome-profile'), rules, channel, headless);
  let postResult = null;

  try {
    const page = ctx.pages()[0] || (await ctx.newPage());

    page.on('response', async (r) => {
      if (r.request().method() === 'POST' && r.url().includes('/checkin')) {
        try {
          postResult = { status: r.status(), body: (await r.text()).slice(0, 300) };
        } catch {
          /* ignore */
        }
      }
    });

    await page.goto(CHECKIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });

    if (page.url().includes('/login')) {
      log.warn(`${tag}模式：浏览器内会话已失效`);
      return { ok: false, reason: 'auth', cookies: null };
    }

    const cookiesNow = async () =>
      (await ctx.cookies().catch(() => [])).filter((c) => (c.domain || '').includes('2dfan.com'));

    const st = await page.evaluate(STATUS_FETCH).catch(() => ({ httpStatus: -1 }));
    if (st.httpStatus === 401) return { ok: false, reason: 'auth', cookies: await cookiesNow() };
    if (st.checked === true) {
      log.ok(`${tag}模式：页面显示今日已签到，跳过点击`);
      return { ok: true, already: true, status: st, cookies: await cookiesNow() };
    }

    const btn = page.locator('[data-island="NexusCheckin"] button', { hasText: '签到' });
    const count = await btn.count().catch(() => 0);
    if (!count) {
      log.error(`${tag}模式：页面上找不到签到按钮`);
      const snap = await captureSnapshot(page, root, log, headless ? 'checkin-headless' : 'checkin-headed');
      return { ok: false, reason: 'no-button', snapshot: snap, cookies: await cookiesNow() };
    }

    log.info(`${tag}模式：点击签到按钮，等待站点完成验证与提交`);
    // 有头模式下给人一点反应时间，并允许窗口被看见
    if (!headless) await page.bringToFront().catch(() => {});
    await btn.first().click({ timeout: 20000 }).catch((e) => log.warn(`点击异常：${e.message.slice(0, 100)}`));

    const deadline = Date.now() + timeoutMs;
    let last = st;
    while (Date.now() < deadline) {
      await page.waitForTimeout(3000);
      last = await page.evaluate(STATUS_FETCH).catch(() => last);
      if (last.checked === true) {
        log.ok(`${tag}模式：签到成功（页面状态已变为 checked=true）`, {
          user_points: last.user_points,
          serial_checkins: last.serial_checkins,
        });
        return { ok: true, status: last, post: postResult, cookies: await cookiesNow() };
      }
    }

    log.error(`${tag}模式：等待 ${Math.round(timeoutMs / 1000)}s 后仍未签到成功`, {
      post: postResult,
      last: last && { httpStatus: last.httpStatus, cooldown: last.cooldown },
    });
    const snap = await captureSnapshot(page, root, log, headless ? 'checkin-headless' : 'checkin-headed');
    return {
      ok: false,
      reason: 'timeout',
      status: last,
      post: postResult,
      snapshot: snap,
      cookies: await cookiesNow(),
    };
  } finally {
    await ctx.close().catch(() => {});
  }
}

/**
 * 签到主入口：先无头，失败（且非会话失效）再退有头重试。
 * 两次都失败时返回最后一次结果，并带上 headedTried 标记。
 */
export async function browserCheckin({
  log,
  root,
  channel = 'chrome',
  timeoutMs = 90000,
  headlessFirst = true,
  allowHeaded = true,
}) {
  log0 = log;
  const { rules, siteIps, tsIps } = await resolverRules();
  log.info(`浏览器签到：DoH 2dfan=${siteIps.join(',')} challenges=${tsIps.join(',') || '无'}`);

  const common = { rules, root, channel, log };

  if (headlessFirst) {
    const r = await attempt({ ...common, headless: true, timeoutMs });
    if (r.ok || r.reason === 'auth') return r;
    if (!allowHeaded) {
      log.warn('无头签到失败，且有头兜底已关闭');
      return r;
    }
    log.warn('无头签到失败，改用有头窗口重试（可能会弹出一个 Chrome 窗口）');
  }

  const r2 = await attempt({ ...common, headless: false, timeoutMs: Math.max(timeoutMs, 120000) });
  if (r2.ok || r2.reason === 'auth') return { ...r2, headedTried: true };
  return { ...r2, headedTried: true, headedAlsoFailed: true };
}
