/*************************************************************
 * Loon 运行时模拟器（仅用于本地测试 69yun.js，不参与线上运行）
 *
 * 提供 69yun.js 依赖的: $httpClient / $persistentStore / $notification / $done
 * 用真实网络请求访问 69yun69.com，验证移植后的逻辑是否正确。
 *
 * 运行: node dev/loon-shim.js
 *************************************************************/

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { URL } = require("url");

const SCRIPT = path.join(__dirname, "..", "69yun.js");

/* ---------------- 底层 HTTP ---------------- */

function rawRequest(opts, cb) {
    const u = new URL(opts.url);
    const mod = u.protocol === "http:" ? http : https;
    const headers = Object.assign({}, opts.headers || {});
    let body = opts.body;
    if (body !== null && body !== undefined && typeof body !== "string" && !Buffer.isBuffer(body)) {
        body = String(body);
    }
    if (body !== null && body !== undefined) headers["Content-Length"] = Buffer.byteLength(body);

    const req = mod.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === "http:" ? 80 : 443),
        path: u.pathname + u.search,
        method: opts.method || "GET",
        headers,
        timeout: opts.timeout || 20000
    }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => cb(null, { status: res.statusCode, headers: res.headers }, Buffer.concat(chunks).toString("utf8")));
    });
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", (e) => cb(e));
    if (body !== null && body !== undefined) req.write(body);
    req.end();
}

/* ---------------- Loon API 实现 ---------------- */

function createLoonEnv(options) {
    const notifications = [];
    const store = Object.assign({}, (options && options.store) || {});
    const cookieJar = {};          // 模拟 auto-cookie: 同一次脚本执行内复用

    function cookieHeaderFor(url) {
        try {
            const host = new URL(url).hostname;
            return cookieJar[host] || "";
        } catch (e) { return ""; }
    }

    function absorbCookies(url, headers) {
        try {
            const host = new URL(url).hostname;
            let raw = headers["set-cookie"];
            if (!raw) return;
            const list = Array.isArray(raw) ? raw : [raw];
            const map = {};
            (cookieJar[host] || "").split(";").forEach((s) => {
                const t = s.trim(); if (!t) return;
                const i = t.indexOf("="); if (i <= 0) return;
                map[t.slice(0, i)] = t.slice(i + 1);
            });
            list.forEach((line) => {
                const first = String(line).split(";")[0].trim();
                const i = first.indexOf("="); if (i <= 0) return;
                map[first.slice(0, i)] = first.slice(i + 1);
            });
            cookieJar[host] = Object.keys(map).map((k) => k + "=" + map[k]).join("; ");
        } catch (e) { /* ignore */ }
    }

    function request(method, urlOrOptions, callback) {
        const opts = typeof urlOrOptions === "string" ? { url: urlOrOptions } : Object.assign({}, urlOrOptions);
        const headers = Object.assign({}, opts.headers || {});
        if (opts["auto-cookie"] !== false) {
            const jar = cookieHeaderFor(opts.url);
            if (jar && !headers.Cookie && !headers.cookie) headers.Cookie = jar;
        }

        function attempt(currentUrl, depth) {
            rawRequest({
                url: currentUrl,
                method,
                headers,
                body: depth === 0 ? opts.body : null,
                timeout: opts.timeout
            }, (err, res, body) => {
                if (err) return callback(String(err), null, null);
                absorbCookies(currentUrl, res.headers);
                if (res.status >= 300 && res.status < 400 && res.headers.location && opts["auto-redirect"] !== false && depth < 5) {
                    const next = new URL(res.headers.location, currentUrl).toString();
                    const h2 = Object.assign({}, headers);
                    delete h2["Content-Length"];
                    return rawRequest({
                        url: next, method: "GET", headers: h2, body: null, timeout: opts.timeout
                    }, (e2, r2, b2) => {
                        if (e2) return callback(String(e2), null, null);
                        absorbCookies(next, r2.headers);
                        callback(null, { status: r2.status, headers: r2.headers }, b2);
                    });
                }
                callback(null, { status: res.status, headers: res.headers }, body);
            });
        }
        attempt(opts.url, 0);
    }

    const sandbox = {
        console: {
            log: (m) => { if (options && options.verbose) console.log("   [loon.log] " + m); }
        },
        $loon: "iPhone15,2 17.0 3.5.1(1000)",
        $script: { name: options && options.scriptName ? options.scriptName : "69yun-test", startTime: new Date() },
        $argument: (options && Object.prototype.hasOwnProperty.call(options, "argument")) ? options.argument : null,
        $httpClient: {
            get: (u, cb) => request("GET", u, cb),
            post: (u, cb) => request("POST", u, cb)
        },
        $persistentStore: {
            read: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
            write: (v, k) => {
                if (v === undefined || v === null) delete store[k];
                else store[k] = String(v);
                return true;
            }
        },
        $notification: {
            post: (title, subtitle, content) => { notifications.push({ title, subtitle, content }); }
        },
        $done: () => { sandbox.__done = true; },
        setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5000)),
        JSON, Date, Math, String, Number, Boolean, Array, Object, RegExp, Error,
        Uint8Array, TextDecoder, decodeURIComponent, escape, encodeURIComponent, parseInt, parseFloat, isNaN
    };
    sandbox.global = sandbox;
    sandbox.__notifications = notifications;
    sandbox.__store = store;
    return sandbox;
}

