# 69云自动签到 —— Loon 版

把 [yixiu001/69yuncheckin](https://github.com/yixiu001/69yuncheckin) 的 `69yun.py`（Python + requests + Telegram Bot）移植成 **Loon 插件 + JS 脚本**。

签到结果直接用 iOS 系统通知推送，**不需要 Telegram Bot、不需要服务器、不需要 GitHub Actions、不需要 MitM 证书**。

- 站点：`https://69yun69.com`（SSPanel-Uim 面板）
- 定时：默认每天 08:30 自动执行，可在导入时改
- 安装：在 Loon 里添加一个插件地址，填邮箱密码即可

---

## 一、在线安装（推荐，不用改任何代码）

### 1. 在 Loon 里添加插件

Loon → **配置 → 插件 → 右上角 + → 从 URL 添加**，粘贴：

```
https://raw.githubusercontent.com/CEG1225/69yun-loon/main/69yun.plugin
```

> 国内拉不动 raw.githubusercontent 的话，换 jsDelivr 镜像：
> ```
> https://cdn.jsdelivr.net/gh/CEG1225/69yun-loon@main/69yun.plugin
> ```

### 2. 在弹出的界面里填参数

Loon 会根据插件里的 `[Argument]` 自动生成填写界面：

| 参数 | 说明 |
| --- | --- |
| 69云登录邮箱 | 你的登录邮箱（必填） |
| 69云登录密码 | 你的登录密码（必填） |
| 二步验证动态码 | 没开二步验证就留空 |
| 第二个账号邮箱 / 密码 | 只签到 1 个账号就留空 |
| 定时执行 | 默认 `0 30 8 * * *`，即每天 08:30:00 |
| 启用定时签到 | 开关 |

账号密码只保存在**你本机的 Loon 配置**里，不会上传到任何地方。

### 3. 手动跑一次验证

导入后不需要等到第二天：在 Loon 的**脚本**列表里找到 `69云签到`，点进去手动执行一次，马上就能看到通知。

---

## 二、脚本做了什么

| 原 Python 脚本 | Loon 版 |
| --- | --- |
| `requests.post("/auth/login", {email, passwd, remember_me, code})` | `$httpClient.post`，同一接口、同样字段 |
| `requests.post("/user/checkin")` 带登录 Cookie | 同上，Cookie 从 `Set-Cookie` 手工解析后带上 |
| `fetch_and_extract_info()` 正则抓 `Class_Expire` / `Unused_Traffic` | 原样移植，从 `/user` 页的 `window.ChatraIntegration` 抓 |
| Telegram Bot 推送（`BOT_TOKEN` / `CHAT_ID`） | 换成 `$notification.post()`，手机本地通知 |
| GitHub Actions 定时 | 换成 Loon 的 `cron`，直接在手机上跑 |

移植时加固的地方：

- **Cookie 缓存**：先拿 `$persistentStore` 里的 Cookie 直接签到，省掉一次登录；只有被判定为登录态失效才回退账号密码登录，登录成功后自动更新缓存。
- **登录态失效判定**：`/user/checkin` 未登录时返回的是登录页 HTML 而不是 JSON，脚本靠这点自动识别并重登；异常响应不会让脚本崩掉。
- **多段 Cookie 解析**：正确处理 `Set-Cookie` 里 `expires=Wed, 30 Sep 2026 ...` 的逗号，也不会把 `path`/`expires` 这类属性当 Cookie 发出去。
- **兜底超时**：整体 120 秒强制结束，`$done()` 保证只调用一次。

---

## 三、Cookie 模式（开了二步验证 / 站点加了人机验证时用）

如果你的账号开了二步验证，或者站点哪天开了验证码，账号密码登录会失败。这时改用手动 Cookie：

1. 电脑浏览器打开 `https://69yun69.com` 并登录；
2. F12 → Application（或「存储」）→ Cookies → `https://69yun69.com`；
3. 把 `uid`、`key`、`email` 三个值拼成 `uid=xxx; key=yyy; email=zzz`；
4. 编辑 `69yun.js` 顶部配置（需要 fork 或本地部署），`passwd` 留空：

```js
accounts: [
    { email: "你的邮箱@example.com", passwd: "", cookie: "uid=xxx; key=yyy; email=zzz" }
]
```

Cookie 过期后会通知「手动配置的 Cookie 已失效，请重新从浏览器复制」。

---

## 四、本地安装（不用在线版，或想自己改代码）

Loon 的本地脚本目录是 **`iCloud/Loon/Script`**（「文件」App → iCloud Drive → Loon → Script）。

1. 把 `69yun.js` 放进去，编辑顶部 `CONFIG` 填邮箱密码；
2. 在 Loon 主配置的 `[Script]` 段加：

```ini
[Script]
cron "0 30 8 * * *" script-path=69yun.js, tag=69云签到, timeout=120, enabled=true
```

Loon 3.5.1 (983) 以上也可以写新版语法：

```ini
[Script]
cron "0 30 8 * * *" then script("69yun.js") with tag="69云签到", timeout=120
```

`"0 30 8 * * *"` 是六段格式（秒 分 时 日 月 周）。五段格式（分 时 日 月 周）Loon 同样支持，`"30 8 * * *"` 效果一样。

---

## 五、常见问题

**收不到通知？** 检查 iOS「设置 → 通知 → Loon」是否允许通知。

**通知里是 `❌`？** 正文就是站点返回的原始原因：

| 通知内容 | 原因 |
| --- | --- |
| `登录失败：邮箱不存在` | 邮箱填错了 |
| `登录失败：密码错误` | 密码填错了 |
| `登录返回非 JSON...站点可能开了人机验证` | 站点开了验证码，改用 Cookie 模式 |
| `手动配置的 Cookie 已失效` | Cookie 过期，重新复制 |
| `签到响应无法解析：...` | 站点改版了，把 `CONFIG.debug` 改成 `true` 看日志反馈 |
| `未配置` | 插件里邮箱或密码没填 |

**想看执行细节？** 把 `js` 里的 `CONFIG.debug` 改成 `true`，在 Loon 日志里搜 `[69yun]`。

**改了定时不生效？** 改完插件参数需要在 Loon 里重新保存/加载配置。

**安全问题**：密码明文存在 Loon 配置或脚本文件里，和绝大多数签到脚本一样。介意的话用 Cookie 模式，或单独注册一个小号。

---

## 六、本地自测

`dev/loon-shim.js` 用 Node 模拟了 Loon 的 `$httpClient` / `$persistentStore` / `$notification` / `$done`，并**真实访问 69yun69.com** 验证逻辑：

```bash
# 测本地副本
node dev/loon-shim.js

# 测线上版本（直接拉 GitHub 上的文件来跑）
SHIM_SRC=https://raw.githubusercontent.com/CEG1225/69yun-loon/main/69yun.js node dev/loon-shim.js
```

当前 **20 项检查全部通过**，覆盖：`Set-Cookie` 解析（单条/多条/数组/带 expires）、Cookie 合并、JSON 解析、占位配置提示、错误账号登录、失效 Cookie 回退登录、`$argument` 传参、插件参数对象传参、双账号汇总、Cookie 模式。

> 注意：测试用的是无效账号，覆盖的是**失败路径**；签到成功后的分支需要你用真实账号跑一次。

---

## 授权

仅供学习交流，请遵守当地法律法规和站点服务条款。
