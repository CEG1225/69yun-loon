/*************************************************************
 * 69云自动签到（Loon 版）
 *
 * 站点: https://69yun69.com
 * 移植自: https://github.com/yixiu001/69yuncheckin  (69yun.py)
 *
 * 原脚本流程:
 *   1) POST {domain}/auth/login    body: {email, passwd, remember_me, code}
 *   2) POST {domain}/user/checkin  带上登录后的 Cookie
 *   3) GET  {domain}/user          解析 window.ChatraIntegration 取流量/到期时间
 *
 * 移植到 Loon 时做的替换:
 *   requests        -> $httpClient
 *   response.cookies-> 手动解析 Set-Cookie + $persistentStore 持久化
 *   Telegram 推送    -> $notification.post（无需 Bot Token / Chat ID）
 *************************************************************/

/* ==================== 用户配置区（改这里） ==================== */
var CONFIG = {
    // 站点地址，末尾不要带 /
    domain: "https://69yun69.com",

    // 账号列表，可以写多个
    accounts: [
        {
            email: "你的邮箱@example.com",   // 登录邮箱
            passwd: "你的密码",               // 登录密码
            code2fa: "",                      // 开了二步验证才填；一次性验证码无法在此自动生成
            cookie: ""                        // 可选：填了就直接用 Cookie 签到，不再走账号密码登录
        }
    ],

    notify: true,   // 是否发系统通知
    debug: false    // 排错时改成 true，可在 Loon 日志里看到详细过程
};
/* ============================================================= */


var STORE_PREFIX = "69yun_cookie_";     // Cookie 持久化 key 前缀
var TIMEOUT_MS = 20000;                 // 单个请求超时
var MAX_RUNTIME_MS = 120000;            // 整个脚本兜底超时
var UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

var DONE_FLAG = false;
function finishScript() {
    if (DONE_FLAG) return;
    DONE_FLAG = true;
    $done();
}

function log(msg) {
    if (CONFIG.debug) {
        console.log("[69yun] " + msg);
    }
}


/* ---------------------- 基础工具 ---------------------- */

// 响应体统一转成字符串
function toText(data) {
    if (data === null || typeof data === "undefined") return "";
    if (typeof data === "string") return data;
    if (typeof Uint8Array !== "undefined" && data instanceof Uint8Array) {
        if (typeof TextDecoder !== "undefined") {
            try { return new TextDecoder("utf-8").decode(data); } catch (e) { /* fallthrough */ }
        }
        var out = "";
        for (var i = 0; i < data.length; i++) out += String.fromCharCode(data[i]);
        try { return decodeURIComponent(escape(out)); } catch (e2) { return out; }
    }
    try { return JSON.stringify(data); } catch (e3) { return String(data); }
}

// 安全的 JSON 解析：不是 JSON 就返回 null
function parseJSON(text) {
    if (!text) return null;
    var s = String(text).replace(/^\uFEFF/, "").replace(/^\s+/, "");
    if (s.charAt(0) !== "{" && s.charAt(0) !== "[") return null;
    try { return JSON.parse(s); } catch (e) { return null; }
}

// Header 大小写不敏感读取
function headerGet(headers, name) {
    if (!headers) return null;
    var lower = String(name).toLowerCase();
    var keys = Object.keys(headers);
    for (var i = 0; i < keys.length; i++) {
        if (String(keys[i]).toLowerCase() === lower) return headers[keys[i]];
    }
    return null;
}

