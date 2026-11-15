// DNS：本机对 2dfan.com 的解析被污染，统一走 DoH 拿真实 IP。
// 注意：DoH 本身也会间歇性返回被污染的假地址（实测拿到过 31.13.95.33 / 128.121.243.106），
// 所以必须再用 Cloudflare 网段过滤一遍，否则会把假 IP 塞给 Chrome 的 --host-resolver-rules，
// 导致浏览器直接打不开页面。
import { isCloudflareIp, SEED_IPS } from './net.mjs';

export async function doh(host) {
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

/** 给 Chrome 的 --host-resolver-rules，强制把域名指到真实 IP */
export async function resolverRules(fallbackSiteIps = []) {
  const [site, ts] = await Promise.all([doh('2dfan.com'), doh('challenges.cloudflare.com')]);

  const siteGood = site.filter(isCloudflareIp);
  const tsGood = ts.filter(isCloudflareIp);
  const suspect = [...site.filter((ip) => !isCloudflareIp(ip)), ...ts.filter((ip) => !isCloudflareIp(ip))];

  const siteIps = siteGood.length ? siteGood : fallbackSiteIps.length ? fallbackSiteIps : SEED_IPS;
  if (!siteIps.length) throw new Error('DoH 未能解析 2dfan.com');

  const rules = [`MAP 2dfan.com ${siteIps[0]}`];
  if (tsGood.length) rules.push(`MAP challenges.cloudflare.com ${tsGood[0]}`);

  return {
    rules: rules.join(', '),
    siteIps,
    tsIps: tsGood,
    suspect, // 被判为污染、已丢弃的地址，供上层打日志
  };
}
