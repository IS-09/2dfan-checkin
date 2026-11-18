// 人机验证自动处理：Cloudflare Turnstile 复选框 + 阿里云滑块兜底。
//
// 今天真实遇到的两级挑战：
//   1) Turnstile 进入交互态：界面上是个「验证您是真实用户」复选框，不点就拿不到 token；
//   2) Turnstile 没过时，站点降级成阿里云滑块弹窗（「请按住滑块，拖动到最右边」），
//      不拖到最右，前端就不会发 POST /checkin。
//
// 本模块只负责"替人做动作"，是否真的通过由调用方轮询 status.json 判断。

/** Turnstile token 是否已经拿到 */
export async function hasTurnstileToken(page) {
  try {
    return await page.evaluate(() => {
      const el = document.querySelector('input[name="cf-turnstile-response"]');
      return !!(el && el.value);
    });
  } catch {
    return false;
  }
}

/** 阿里云滑块弹窗是否可见 */
export async function aliyunSliderVisible(page) {
  try {
    const h = page.locator('#aliyunCaptcha-sliding-slider').first();
    if ((await h.count()) === 0) return false;
    const box = await h.boundingBox();
    return !!(box && box.width > 5 && box.height > 5);
  } catch {
    return false;
  }
}

/** 人机验证弹窗是否还在（还在说明没通过） */
export async function challengeModalVisible(page) {
  try {
    const m = page.locator('.captcha-modal-body').first();
    if ((await m.count()) === 0) return false;
    return await m.isVisible().catch(() => false);
  } catch {
    return false;
  }
}

function challengeFrames(page) {
  return page.frames().filter((f) => (f.url() || '').includes('challenges.cloudflare.com'));
}

// Turnstile 在这个站点不是标准的 .cf-turnstile 容器，而是站点自己的包装：
// .checkin-captcha-float（签到按钮旁）与 .captcha-render-area（验证弹窗内）。
// 只认 .cf-turnstile 会找不到 widget，等于点在空 iframe 上。
const WIDGET_SELECTORS = [
  '.checkin-captcha-float',
  '.captcha-render-area',
  '.cf-turnstile',
  'iframe[src*="challenges.cloudflare.com"]',
];

async function widgetBox(page) {
  for (const sel of WIDGET_SELECTORS) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) === 0) continue;
      const box = await loc.boundingBox();
      if (!box || box.width < 10 || box.height < 10) continue;

      // 容器里若有 iframe，用 iframe 的盒子点击更准（复选框在 iframe 内左上）
      try {
        const ifr = loc.locator('iframe').first();
        if ((await ifr.count()) > 0) {
          const ib = await ifr.boundingBox();
          if (ib && ib.width > 10 && ib.height > 10) return ib;
        }
      } catch {
        /* 用容器盒子兜底 */
      }
      return box;
    } catch {
      /* 换下一个选择器 */
    }
  }
  return null;
}

/** 阿里云滑块是否"可拖"（还在「验证码加载中」时拖了也没用） */
export async function aliyunSliderReady(page) {
  try {
    return await page.evaluate(() => {
      const area = document.querySelector('.captcha-modal-body');
      if (!area) return false;
      const txt = (area.innerText || '').replace(/\s+/g, ' ');
      return !txt.includes('加载中');
    });
  } catch {
    return false;
  }
}

/** 点 Turnstile 复选框 */
export async function tryPassTurnstile(page, log = {}) {
  if (await hasTurnstileToken(page)) return false;

  // 1) iframe 内真的有复选框才点（空 iframe 的 body 点了等于没点）
  for (const f of challengeFrames(page)) {
    try {
      const cb = f.locator('input[type="checkbox"]');
      if ((await cb.count()) > 0) {
        await cb.first().click({ timeout: 2500 });
        return true;
      }
    } catch {
      /* 换下一种方式 */
    }
  }

  // 2) 按 widget 盒子坐标点（复选框在部件左侧固定偏移处）
  const box = await widgetBox(page);
  if (!box) return false;

  const x = box.x + Math.min(28, box.width / 3);
  const y = box.y + box.height / 2;
  try {
    await page.mouse.move(x - 60, y - 25, { steps: 8 });
    await page.waitForTimeout(120 + Math.floor(Math.random() * 180));
    await page.mouse.move(x, y, { steps: 12 });
    await page.waitForTimeout(80 + Math.floor(Math.random() * 120));
    await page.mouse.click(x, y);
    return true;
  } catch (e) {
    log.warn?.(`点击 Turnstile 失败：${String(e.message).slice(0, 80)}`);
    return false;
  }
}