// 把 Set-Cookie 拆成 "name=value; name2=value2"，会跳过 expires/path/domain 等属性
function splitSetCookie(raw) {
    var lines = [];
    if (Array.isArray(raw)) {
        lines = raw.slice();
    } else if (typeof raw === "string") {
        var buf = "", parts = [], i;
        for (i = 0; i < raw.length; i++) {
            var ch = raw.charAt(i);
            if (ch === ",") {
                // 逗号后面若是 "name=" 且不是日期，说明是下一条 Cookie
                var rest = raw.slice(i + 1);
                if (/^\s*[A-Za-z0-9_\-]+=/.test(rest) &&
                    !/^\s*\d{1,2}[\s\-]/.test(rest) &&
                    !/^\s*(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/.test(rest)) {
                    parts.push(buf);
                    buf = "";
                    continue;
                }
            }
            buf += ch;
        }
        if (buf.replace(/\s/g, "")) parts.push(buf);
        lines = parts;
    }

    var cookies = [], seen = {};
    for (var j = 0; j < lines.length; j++) {
        var first = String(lines[j]).split(";")[0].replace(/^\s+|\s+$/g, "");
        if (!first) continue;
        var eq = first.indexOf("=");
        if (eq <= 0) continue;
        var n = first.slice(0, eq).replace(/^\s+|\s+$/g, "");
        if (/^(expires|path|domain|max-age|samesite|secure|httponly|priority)$/i.test(n)) continue;
        if (seen[n]) continue;
        seen[n] = true;
        cookies.push(first);
    }
    return cookies.join("; ");
}

// 旧 Cookie 与新 Cookie 合并（同名以新值为准）
function mergeCookie(oldCookie, newCookie) {
    var map = {}, order = [];
    function absorb(str) {
        if (!str) return;
        var segs = String(str).split(";");
        for (var i = 0; i < segs.length; i++) {
            var s = segs[i].replace(/^\s+|\s+$/g, "");
            if (!s) continue;
            var eq = s.indexOf("=");
            if (eq <= 0) continue;
            var n = s.slice(0, eq);
            if (!Object.prototype.hasOwnProperty.call(map, n)) order.push(n);
            map[n] = s.slice(eq + 1);
        }
    }
    absorb(oldCookie);
    absorb(newCookie);
    var out = [];
    for (var k = 0; k < order.length; k++) out.push(order[k] + "=" + map[order[k]]);
    return out.join("; ");
}

// 统一请求封装
function httpRequest(method, url, headers, body, cb) {
    var options = {
        url: url,
        headers: headers || {},
        timeout: TIMEOUT_MS,
        "auto-redirect": true,
        "auto-cookie": true       // 同一次脚本执行内自动复用 Cookie
    };
    if (body !== null && typeof body !== "undefined") options.body = body;

    var handler = function (error, response, data) {
        cb(error || null, response || null, toText(data));
    };

    if (method === "GET") {
        $httpClient.get(options, handler);
    } else {
        $httpClient.post(options, handler);
    }
}


/* ---------------------- 站点接口 ---------------------- */

// 1) 登录，成功后返回 Cookie
function login(account, cb) {
    var url = CONFIG.domain + "/auth/login";
    var payload = {
        email: account.email,
        passwd: account.passwd,
        remember_me: "on",
        code: ""
    };
    if (account.code2fa) payload.code_2fa = String(account.code2fa);

    var headers = {
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Content-Type": "application/json",
        "Origin": CONFIG.domain,
        "Referer": CONFIG.domain + "/auth/login",
        "X-Requested-With": "XMLHttpRequest"
    };

    httpRequest("POST", url, headers, JSON.stringify(payload), function (err, resp, text) {
        if (err) {
            log("login error: " + err);
            return cb("登录请求失败：" + err);
        }
        var json = parseJSON(text);
        if (!json) {
            log("login raw: " + String(text).slice(0, 200));
            return cb("登录返回非 JSON（HTTP " + (resp ? resp.status : "?") + "），站点可能开了人机验证");
        }
        if (json.ret !== 1) {
            return cb("登录失败：" + (json.msg || "未知错误"));
        }
        var cookie = splitSetCookie(headerGet(resp.headers, "Set-Cookie"));
        log("login ok, cookie=" + cookie);
        cb(null, cookie);
    });
}

// 2) 签到，返回解析后的 JSON
function checkin(cookie, cb) {
    var url = CONFIG.domain + "/user/checkin";
    var headers = {
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Content-Type": "application/json",
        "Origin": CONFIG.domain,
        "Referer": CONFIG.domain + "/user/panel",
        "X-Requested-With": "XMLHttpRequest"
    };
    if (cookie) headers.Cookie = cookie;

    httpRequest("POST", url, headers, null, function (err, resp, text) {
        if (err) {
            log("checkin error: " + err);
            return cb("签到请求失败：" + err);
        }
        log("checkin raw: " + String(text).slice(0, 200));
        cb(null, parseJSON(text), resp, text);
    });
}

// 3) 读取剩余流量 / 到期时间（拿不到就返回空串，不影响签到结果）
function fetchUserInfo(cookie, cb) {
    var headers = {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Referer": CONFIG.domain + "/user"
    };
    if (cookie) headers.Cookie = cookie;

    httpRequest("GET", CONFIG.domain + "/user", headers, null, function (err, resp, text) {
        if (err || !text || text.indexOf("ChatraIntegration") < 0) return cb("");
        var info = "", m;
        m = text.match(/'Class_Expire'\s*:\s*'([^']*)'/);
        if (m && m[1]) info += "\n到期时间：" + m[1];
        m = text.match(/'Unused_Traffic'\s*:\s*'([^']*)'/);
        if (m && m[1]) info += "\n剩余流量：" + m[1];
        cb(info);
    });
}


