# 2dfan 自动签到

每天定时在 [2dfan.com](https://2dfan.com) 自动完成签到。Windows 计划任务驱动，无头浏览器，不弹窗，一天只签一次。

> **本仓库不含任何账号、Cookie 或会话数据。** `config.json`、`cookies.json`、`.chrome-profile/` 等全部被 `.gitignore` 排除，所有凭据都需要用你自己的账号在本地生成。

## 为什么不是几十行的 requests 脚本

两个现实障碍决定了这个实现：

**1. 签到接口强制人机验证。** `POST /checkin` 会校验 Cloudflare Turnstile token，缺失时返回：

```json
HTTP 422  {"error":"captcha_failed","message":"请完成验证"}
```

token 由站点 Vue 组件动态 `window.turnstile.render()` 生成，只存在于组件内部状态，无法从 DOM 或接口预先取得。所以签到动作必须交给真实浏览器完成——本项目让无头 Chrome 打开 `/checkin` 并点击站点自己的按钮，由站点前端取 token 并提交。

**2. 部分网络环境下 `2dfan.com` 的 DNS 被污染。** 会被解析到 `31.13.x.x` / `157.240.x.x` 这类地址，TCP 443 直接超时；连 `dns.alidns.com` 的 DoH 都返回污染结果。因此本项目：

- 每次运行先用 DoH（`doh.pub`）取真实 Cloudflare 边缘 IP，再按 **IP + SNI** 直连（TLS 仍按域名严格校验，安全性不打折）
- 给 Chrome 传 `--host-resolver-rules` 做同样的事，否则 Turnstile 依赖的 `challenges.cloudflare.com` 也可能加载失败

如果你所在网络没有污染问题，这两层机制不会产生副作用。

## 工作原理

```
Windows 计划任务（00:05 / 00:35 / 09:05 / 登录后 2 分钟）
   └─ node checkin_daily.mjs
        ├─ DoH 解析真实 IP → 按 IP+SNI 直连
        ├─ GET /checkin/status.json
        │    ├─ checked=true  → 今日已签，直接退出（不开浏览器，约 3 秒）
        │    └─ checked=false → 无头 Chrome 打开 /checkin
        │                          → 点站点自己的「签到」按钮
        │                          → 站点前端取 Turnstile token 并提交
        │                          → 再查 status.json 复核 checked=true
        │                          → 无头失败则退回「有头窗口」重试一次
        └─ 结果写 logs/；最终失败时把页面截图+HTML 存进 debug/ 并弹通知
```

### 关键设计：一日只签一次

服务器 `/checkin/status.json` 的 `checked` 是**唯一事实来源**：

- 已签到直接退出，不发任何写请求
- 每次写操作**前后**都重新查询状态
- 重试前必先重查，避免网络抖动导致重复签到
- 因此四个触发时间重叠也不会重复签到

### 关键设计：不信任返回值

`POST /checkin` 返回成功不算数，必须再用 `status.json` 确认 `checked === true` 才判定成功，避免把「请求发出去了」误当「签到成功了」。

## 特性

| 特性 | 说明 |
|---|---|
| 一日只签一次 | 服务器状态为准 + 本地记录 + 任务单次触发，三重保障 |
| 自动识别成功 | 写操作后强制复核，五类结果码可区分 |
| 快速短路 | 已签到时 3 秒结束，完全不启动浏览器 |
| 无头优先 | 日常不弹窗；无头失败才退有头重试 |
| 故障快照 | 失败时保存页面 `.png` + `.html`（保留最近 10 组） |
| 密码加密 | Windows DPAPI（CurrentUser），换机器/换账户都解不开 |
| 绕过 DNS 污染 | DoH 解析 + IP 直连，不依赖系统 DNS |
| 失败才通知 | 连续 2 天失败才弹桌面通知，成功不打扰 |
| 零浏览器下载 | 复用本机已安装的 Chrome，不需要 playwright 下载 Chromium |

## 环境要求

- **Windows 10 / 11**（依赖 Task Scheduler 与 DPAPI）
- **Node.js 18+**（使用全局 `fetch`、`AbortSignal.timeout`）
- **Google Chrome**（复用本机安装；未安装时可把 `config.json` 的 `browser.channel` 改成 `msedge`）

## 安装

```powershell
git clone https://github.com/IS-09/2dfan-checkin.git
cd 2dfan-checkin
npm install
```

> npm 拉不动官方源时，可加 `--registry=https://registry.npmmirror.com`。

**第一步：生成配置**

```powershell
powershell -ExecutionPolicy Bypass -File .\setup_config.ps1
```

会提示输入登录名与密码，密码用 DPAPI 加密后写入 `config.json`（无 BOM），并回环校验一次。

**第二步：登录一次，换取长效 Cookie**

```powershell
node login_once.mjs
```

- 先尝试无头登录；若被 Turnstile 拦下，会自动弹出有头窗口，这时手动点一下验证码即可
- 成功后 Cookie 写入 `cookies.json`，Chrome 会话保存在 `.chrome-profile/`
- 这一步只有首次（以及改密码后）需要

**第三步：注册每日任务**

```powershell
powershell -ExecutionPolicy Bypass -File .\install_task.ps1
```

会创建计划任务 `2DFan-DailyCheckin`，包含 4 个触发器、`StartWhenAvailable`（错过补跑）、失败重启。

**验证**

```powershell
node checkin_daily.mjs --dry-run        # 只读状态，不签到
schtasks /Run /TN 2DFan-DailyCheckin    # 立刻用任务上下文试跑
```

## 目录结构

| 文件 | 作用 |
|---|---|
| `checkin_daily.mjs` | 主程序（计划任务调用的入口） |
| `login_once.mjs` | 一次性登录，换取/刷新 Cookie |
| `setup_config.ps1` | 交互式生成加密配置 |
| `install_task.ps1` / `uninstall_task.ps1` | 注册 / 卸载计划任务 |
| `lib/net.mjs` | DNS/HTTP 层：DoH 解析、IP 直连、Cookie 罐、退避重试 |
| `lib/site.mjs` | 站点接口封装（状态、签到、CSRF） |
| `lib/dns.mjs` | DoH 解析与 Chrome `--host-resolver-rules` 生成 |
| `lib/browser-login.mjs` | 浏览器登录（过 Turnstile） |
| `lib/browser-checkin.mjs` | 浏览器签到（点按钮、轮询复核、故障快照） |
| `lib/secret.mjs` | DPAPI 解密密码 |
| `lib/config.mjs` | 配置读取（容错 BOM） |
| `lib/log.mjs` | 日志（控制台 + 按日文件） |
| `lib/notify.mjs` | 失败桌面通知 |
| `config.example.json` | 配置模板 |
| `.gitignore` | 已排除全部凭据与运行产物 |

运行后会生成（均不入库）：`config.json`、`cookies.json`、`state.json`、`logs/`、`debug/`、`.chrome-profile/`。

## 结果代码

`state.json` 的 `last.result` 与进程退出码：

| 结果 | 退出码 | 含义 |
|---|---|---|
| `OK_SIGNED` | 0 | 签到成功，并已用 `status.json` 复核 |
| `OK_ALREADY` | 0 | 今天已经签过，未重复提交 |
| `OK_DRY` | 0 | `--dry-run` 只读检查 |
| `ERR_AUTH` | 2 | 会话失效且自动重登失败，需手动跑 `login_once.mjs` |
| `ERR_COOLDOWN` | 4 | 站点处于 cooldown 且未能签上（通常等次日重置） |
| `ERR_UNVERIFIED` | 5 | 提交了但复核仍显示未签到 |
| `ERR_CAPTCHA` | 6 | 拿不到验证码 token（Turnstile 未自动通过） |
| `ERR_NET` / `ERR_UNKNOWN` | 7 / 1 | 网络或未预期异常 |

## 常用命令

```powershell
node checkin_daily.mjs --dry-run          # 只看状态
node checkin_daily.mjs                    # 立即签到（已签会跳过）
node checkin_daily.mjs --force            # 忽略 cooldown 标记强行尝试
node login_once.mjs                       # 重新登录并刷新 Cookie
schtasks /Run /TN 2DFan-DailyCheckin      # 用任务上下文试跑
Get-ScheduledTaskInfo -TaskName 2DFan-DailyCheckin
powershell -ExecutionPolicy Bypass -File .\uninstall_task.ps1
```

## 已知限制

1. **只在 Windows 已登录时运行**：任务使用 `InteractiveToken`，不需要把 Windows 密码交给任务计划程序。重启后停在登录界面时不会跑，登录后 2 分钟内自动补跑。
2. **电脑必须开机**：睡眠/关机错过 00:05 的，唤醒后由 `StartWhenAvailable` 补跑。
3. **有头兜底可能弹窗**：无头签到失败时，会在触发时刻弹出一个 Chrome 窗口重试一次（多数几秒内自动完成）。不想被打扰就把 `config.json` 的 `headed_fallback` 改为 `false`。
4. **阿里云滑块无法自动解**：若 Cloudflare 判定 IP 可疑并降级为阿里云滑块，脚本会失败并留下快照，需要人工签到一次。这与 IP 信誉强相关，机房/代理出口比家庭宽带更容易触发。
5. **站点改版可能失效**：页面结构或接口变化会归类为 `ERR_UNVERIFIED` / `ERR_CAPTCHA` 并通知，不会误报成功。
6. **改密码后需重新登录**：跑一次 `node login_once.mjs`。

## 安全说明

- 密码以 **Windows DPAPI（CurrentUser）** 加密存于 `config.json`，只有当前 Windows 账户能解密，换机器或换账户都无效。
- 运行时解密经临时文件且立即删除；密码不进命令行参数、不进日志、不进异常信息。
- `cookies.json`、`.chrome-profile/` 等同于账号凭证，**不要提交、不要外传**（已被 `.gitignore` 排除）。
- 本仓库提交历史中不含任何真实账号或会话数据。

## 排障

| 现象 | 处理 |
|---|---|
| `未拿到 Turnstile token` | 看 `debug\` 里的快照确认页面状态；站点风控可能升级 |
| 反复 `ERR_AUTH` | Cookie 失效，跑 `node login_once.mjs` |
| 大量 `连接 x.x.x.x 失败` | DoH 或该 IP 不可达，脚本会自动换 IP 重试 |
| `LastTaskResult` 非 0 | 对照上表退出码，再查 `logs\当天日期.log` |
| 想确认是否真签上 | 看 `state.json` 的 `last.result` 是否为 `OK_SIGNED` / `OK_ALREADY` |

## 参考

实现过程中参考了这些同类项目（它们的共同点是都需要手动提供 `_project_hgc_session`，不做自动登录）：

- [seestars/2dfan-checkin-action](https://github.com/seestars/2dfan-checkin-action) — Selenium + undetected-chromedriver，GitHub Actions 调度
- [WeMingT/2dfan-checkin](https://github.com/WeMingT/2dfan-checkin) — nodriver 本地自动化
- [forgetmenot-lab/2dfan-checkin](https://github.com/forgetmenot-lab/2dfan-checkin) — NAS Docker + nodriver，工程化最完整

注意：更早期的脚本基于 `/api/checkins`、`/checkins` 等旧接口，现已失效（`/api/checkins` 目前返回 `403 Signature verification failed`）。

## 免责声明

本项目仅供学习和个人研究使用。自动化访问可能与站点用户协议冲突，使用风险由使用者自行承担。请保持每日 1 次的访问频率，不要用于批量注册或商业用途。

## License

[MIT](LICENSE)