/**
 * 把阿里云滑块从最左拖到最右。返回 true 表示做了拖动动作。
 * 轨迹做了加速→减速 + 轻微纵向抖动，避免被判成机器直线。
 */
export async function dragAliyunSlider(page, log = {}) {
  const handle = page.locator('#aliyunCaptcha-sliding-slider').first();
  const track = page.locator('#aliyunCaptcha-sliding-body').first();

  const hb = await handle.boundingBox().catch(() => null);
  const tb = await track.boundingBox().catch(() => null);
  if (!hb || !tb) return false;

  const sx = hb.x + hb.width / 2;
  const sy = hb.y + hb.height / 2;
  const endX = tb.x + tb.width - hb.width / 2 - 2;

  try {
    await page.mouse.move(sx - 30, sy + 8, { steps: 6 });
    await page.waitForTimeout(100 + Math.floor(Math.random() * 120));
    await page.mouse.move(sx, sy, { steps: 6 });
    await page.mouse.down();

    const steps = 28;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      // 先快后慢，接近终点时更细
      const eased = 1 - Math.pow(1 - t, 2.2);
      const x = sx + (endX - sx) * eased;
      const y = sy + Math.sin(t * Math.PI) * 2.5;
      await page.mouse.move(x, y);
      await page.waitForTimeout(8 + Math.floor(Math.random() * 18));
    }
    await page.waitForTimeout(120);
    await page.mouse.up();
    return true;
  } catch (e) {
    log.warn?.(`拖动滑块失败：${String(e.message).slice(0, 80)}`);
    return false;
  }
}

/** 滑块通过后点弹窗里的「确认」 */
export async function confirmChallengeModal(page, log = {}) {
  try {
    const btn = page.locator('.captcha-modal-body .n-button--primary-type, .n-modal .n-button--primary-type').first();
    if ((await btn.count()) === 0) return false;
    if (await btn.isDisabled().catch(() => true)) return false;
    await btn.click({ timeout: 3000 });
    return true;
  } catch (e) {
    log.warn?.(`点击确认失败：${String(e.message).slice(0, 80)}`);
    return false;
  }
}

/** 滑块是否已经拖过并通过 */
export async function aliyunSliderSolved(page) {
  try {
    return await page.evaluate(() => {
      const body = document.querySelector('#aliyunCaptcha-sliding-body');
      if (body && /verified|success/i.test(String(body.className || ''))) return true;
      const tb = document.querySelector('#aliyunCaptcha-sliding-text-box');
      const text = tb ? tb.textContent || '' : '';
      return /验证通过|已通过/.test(text);
    });
  } catch {
    return false;
  }
}

/**
 * 统一入口：按当前页面状态选一种动作。
 * 返回 'slider' | 'turnstile' | null
 */
export async function trySolveChallenge(page, log = {}) {
  if (await hasTurnstileToken(page)) return null;

  // 阿里云滑块弹窗优先（Turnstile 已经降级时它才是真正的关卡）
  if (await aliyunSliderVisible(page)) {
    if (!(await aliyunSliderReady(page))) return null; // 还在加载，拖了无效
    const dragged = await dragAliyunSlider(page, log);
    return dragged ? 'slider' : null;
  }

  if (await challengeModalVisible(page)) {
    // 弹窗在但滑块还没渲染出来（"验证码加载中..."），先别乱点
    return null;
  }

  const clicked = await tryPassTurnstile(page, log);
  return clicked ? 'turnstile' : null;
}
