// DNS：本机对 2dfan.com 的解析被污染，统一走 DoH 拿真实 IP
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
  const siteIps = site.length ? site : fallbackSiteIps;
  if (!siteIps.length) throw new Error('DoH 未能解析 2dfan.com');
  const rules = [`MAP 2dfan.com ${siteIps[0]}`];
  if (ts.length) rules.push(`MAP challenges.cloudflare.com ${ts[0]}`);
  return { rules: rules.join(', '), siteIps, tsIps: ts };
}
