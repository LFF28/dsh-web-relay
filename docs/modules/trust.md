# 模块：权威注册与启动自检

职责：让 DSH 接受公网权威，并且在配置错了的时候**在启动时就报错**，而不是等操作者在手机上看到一个 403。

## 为什么需要这一步

DSH 的 `/api` 在认证之前有一道 Host/Origin 围栏（失败返回 **403**，认证失败返回 **401**）。围栏的判定函数 `isTrustedApiRequest(request, trustedHosts)` 要求 Host 是 loopback 或者在一个**显式声明的权威列表**里；随后还要求 `sec-fetch-site` 不是 `cross-site`，以及 Origin（若存在）的 host 与 Host 的 host 相同。

围栏注释明确写着它防的是"本地 HTTP API 的混淆代理攻击"（DNS rebinding 与跨站请求），并且**不是认证层**。所以正确的做法不是绕过它，而是把公网权威显式声明进去——这正是 DSH 文档化的组合方式。

同理，首页与 `authorizeIndex()` 要求 Cookie 的 `authority` 与请求的权威一致，Cookie 名也是 `sha256(authority)` 的编码。权威不声明，即使 Cookie 有效也会走 401/未授权路径。

## 权威从哪来

权威由用户在设置卡片里填的两个字段推出，没有第三个来源：

```
publicAuthority = canonicalAuthority(vps.host) + ':' + gateway.port
                  （vps.host 自带端口时以它为准，gateway.port 不起作用）
```

规范化在插件自己的 `src/authority.ts` 里完成，不调用 DSH 的导出——`@deepseek-ai/dsh-client-connection` 并不导出这些助手。它按 `packages/client/connection/src/api-request-trust.ts` 的语义重新实现了 `parseAuthority`、`explicitPort`、`canonicalAuthority`、`isBareAuthority`、`publicAuthority` 与 `canonicalHostname`：

- 形状校验（`isBareAuthority`）要求裸的规范 `host[:port]`，不能带 scheme、path、userinfo。**形状非法时设置保存被拒**，界面保留草稿并显示原因，文档不变。
- `canonicalAuthority()` 只在权威确实带端口时保留端口，特殊 scheme 的默认端口也算显式：`canonicalAuthority('example.com:443')` 仍是 `'example.com:443'`，与 `'example.com'` 不是同一个权威。IP 字面量不能带端口以外的内容。

一条实用规则：**端口不写就等于"任意端口"**。围栏的权威条目没有端口时按 hostname 比较。设计上仍然要求显式写出中继入口端口（`gateway.port` 默认 `8443`），减少隐式行为。

## patch 层怎么接

见 [plugin-bundle.md](plugin-bundle.md) 的 patch 示例与三条机制。这要求插件在 `apply` 返回之前**同步** `ctx.provide('webRelay', ...)`，不能 `await` 之后再 provide；`apply` 因此是同步函数。

## 权威变化如何在进程内生效

`HostConnectionService` 的构造函数签名是 `(ctx, trustedHosts, browserAuth)`，内部把 `trustedHosts` 存为不可变字段，**没有 setter**。用户改了 `vps.host` 或 `gateway.port` 之后，本模块用 `ctx.loader.resolve('connection')` 取到那一行，对它的 fiber 调用 `update(entry.options.config, true)`：

- `entry.options.config` 是未求值的原始配置，仍带着 `!!js` 表达式，`Fiber.update` 会用当前 `ctx` 重新求值，`ctx.webRelay.trustedHosts` 因此是新的。
- `noSave = true` 让 loader 的写回监听器跳过，解析出的字面量不会覆盖配置文件里的表达式。
- fiber 重启时 `/api` 路由先注销再注册；已建立的 WebSocket 不受影响。

这个动作只在规范化后的权威**真的变了**时执行，普通保存不扰动连接。实现细节与这段推理的依据见 [plugin-bundle.md](plugin-bundle.md)。

与 `webRuntime.trustedHosts` 的关系：`@deepseek-ai/dsh-web-app` 的 `resolveLanTrust(bindHost, extra)` 在 loopback 绑定时给出**空列表**（只有绑 `0.0.0.0` 时才会自动加入 LAN 字面量），所以插件的权威不会被默认值覆盖。插件只读 `webRuntime`，不改它——`webRuntime.trustedHosts` 保持"由 web-app 决定的本机信任集合"，插件贡献的是"由部署决定的外部权威集合"，两者在 `connection` 行合并。

`dsh web` 的 CLI 也有 `--trusted-host <authority...>`（可重复），与 `webRuntime.trustedHosts` 是同一份数据。本插件不使用这条路径，因为它的入口是设置卡片而不是启动命令行。

## 启动自检

权威声明错了（端口与 Caddy 不一致、域名写错、安全组没开）时，现象是"手机打开是 403 或 401 或超时"，这对远程操作者最难排查：他没有终端，而 DSH 只回一个状态码。因此引导完成后主动做一次探测，把"远端某个未知原因"变成"内网终端里的一行错误"。

