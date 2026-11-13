// 浏览器登录模块：供 login_once.mjs 与 checkin_daily.mjs 复用。
//
// 两个关键实现点（踩坑换来的）：
// 1. 本机 DNS 被污染 → 用 --host-resolver-rules 给 Chrome 指定真实 IP，
//    否则 Turnstile 的 challenges.cloudflare.com 加载失败会退化到阿里云滑块。
// 2. 登录页在 submit 捕获阶段装了守卫（captchaType 状态不对就 preventDefault + alert），
//    点按钮会被它拦掉、压根不发 POST。所以改为在页面上下文里用 fetch 提交表单。

import path from 'node:path';
import { chromium } from 'playwright-core';

import { UA, resolveIps } from './net.mjs';

const LOGIN_URL = 'https://2dfan.com/login';

async function doh(host) {
  try {
    const r = await fetch(`https://doh.pub/dns-query?name=${host}&type=A`, {
      headers: { accept: 'application/dns-json' },
      signal: AbortSignal.timeout(8000),
    });
    const j = await r.json();
    return (j.Answer || []).filter((a) => a.type === 1).map((a) => a.data);
  } catch {
    return [];
  }
}

function buildResolverRules(siteIps, tsIps) {
  const rules = [`MAP 2dfan.com ${siteIps[0]}`];
  if (tsIps.length) rules.push(`MAP challenges.cloudflare.com ${tsIps[0]}`);
  return rules.join(', ');
}

async function launch(profileDir, headless, resolverRules, channel) {
  return chromium.launchPersistentContext(profileDir, {
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
      `--host-resolver-rules=${resolverRules}`,
    ],
  });
}

async function attempt({ headless, waitMs, resolverRules, login, password, profileDir, channel, log }) {
  const tag = headless ? '无头' : '有头';
  log.info(`启动 Chrome（${tag}模式）`);

  let ctx;
  try {
    ctx = await launch(profileDir, headless, resolverRules, channel);
  } catch (e) {
    log.warn(`默认配置目录启动失败（${String(e.message).slice(0, 80)}），改用临时目录`);
    ctx = await launch(profileDir + '-tmp', headless, resolverRules, channel);
  }

  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    const dialogs = [];
    page.on('dialog', async (d) => {
      dialogs.push(d.message());
      await d.dismiss().catch(() => {});
    });

    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    log.info(`已打开：${page.url()}`);

    // profile 里可能还留着上次的会话，已登录就直接取 Cookie
    const existing = await page
      .evaluate(async () => {
        try {
          const r = await fetch('/checkin/status.json', {
            headers: { accept: 'application/json' },
            credentials: 'same-origin',
          });
          return r.status;
        } catch {
          return -1;
        }
      })
      .catch(() => -1);

    if (existing === 200) {
      log.ok('浏览器配置已是登录态，直接读取 Cookie');
      return (await ctx.cookies()).filter((c) => (c.domain || '').includes('2dfan.com'));
    }

    let token = '';
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      token = await page
        .evaluate(() => document.querySelector('input[name="cf-turnstile-response"]')?.value || '')
        .catch(() => '');
      if (token) break;
      await page.waitForTimeout(800);
    }
    if (!token) {
      log.warn(`${tag}模式：${Math.round(waitMs / 1000)}s 内未拿到 Turnstile token`);
      if (headless) return null;
    } else {
      log.info(`Turnstile token 已取得（${token.length} 字符）`);
    }

    const result = await page.evaluate(
      async ({ loginId, pwd }) => {
        const form = document.querySelector('form.nexus-login-form');
        if (!form) return { ok: false, reason: '找不到登录表单' };
        form.querySelector('#login').value = loginId;
        form.querySelector('#password').value = pwd;
        const cb = form.querySelector('input[name="remember_me"]');
        if (cb) cb.checked = true;

        const res = await fetch('/login', {
          method: 'POST',
          body: new FormData(form),
          credentials: 'same-origin',
          redirect: 'follow',
        });
        const html = await res.text();

        let status = 0;
        let body = '';
        try {
          const r2 = await fetch('/checkin/status.json', {
            headers: { accept: 'application/json' },
            credentials: 'same-origin',
          });
          status = r2.status;
          body = (await r2.text()).slice(0, 200);
        } catch (e) {
          body = String(e);
        }

        const errs = [...html.matchAll(/class="[^"]*(?:error|alert)[^"]*"[^>]*>([^<]{2,80})</gi)]
          .map((m) => m[1].trim())
          .slice(0, 4);

        return { ok: status === 200, status, body, errs, postStatus: res.status };
      },
      { loginId: login, pwd: password },
    );

    if (result.ok) {
      log.ok('登录成功（status.json 返回 200）');
      return (await ctx.cookies()).filter((c) => (c.domain || '').includes('2dfan.com'));
    }

    log.error('登录未成功', {
      postStatus: result.postStatus,
      statusJson: result.status,
      errs: result.errs,
      dialogs,
      msg: result.reason || result.body,
    });
    return null;
  } finally {
    await ctx.close().catch(() => {});
  }
}

/**
 * 走浏览器登录，返回 2dfan.com 的 Cookie 数组；失败返回 null。
 * 先无头尝试，失败且有头（只有交互场景才需要人）。
 */
export async function browserLogin({ log, login, password, root, headlessFirst = true, channel = 'chrome' }) {
  const [siteIpsRaw, tsIps] = await Promise.all([doh('2dfan.com'), doh('challenges.cloudflare.com')]);
  const siteIps = siteIpsRaw.length ? siteIpsRaw : await resolveIps();
  if (!siteIps.length) throw new Error('DoH 未能解析 2dfan.com');
  const resolverRules = buildResolverRules(siteIps, tsIps);
  log.info(`DoH：2dfan.com → ${siteIps.join(',')}；challenges → ${tsIps.join(',') || '无'}`);

  const profileDir = path.join(root, '.chrome-profile');

  if (headlessFirst) {
    const c = await attempt({
      headless: true,
      waitMs: 25000,
      resolverRules,
      login,
      password,
      profileDir,
      channel,
      log,
    });
    if (c && c.length) return c;
  }

  log.warn('无头未成功，切换到有头窗口（如需验证请在弹出的窗口中完成）');
  return attempt({
    headless: false,
    waitMs: 180000,
    resolverRules,
    login,
    password,
    profileDir,
    channel,
    log,
  });
}