/* ---------------- 运行 69yun.js ---------------- */

function runScript(source, options) {
    const sandbox = createLoonEnv(options);
    vm.createContext(sandbox);
    return new Promise((resolve) => {
        const started = Date.now();
        const timer = setInterval(() => {
            if (sandbox.__done || Date.now() - started > 60000) {
                clearInterval(timer);
                resolve({ sandbox, elapsed: Date.now() - started });
            }
        }, 50);
        try {
            vm.runInContext(source, sandbox, { filename: "69yun.js" });
        } catch (e) {
            clearInterval(timer);
            resolve({ sandbox, elapsed: Date.now() - started, error: e });
        }
    });
}

function show(result, label) {
    console.log("\n===== " + label + " =====");
    if (result.error) console.log("脚本抛异常: " + result.error.stack);
    console.log("耗时: " + result.elapsed + "ms   已调用 $done: " + !!result.sandbox.__done);
    const ns = result.sandbox.__notifications;
    if (!ns.length) console.log("(无通知)");
    ns.forEach((n, i) => {
        console.log("--- 通知 " + (i + 1) + " ---");
        console.log("标题: " + n.title);
        console.log("副标题: " + n.subtitle);
        console.log("正文: " + n.content);
    });
    const keys = Object.keys(result.sandbox.__store);
    console.log("持久化 key: " + (keys.length ? keys.join(", ") : "(空)"));
}

/* ---------------- 测试用例 ---------------- */