```
引导第 11 步之后（异步，不阻塞 apply）
  │
  ├─ 等待隧道进入 running（最长 tunnel.healthyAfterMs，默认 10s）
  │
  ├─ 探测 ①：对 http://127.0.0.1:<dshPort>/ 发一个请求
  │            Host: <publicAuthority>
  │            期望：不是 403（说明权威已被围栏接受）
  │
  ├─ 探测 ②：对 https://<publicAuthority>/ 经真实公网路径发一个请求
  │            不带任何 Cookie
  │            单次请求超时 selfCheck.probeTimeoutMs（默认 5s）
  │            期望：TLS 握手成功；得到 401 或 200
  │
  ├─ 探测 ③：带网关会话 Cookie 与 Accept: text/html 再打一次同一个地址
  │            期望：303，且 Set-Cookie 里有带 Secure 的 dsh-auth-…
  │            （入口关掉时期望 403 而不是 303）
  │
  ├─ 探测 ④：带着 ③ 换来的 DSH Cookie 打第三次
  │            期望：200（权威绑定的 Cookie 被接受）
  │
  └─ 汇总：成功 → 日志一行 "remote access ready: <url>"
           失败 → 日志一段可执行修复建议（见下）
```

- 探测 ① 只测"围栏是否接受这个 Host"，因此它命中 `/api/` 下的任一路径即可；不带 Cookie 时正确的期望是 **401**（不是 403）。**403 就是权威没生效的确定信号**。这一条是本模块最有价值的断言：它把一个模糊的"手机打不开"变成了明确的分类。
- 探测 ① 直接连 `127.0.0.1:<dshPort>`，不过隧道，因此它能把"权威没生效"与"隧道没通"分开——这是两个位置完全不同的故障。
- 探测 ② 会真的走公网。它验证 TLS 证书链、Caddy 是否在跑、安全组是否开放、以及隧道是否真的把流量送到了。默认开启，可用 `selfCheck.publicProbe: false` 关掉（例如内网主机不能直连公网时）。
- 探测 ③ 与 ④ 走的就是操作者首访的那条路：中继把这次文档导航在内部改写成 `/relay/enter`（见 [entry.md](entry.md)），插件换票、中继补 `Secure`、回跳 `/`。它们因此同时盯着三件容易静默失效的事——改写还在、换票还在、`header_down Set-Cookie "$" "; Secure"` 还在。**只有这三跳一起验证，"裸地址打开就是 200"才算被证明过**，这也是原来靠人工核对的那条 `Secure` 清单现在由自检负责的原因。
- 会话密钥是 ③ ④ 唯一的凭据：它等价于一次口令通过，绕开口令提示直接走到上游，因此探测本身不产生口令失败、不喂 fail2ban，也不把口令发到公网。它是公网上唯一的密文凭据，所以只在根证书已取回、对端身份可校验时才发出去——否则只做 ①②，结论里注明"未验证裸地址带路"。同理，`selfCheck.publicProbe: false` 时设备上发生的一切都靠人工验证。
- 自检发生在引导之后，**失败不阻止 profile 启动**。远程访问是附加能力，让本地 `dsh web` 因为公网链路问题起不来是不可接受的。失败只写日志与记录的 `lastError`。

### 失败信息里给什么

每种失败给出"症状 → 最可能原因 → 下一步命令"三段，而不是打印原始错误。例如：

| 观测 | 结论 | 给出的下一步 |
| --- | --- | --- |
| 探测 ① 返回 403 | 权威没进 `trustedHosts` | 打印 `webRelay.authority()` 与 `connection` 行实际解析出的 `trustedHosts`，指出差异 |
| 探测 ① 连接被拒 | 隧道没通或端口不对 | 打印隧道 `status()` 与 `ctx.webServer.port` / `ctx.webServer.host` 的实际值 |
| 探测 ② TLS 证书校验失败 | 客户端不信任中继 CA | 输出根证书指纹，并指向 [entry.md](entry.md) 里把根证书送到设备的方式 |
| 探测 ② 401 但浏览器仍打不开 | 浏览器侧 Cookie 或网关口令 | 指向 [security.md](../security.md) 的"必须成立的前置条件" |
| 探测 ② 超时 | 安全组 / Caddy 未监听 / 端口不通 | 指向 [relay-host.md](relay-host.md) 的防火墙清单 |
| 探测 ③ 拿到 401 而不是 303 | 中继上的 Caddyfile 还是旧版（没有 `@noDsh` 改写） | 重新引导一次，让第 9 步重写并 reload |
| 探测 ③ 的 303 里没有 `dsh-auth-…` | 中继上的 Caddyfile 是旧版 | 同上 |
| 探测 ③ 的 Cookie 没有 `Secure` | `header_down` 没生效 | 检查上游片段是否被人改过，重新引导一次 |
| 探测 ④ 不是 200 | 换来的 Cookie 被拒（权威绑定的名字对不上） | 打印换到的 Cookie 名与 `webRelay.authority()`，指出差异 |

### 顺带检出的部署问题

自检还比对两件与安全无关但会让人困惑的事实，只在日志里提示一次，不改配置：

- `ctx.webServer.host` 不是 loopback 时提示"DSH 正监听非 loopback 地址"，与本设计的前提不符。
- `directory-picker` 行仍解析到原生后端时提示远程会弹出服务器屏幕上的选择器，以及消掉它的覆盖写法（见 [security.md](../security.md)）。

## 已知不做

- **不做"探测到 403 就静默改配置"。** 权威变化的唯一来源是用户在卡片上的输入，插件不猜。
- **不改写 Host 来让围栏通过。** 围栏唯一信任的信号是"Host 由浏览器真实给出"；改写它等于拆掉第四层，见 [security.md](../security.md)。
- **不自动把 `--trusted-host` 加到 CLI 参数里。** 插件无法影响启动命令行，且它不打算把权威变成第二个配置位置。