/* ---------------------- 单个账号流程 ---------------------- */

function runAccount(account, cookieKey, cb) {
    var finished = false;
    function finish(text, ok) {
        if (finished) return;
        finished = true;
        cb({ email: account.email, text: text, ok: !!ok });
    }

    var cookieOnly = !!account.cookie;                 // 手动 Cookie 模式：不尝试账号密码登录
    var storedCookie = account.cookie || $persistentStore.read(cookieKey) || "";
    log("account=" + account.email + " hasStoredCookie=" + (storedCookie ? "yes" : "no") + " cookieOnly=" + cookieOnly);

    function afterCheckin(cookie, msg, ok) {
        fetchUserInfo(cookie, function (info) {
            finish(msg + info, ok);
        });
    }

    function doLogin() {
        login(account, function (err, cookie) {
            if (err) return finish("❌ " + err, false);
            if (!cookie) return finish("❌ 登录成功但没取到 Cookie，签到无法继续", false);
            $persistentStore.write(cookie, cookieKey);
            doCheckin(cookie, true);
        });
    }

    function sessionInvalid() {
        return cookieOnly
            ? finish("❌ 手动配置的 Cookie 已失效，请重新从浏览器复制", false)
            : doLogin();
    }

    function doCheckin(cookie, isRetry) {
        checkin(cookie, function (err, json, resp, raw) {
            if (err) return finish("❌ " + err, false);

            // 返回不是 JSON，基本就是被重定向到登录页 -> 登录态失效
            if (!json) {
                var looksLikeLogin = /auth\/login|<title>\s*登录/i.test(String(raw)) ||
                                     (resp && resp.status === 200 && /<html/i.test(String(raw)));
                if (looksLikeLogin) {
                    if (isRetry) return finish("❌ 登录后依然被要求登录，请检查账号密码是否正确", false);
                    return sessionInvalid();
                }
                return finish("❌ 签到响应无法解析：" + String(raw).replace(/\s+/g, " ").slice(0, 100), false);
            }

            // 签到成功
            if (json.ret === 1) {
                if (cookie) $persistentStore.write(cookie, cookieKey);
                return afterCheckin(cookie, "✅ " + (json.msg || "签到成功"), true);
            }

            // ret === 0
            var msg = String(json.msg || "");

            // 今天已经签过
            if (/已签到|已经签到|重复|已完成/.test(msg)) {
                if (cookie) $persistentStore.write(cookie, cookieKey);
                return afterCheckin(cookie, "ℹ️ " + (msg || "今日已签到"), true);
            }

            // 未登录 / 登录态失效 -> 登录后重试一次
            if (/登录|登陆|未登录|授权|token/i.test(msg)) {
                if (isRetry) return finish("❌ " + (msg || "登录态无效"), false);
                return sessionInvalid();
            }

            finish("❌ " + (msg || "签到失败"), false);
        });
    }

    if (storedCookie) {
        doCheckin(storedCookie, false);   // 先拿缓存 Cookie 试一次，能省掉一次登录
    } else {
        doLogin();
    }
}