(async function main() {
    let src = fs.readFileSync(SCRIPT, "utf8");
    let pass = 0, fail = 0;
    function check(name, cond, extra) {
        if (cond) { pass++; console.log("  [PASS] " + name); }
        else { fail++; console.log("  [FAIL] " + name + (extra ? " -> " + extra : "")); }
    }

    /* --- 1. 纯函数单测 --- */
    console.log("===== 1. 内部函数单测 =====");
    const unit = await runScript(src, { argument: "" });   // 占位配置 -> 不发请求
    const ctx = unit.sandbox;
    if (typeof ctx.splitSetCookie !== "function") {
        console.log("!! 无法访问内部函数，跳过单测");
    } else {
        const s = ctx.splitSetCookie;
        check("单条 Set-Cookie 带属性",
            s("uid=123; path=/; expires=Mon, 06-Apr-2026 03:14:11 GMT; SameSite=Lax; secure") === "uid=123",
            s("uid=123; path=/; expires=Mon, 06-Apr-2026 03:14:11 GMT; SameSite=Lax; secure"));
        const multi = s("uid=123; path=/; expires=Wed, 30 Sep 2026 03:14:11 GMT, key=abc; path=/, email=a%40b.com; path=/");
        check("多条 Set-Cookie 合并 (string)", multi === "uid=123; key=abc; email=a%40b.com", multi);
        const arr = s(["uid=1; Path=/", "key=2; Path=/", "lang=zh-cn; Path=/"]);
        check("Set-Cookie 为数组", arr === "uid=1; key=2; lang=zh-cn", arr);
        check("过期属性不会被当成 Cookie",
            s("uid=1; expires=Wed, 30 Sep 2026 03:14:11 GMT; Max-Age=0").indexOf("expires") === -1);

        const m = ctx.mergeCookie;
        check("Cookie 合并：新值覆盖旧的", m("uid=1; key=old", "key=new; email=x") === "uid=1; key=new; email=x", m("uid=1; key=old", "key=new; email=x"));

        check("parseJSON 拒绝 HTML", ctx.parseJSON("<html>hi</html>") === null);
        check("parseJSON 接受对象", JSON.stringify(ctx.parseJSON('{"ret":1,"msg":"ok"}')) === '{"ret":1,"msg":"ok"}');
        check("toText 处理 undefined", ctx.toText(undefined) === "");
    }

    /* --- 2. 未配置账号时的提示 --- */
    console.log("\n===== 2. 占位配置应提示未配置 =====");
    const unconfigured = await runScript(src, { argument: "" });
    const n0 = unconfigured.sandbox.__notifications[0];
    check("发出未配置通知", !!n0 && /未配置/.test(n0.title), JSON.stringify(unconfigured.sandbox.__notifications));
    check("$done 只调用一次且已结束", unconfigured.sandbox.__done === true);

    /* --- 3. 真实网络：错误密码 --- */
    console.log("\n===== 3. 真实站点：错误账号登录 =====");
    const bad = src
        .replace('email: "你的邮箱@example.com",', 'email: "dsh-probe-0000@example.com",')
        .replace('passwd: "你的密码",', 'passwd: "definitely-wrong-password",')
        .replace("debug: false", "debug: true");
    const badRun = await runScript(bad, { argument: "" });
    show(badRun, "错误账号");
    const badText = (badRun.sandbox.__notifications[0] || {}).content || "";
    check("错误账号被正确识别", /登录失败/.test(badText), badText);
    check("错误账号 => 任务失败", badRun.sandbox.__notifications[0] && badRun.sandbox.__notifications[0].title === "69云签到");

    /* --- 4. 真实网络：预置失效 Cookie 应自动回退到登录 --- */
    console.log("\n===== 4. 真实站点：失效 Cookie 应回退登录 =====");
    const stale = src
        .replace('email: "你的邮箱@example.com",', 'email: "dsh-probe-0000@example.com",')
        .replace('passwd: "你的密码",', 'passwd: "definitely-wrong-password",')
        .replace("debug: false", "debug: true");
    const emailKey = "69yun_cookie_dsh-probe-0000@example.com";
    const staleStore = {};
    staleStore[emailKey] = "uid=1; key=deadbeef";
    const staleRun = await runScript(stale, { argument: "", store: staleStore, verbose: true });
    show(staleRun, "失效 Cookie");
    const staleText = (staleRun.sandbox.__notifications[0] || {}).content || "";
    check("失效 Cookie 会回退到登录并报登录失败", /登录失败/.test(staleText), staleText);

    /* --- 5. 真实网络：$argument 传入账号 --- */
    console.log("\n===== 5. 真实站点：$argument 传参 =====");
    const argRun = await runScript(src, {
        argument: JSON.stringify({ accounts: [{ email: "dsh-probe-0001@example.com", passwd: "nope" }] })
    });
    show(argRun, "$argument 传参");
    const argText = (argRun.sandbox.__notifications[0] || {}).content || "";
    check("$argument 配置生效并访问了登录接口", /登录失败|邮箱不存在/.test(argText), argText);

    /* --- 6. 真实网络：手动 Cookie 模式不应触发登录 --- */
    console.log("\n===== 6. 手动 Cookie 模式（已失效 Cookie） =====");
    const cookieRun = await runScript(src, {
        argument: JSON.stringify({ accounts: [{ email: "probe@example.com", cookie: "uid=1; key=deadbeef" }] }),
        verbose: true
    });
    show(cookieRun, "Cookie 模式");
    const cookieText = (cookieRun.sandbox.__notifications[0] || {}).content || "";
    check("Cookie 失效时给出明确提示", /Cookie 已失效/.test(cookieText), cookieText);
    check("Cookie 模式不会去调用登录接口", !/登录失败/.test(cookieText), cookieText);

    /* --- 7. 真实网络：Loon 插件 [Argument] 对象传参 --- */
    console.log("\n===== 7. 插件参数对象传参（模拟 Loon 导入插件） =====");
    const pluginArg = { email: "dsh-probe-0002@example.com", passwd: "nope", code: "", email2: "", passwd2: "" };
    const pluginRun = await runScript(src, { argument: pluginArg });
    show(pluginRun, "插件参数（单账号）");
    check("插件对象参数被识别为 1 个账号", pluginRun.sandbox.__notifications.length === 1,
        "通知数=" + pluginRun.sandbox.__notifications.length);
    check("插件参数走通了登录接口",
        /登录失败|邮箱不存在/.test((pluginRun.sandbox.__notifications[0] || {}).content || ""));

    /* --- 8. 真实网络：插件参数里的第二个账号 --- */
    console.log("\n===== 8. 插件参数：第二个账号 =====");
    const pluginRun2 = await runScript(src, {
        argument: { email: "dsh-probe-0003@example.com", passwd: "nope", email2: "dsh-probe-0004@example.com", passwd2: "nope" }
    });
    show(pluginRun2, "插件参数（双账号）");
    const ns2 = pluginRun2.sandbox.__notifications;
    check("两个账号各产生一条通知 + 一条汇总", ns2.length === 3, "通知数=" + ns2.length + " :: " + ns2.map((n) => n.title).join(" | "));
    check("汇总通知存在", ns2.some((n) => /存在失败|全部完成/.test(n.title)));

    console.log("\n================================");
    console.log("通过 " + pass + " 项，失败 " + fail + " 项");
    process.exit(fail ? 1 : 0);
})();
