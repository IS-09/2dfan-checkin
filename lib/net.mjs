// 网络层：DoH 解析 + 按 IP 直连（绕过本机 DNS 污染）+ Cookie 罐 + 退避重试
//
// 背景：本机对 2dfan.com 的 A 记录被污染（解析到 31.13.x.x / 157.240.x.x），
// 直连会 TCP 超时。因此这里一律先用 DoH 拿真实 Cloudflare 边缘 IP，
// 再以 SNI=2dfan.com 直连该 IP；TLS 证书仍按域名严格校验，安全性不打折。

import https from 'node:https';
import zlib from 'node:zlib';

export const SITE = '2dfan.com';
export const ORIGIN = `https://${SITE}`;
export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';

// DNS 完全不可用时的兜底（已实测可服务 2dfan.com 的 Cloudflare 边缘 IP）
const SEED_IPS = ['104.21.15.28', '172.67.204.208'];

// 只取第一家可用 DoH 的答案，避免把被污染的解析混进候选列表
const DOH_ENDPOINTS = [
  'https://doh.pub/dns-query?name=2dfan.com&type=A',
  'https://dns.alidns.com/resolve?name=2dfan.com&type=A',
];

let ipCache = { at: 0, ips: [] };
const IP_CACHE_MS = 10 * 60 * 1000;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function resolveIps({ timeoutMs = 6000, force = false } = {}) {
  if (!force && ipCache.ips.length && Date.now() - ipCache.at < IP_CACHE_MS) return ipCache.ips;

  const ips = [];
  for (const url of DOH_ENDPOINTS) {
    try {
      const r = await fetch(url, {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) continue;
      const j = await r.json();
      const answers = (j.Answer || []).filter((x) => x.type === 1).map((x) => x.data);
      if (answers.length) {
        for (const ip of answers) if (!ips.includes(ip)) ips.push(ip);
        break;
      }
    } catch {
      /* 换下一个 DoH */
    }
  }
  for (const ip of SEED_IPS) if (!ips.includes(ip)) ips.push(ip);

  ipCache = { at: Date.now(), ips };
  return ips;
}

export function forgetIps() {
  ipCache = { at: 0, ips: [] };
}

function decompress(raw, encoding) {
  const enc = String(encoding || '').toLowerCase();
  try {
    if (enc === 'gzip') return zlib.gunzipSync(raw);
    if (enc === 'deflate') return zlib.inflateSync(raw);
    if (enc === 'br') return zlib.brotliDecompressSync(raw);
  } catch {
    /* 内容本身可能就没压缩，忽略 */
  }
  return raw;
}

function requestOnce(ip, { method = 'GET', path, headers = {}, body = null, timeoutMs = 20000 }) {
  return new Promise((resolve, reject) => {
    const h = {
      Host: SITE,
      'user-agent': UA,
      accept: 'application/json, text/html;q=0.9, */*;q=0.8',
      'accept-encoding': 'gzip, deflate, br',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...headers,
    };
    let buf = null;
    if (body != null) {
      buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
      h['content-length'] = buf.length;
      if (!h['content-type']) h['content-type'] = 'application/json';
    }

    const req = https.request(
      { host: ip, port: 443, path, method, servername: SITE, headers: h, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const raw = decompress(Buffer.concat(chunks), res.headers['content-encoding']);
          resolve({ status: res.statusCode, headers: res.headers, body: raw.toString('utf8'), ip });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => {
      const e = new Error(`timeout after ${timeoutMs}ms`);
      e.code = 'ETIMEDOUT';
      req.destroy(e);
    });
    req.on('error', reject);
    if (buf) req.write(buf);
    req.end();
  });
}

/**
 * 发一个请求，自动在候选 IP 之间失败切换，并对网络错误做指数退避重试。
 * 返回 { status, headers, body, ip }；HTTP 状态码（含 4xx/5xx）不抛异常。
 */
export async function request(opts, { retries = 3, timeoutMs = 20000, log = () => {} } = {}) {
  let lastErr = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const ips = await resolveIps({ force: attempt > 1 });
    for (const ip of ips) {
      try {
        const res = await requestOnce(ip, { ...opts, timeoutMs });
        // Cloudflare 边缘会带 cf-ray；用于确认打到的是"对的"服务器而不是被劫持的 IP
        if (res.headers['cf-ray']) return res;
        if (res.status < 500) return res;
        lastErr = new Error(`HTTP ${res.status} from ${ip}`);
      } catch (e) {
        lastErr = e;
        log('warn', `连接 ${ip} 失败：${e.code || e.message}`);
      }
    }
    if (attempt < retries) {
      const wait = 1500 * 2 ** (attempt - 1);
      log('warn', `第 ${attempt} 轮全部失败，${wait}ms 后重试`);
      await sleep(wait);
    }
  }
  throw lastErr || new Error('request failed');
}

export class CookieJar {
  constructor(cookies = []) {
    this.map = new Map();
    for (const c of cookies) this.set(c);
  }

  set(c) {
    if (!c || !c.name) return;
    this.map.set(c.name, {
      name: c.name,
      value: c.value,
      domain: c.domain || SITE,
      path: c.path || '/',
      expires: typeof c.expires === 'number' ? c.expires : -1,
      httpOnly: !!c.httpOnly,
      secure: !!c.secure,
    });
  }

  absorb(setCookieHeaders) {
    const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : setCookieHeaders ? [setCookieHeaders] : [];
    for (const line of list) {
      const [pair] = String(line).split(';');
      const idx = pair.indexOf('=');
      if (idx <= 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      const exp = /expires=([^;]+)/i.exec(line);
      this.set({ name, value, expires: exp ? Date.parse(exp[1]) : -1 });
    }
  }

  header() {
    return [...this.map.values()].map((c) => `${c.name}=${c.value}`).join('; ');
  }

  toArray() {
    return [...this.map.values()];
  }

  get size() {
    return this.map.size;
  }
}