/* ---------------------- 配置读取与入口 ---------------------- */

function normalizeAccounts(list) {
    var out = [];
    if (!list) return out;
    for (var i = 0; i < list.length; i++) {
        var a = list[i] || {};
        var email = String(a.email || "").replace(/^\s+|\s+$/g, "");
        var passwd = String(a.passwd || "");
        var cookie = String(a.cookie || "").replace(/^\s+|\s+$/g, "");

        if (!email || email.indexOf("你的邮箱") === 0) continue;   // 没改配置
        if (passwd === "你的密码") passwd = "";
        if (!passwd && !cookie) continue;                          // 密码和 Cookie 至少有一个

        out.push({
            email: email,
            passwd: passwd,
            code2fa: String(a.code2fa || a.code || ""),   // 插件里这个字段叫 code
            cookie: cookie
        });
    }
    return out;
}

function getAccounts() {
    var list = [];
    var arg = (typeof $argument !== "undefined") ? $argument : null;

    if (arg) {
        if (typeof arg === "string") {
            var parsed = parseJSON(arg);
            if (parsed) {
                if (Array.isArray(parsed)) list = parsed;
                else if (parsed.accounts) list = parsed.accounts;
                else list = [parsed];
            }
        } else if (typeof arg === "object") {
            // 插件 [Argument] 传进来的对象，例如 argument=[{email},{passwd},{code}]
            if (Array.isArray(arg.accounts)) {
                list = arg.accounts;
            } else if (arg.email) {
                list = [arg];
                if (arg.email2) {                     // 插件里配的第二个账号（可选）
                    list.push({
                        email: arg.email2,
                        passwd: arg.passwd2,
                        code2fa: arg.code2fa2 || arg.code2,
                        cookie: arg.cookie2
                    });
                }
            }
        }
        var fromArg = normalizeAccounts(list);
        if (fromArg.length) return fromArg;
    }

    return normalizeAccounts(CONFIG.accounts);
}

function maskEmail(email) {
    var s = String(email || "");
    var at = s.indexOf("@");
    if (at <= 1) return s;
    return s.charAt(0) + "***" + s.slice(at);
}

function notify(title, subtitle, content) {
    if (!CONFIG.notify) return;
    try {
        $notification.post(title, subtitle || "", content || "");
    } catch (e) {
        log("notify failed: " + e);
    }
}

function main() {
    setTimeout(finishScript, MAX_RUNTIME_MS);   // 兜底，防止某个回调一直不返回

    var accounts = getAccounts();
    if (!accounts.length) {
        notify("69云签到 · 未配置", "", "请打开 69yun.js，在顶部 CONFIG.accounts 里填写邮箱和密码");
        return finishScript();
    }

    var results = [];
    var idx = 0;
    var multi = accounts.length > 1;

    function next() {
        if (idx >= accounts.length) {
            if (multi) {
                var lines = [], allOk = true, i;
                for (i = 0; i < results.length; i++) {
                    if (!results[i].ok) allOk = false;
                    lines.push(maskEmail(results[i].email) + "：" + results[i].text);
                }
                notify("69云签到 · " + (allOk ? "全部完成" : "存在失败"), "", lines.join("\n"));
            }
            return finishScript();
        }

        var account = accounts[idx++];
        runAccount(account, STORE_PREFIX + account.email, function (r) {
            log(r.email + " => " + r.text);
            results.push(r);
            if (!multi) {
                notify("69云签到", CONFIG.domain.replace(/^https?:\/\//, ""), r.text);
            } else {
                notify("69云签到 · " + maskEmail(r.email), "", r.text);
            }
            next();
        });
    }

    next();
}

main();
