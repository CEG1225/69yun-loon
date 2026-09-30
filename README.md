# 69云自动签到 —— Loon 版

把 [yixiu001/69yuncheckin](https://github.com/yixiu001/69yuncheckin) 里的 `69yun.py`（Python + requests + Telegram Bot 推送）移植成 **Loon 可用的 JS 脚本**，签到结果直接用 iOS 系统通知推送，不需要 Telegram Bot、不需要服务器、不需要 GitHub Actions。

- 站点：`https://69yun69.com`（SSPanel-Uim 面板）
- 定时：每天 08:30 自动执行一次
- **不需要 MitM / 装证书**：脚本只用 `$httpClient` 主动发请求，不拦截流量

## 文件说明

| 文件 | 用途 |
| --- | --- |
| `69yun.js` | 主脚本，**只有这里需要你改**（顶部 `CONFIG`） |
| `69yun.plugin` | Loon 插件，导入后自动加好定时任务 |
| `dev/loon-shim.js` | 本地测试用（Node 模拟 Loon 运行时），上线不需要 |

## 三步装好

### 1. 填账号

用文本编辑器打开 `69yun.js`，改最上面的 `CONFIG`：

```js
var CONFIG = {
    domain: "https://69yun69.com",
    accounts: [
        {
            email: "你的邮箱@example.com",   // 登录邮箱
            passwd: "你的密码",               // 登录密码
            code2fa: "",                      // 没开二步验证就留空
            cookie: ""                        // 一般留空，见下文「Cookie 模式」
        }
    ],
    notify: true,   // 是否发系统通知
    debug: false    // 排错时改成 true
};
```

多个账号就往 `accounts` 数组里继续加 `{ email: ..., passwd: ... }`，脚本会依次签到，每个账号一条通知。

### 2. 把脚本放进 Loon

Loon 的本地脚本目录是 **`iCloud/Loon/Script`**（「文件」App → iCloud Drive → Loon → Script）。两种方式任选：

- **方式 A（推荐）**：把 `69yun.js` 拷进去，也可以用 Loon 的「从 URL 下载」功能。
- **方式 B**：在 Loon 里「配置 → 脚本 → 新建脚本」，把 `69yun.js` 的内容整段粘贴进去，命名保存。

> 如果你把脚本放在自己的 GitHub / Gist 上，那第 3 步的 `script-path` 直接写 raw 地址即可，例如
> `script-path=https://raw.githubusercontent.com/你的用户名/你的仓库/main/69yun.js`。

### 3. 加定时任务

**做法一：导入插件**

把 `69yun.plugin` 放到同一个 `iCloud/Loon/Script` 目录，然后在 Loon 里导入它，定时任务就配好了。

**做法二：直接改配置**

在 Loon 主配置的 `[Script]` 段加一行（旧版语法，兼容性最好）：

```ini
[Script]
cron "0 30 8 * * *" script-path=69yun.js, tag=69云签到, timeout=120, enabled=true
```

Loon 3.5.1 (983) 以上也可以写新版语法：

```ini
[Script]
cron "0 30 8 * * *" then script("69yun.js") with tag="69云签到", timeout=120
```

`"0 30 8 * * *"` 是六段格式（秒 分 时 日 月 周），表示每天 08:30:00。想改成早上 7 点就写 `"0 0 7 * * *"`；五段格式（分 时 日 月 周）Loon 同样支持，`"30 8 * * *"` 效果一样。

想立刻验证，不用等到第二天：把 `enabled=true` 的那行 `cron` 临时改成 `generic` 手动跑一次，或者直接导入插件后用其中那条「手动执行测试」。

## 脚本做了什么（和原版的对应关系）

| 原 Python 脚本 | Loon 版 |
| --- | --- |
| `requests.post("/auth/login", {email, passwd, remember_me, code})` | `$httpClient.post`，同样的接口和字段 |
| `requests.post("/user/checkin")` 带登录 Cookie | 同上，Cookie 从 `Set-Cookie` 手工解析后带上 |
| `fetch_and_extract_info()` 正则抓 `Class_Expire` / `Unused_Traffic` | 原样移植，从 `/user` 页面的 `window.ChatraIntegration` 里抓 |
| Telegram Bot 推送 `BOT_TOKEN` / `CHAT_ID` | 换成 `$notification.post()`，手机本地通知，无需配置 |
| GitHub Actions 每天跑 | 换成 Loon 的 `cron`，在手机上跑 |

移植时额外加固的地方：

- **Cookie 会缓存到 `$persistentStore`**：先拿缓存 Cookie 直接签到，省掉一次登录；只有被判定为登录态失效才回退到账号密码登录，登录成功后自动更新缓存。
- **登录态失效判定**：`/user/checkin` 未登录时返回的是登录页 HTML 而不是 JSON，脚本靠这一点自动识别并重登，非 JSON 的异常响应也不会让脚本崩掉。
- **多段 Cookie 解析**：正确处理 `Set-Cookie` 里的 `expires=Wed, 30 Sep 2026 ...`（逗号不会把一条 Cookie 拆坏），也不会把 `path` / `expires` 这类属性当 Cookie 发出去。
- **兜底超时**：整体 120 秒强制结束，`$done()` 保证只调用一次。

## Cookie 模式（二步验证 / 人机验证时用）

登录用的账号密码方式在两种情况下会失败：站点开启了人机验证（目前 `geetest`、`recaptcha` 都是关的），或者你的账号开了二步验证。

这种情况下改成手动 Cookie：

1. 电脑浏览器打开 `https://69yun69.com` 并登录；
2. F12 → Application（或存储）→ Cookies → `https://69yun69.com`；
3. 把 `uid`、`key`、`email` 三个值拼成 `uid=xxx; key=yyy; email=zzz`；
4. 填进配置（`passwd` 可以留空）：

```js
accounts: [
    { email: "你的邮箱@example.com", passwd: "", cookie: "uid=xxx; key=yyy; email=zzz" }
]
```

Cookie 过期后会通知「手动配置的 Cookie 已失效，请重新从浏览器复制」，重新复制一次就行。

## 常见问题

**收不到通知？** 检查 iOS「设置 → 通知 → Loon」是否允许通知。

**通知里有 `❌` 怎么办？** 正文就是站点返回的原始原因，常见几种：

| 通知内容 | 原因 |
| --- | --- |
| `登录失败：邮箱不存在` | 邮箱写错了 |
| `登录失败：密码错误` | 密码写错了 |
| `登录返回非 JSON...站点可能开了人机验证` | 站点开了验证码，改用 Cookie 模式 |
| `手动配置的 Cookie 已失效` | Cookie 过期，重新复制 |
| `签到响应无法解析：...` | 站点改版了，把 `debug` 改成 `true` 看日志反馈 |

**想看执行细节？** 把 `CONFIG.debug` 改成 `true`，然后在 Loon 的日志里搜 `[69yun]`。

**修改签到时间后没生效？** 改完配置需要在 Loon 里重新加载配置。

**安全问题**：密码是明文存在 `iCloud/Loon/Script/69yun.js` 里的，和绝大多数签到脚本一样。介意的话用 Cookie 模式，或者单独注册一个不重要的账号密码。

## 本地自测（可选）

`dev/loon-shim.js` 用 Node 模拟了 Loon 的 `$httpClient` / `$persistentStore` / `$notification` / `$done`，会真实访问 69yun69.com 来验证逻辑：

```bash
node dev/loon-shim.js
```

当前 16 项检查全部通过，覆盖：`Set-Cookie` 解析（单条/多条/数组/带 expires）、Cookie 合并、JSON 解析、占位配置提示、错误账号登录、失效 Cookie 回退登录、`$argument` 传参、Cookie 模式。**注意**：测试用的都是无效账号，所以覆盖的是失败路径；签到成功后的分支要靠你的真实账号验证一次。
