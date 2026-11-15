// 站点层：会话持久化 + 签到相关接口封装
import fs from 'node:fs';
import path from 'node:path';
import { request, CookieJar, ORIGIN } from './net.mjs';

export class AuthError extends Error {
  constructor(message) {
    super(message || '会话已失效');
    this.name = 'AuthError';
    this.code = 'ERR_AUTH';
  }
}

export class Site {
  constructor({ cookieFile, log }) {
    this.cookieFile = cookieFile;
    this.log = log || (() => {});
    this.jar = new CookieJar();
    this._csrf = null;
  }

  loadCookies() {
    try {
      const raw = fs.readFileSync(this.cookieFile, 'utf8');
      const arr = JSON.parse(raw);
      this.jar = new CookieJar(Array.isArray(arr) ? arr : arr.cookies || []);
      return this.jar.size;
    } catch {
      this.jar = new CookieJar();
      return 0;
    }
  }

  saveCookies(cookies) {
    const list = cookies || this.jar.toArray();
    fs.mkdirSync(path.dirname(this.cookieFile), { recursive: true });
    fs.writeFileSync(this.cookieFile, JSON.stringify(list, null, 2), 'utf8');
  }

  get hasCookies() {
    return this.jar.size > 0;
  }

  async fetch(pathname, { method = 'GET', body = null, headers = {}, retries = 3 } = {}) {
    const h = { ...headers };
    if (this.jar.size) h.cookie = this.jar.header();
    // net.request 的 log 参数是函数（level, msg），而这里的 this.log 是日志对象；
    // 传对象会在「连接失败」分支抛 TypeError 并掩盖真实错误，必须取 .raw 适配器。
    const logFn = typeof this.log === 'function' ? this.log : this.log?.raw ?? (() => {});
    const res = await request({ method, path: pathname, body, headers: h }, { retries, log: logFn });
    this.jar.absorb(res.headers['set-cookie']);
    return res;
  }

  /** 取 CSRF token：优先签到页，其次首页 */
  async csrfToken() {
    if (this._csrf) return this._csrf;
    for (const p of ['/checkin', '/']) {
      const res = await this.fetch(p, { headers: { accept: 'text/html' } });
      const m = /<meta[^>]+name="csrf-token"[^>]+content="([^"]+)"/i.exec(res.body || '');
      if (m) {
        this._csrf = m[1];
        return this._csrf;
      }
    }
    return null;
  }

  /** GET /checkin/status.json → { checked, user_points, serial_checkins, ... } */
  async status() {
    const res = await this.fetch('/checkin/status.json', {
      headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
    });

    if (res.status === 401) {
      let msg = '请先登录';
      try {
        const j = JSON.parse(res.body);
        msg = Array.isArray(j.message) ? j.message.join(' ') : j.message || msg;
      } catch {}
      throw new AuthError(msg);
    }
    if (res.status !== 200) {
      throw new Error(`status.json 返回 HTTP ${res.status}: ${(res.body || '').slice(0, 200)}`);
    }
    try {
      return JSON.parse(res.body);
    } catch {
      throw new Error(`status.json 不是合法 JSON: ${(res.body || '').slice(0, 200)}`);
    }
  }

  /** POST /checkin —— 返回 { ok, status, body, errorCode, message } */
  async checkin() {
    const token = await this.csrfToken();
    const headers = {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      origin: ORIGIN,
      referer: `${ORIGIN}/checkin`,
      'x-requested-with': 'XMLHttpRequest',
    };
    if (token) headers['x-csrf-token'] = token;

    // 单次尝试：签到是写操作，重试交给外层（外层每次都会先查状态，避免重复签到）
    const res = await this.fetch('/checkin', { method: 'POST', body: {}, headers, retries: 1 });

    let parsed = null;
    try {
      parsed = JSON.parse(res.body);
    } catch {}

    const errorCode = parsed?.error || parsed?.code || null;
    const message = Array.isArray(parsed?.message)
      ? parsed.message.join(' ')
      : parsed?.message || parsed?.error_description || (res.body || '').slice(0, 200);

    return {
      ok: res.status >= 200 && res.status < 300 && !errorCode,
      status: res.status,
      body: res.body,
      parsed,
      errorCode,
      message,
    };
  }
}
