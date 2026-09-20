# 模块：公网入口、CA 分发与登录接续

职责：给操作者一条**不含任何秘密、可以收藏**的入口 URL，让手机重新进入时只需输入一次网关口令；同时把中继 CA 根证书放在一条可核对的地址上。

## 要解决的问题

DSH 的浏览器认证是"进程启动令牌 → Cookie"：`dsh web` 启动时打印一个带 `?token=` 的 URL，浏览器打开它，`authorizeIndex()` 校验权威与令牌，下发一个权威绑定的 HMAC Cookie（默认 30 天，`connection` 行的 `cookieMaxAgeDays`）。令牌每次启动都变，因此那个 URL 不能收藏。

本模块解决"重新拿令牌"这一段：入口本身不携带凭据，操作者在浏览器弹出的口令框里输入网关口令，请求到达内网主机后由插件在服务端完成一次令牌交换。第二个问题是"装不装 CA"——根证书必须能被取到、且能被核对指纹，否则"装 CA"这个选项在手机上无法完成。

## 两条路由

两条都是精确路径注册（`kind: 'exact'`），因此不会与 SPA 的 fallback 或 `/api` 前缀冲突。

```
GET /relay/enter     # entry.enabled 为真时注册
GET /relay/ca.crt    # 中继 CA 根证书副本
```

`/relay/enter` 不接受查询参数，也不要求任何 Cookie。它能这样是因为它**在结构上位于网关口令之后**：中继的站点块把没有网关会话 Cookie 的请求先交给 `basic_auth`，只有口令通过才继续代理到内网主机（见 [relay-host.md](relay-host.md)）。因此"请求到达了 `/relay/enter`"本身就是"口令正确"的证明，插件不需要再校验一遍，也不持有任何入口凭据。

处理逻辑：

```
1. 本地发起 GET http://127.0.0.1:<dshPort>/?token=<启动令牌>，Host 设为 publicAuthority
2. 收下这一跳的 303 与它下发的 Set-Cookie
3. 向浏览器回 303，Location 为 /，原样转发 Set-Cookie
```

第 1 步是关键的复用点：启动令牌来自 `ctx.connection.authenticatedUrl(...)`，它是 DSH 的公开方法，把"本进程当前的启动令牌"拼到给定 URL 上。插件因此**永远不接触签名密钥**，也不需要知道 Cookie 是怎么生成的。那一跳走的是 DSH 自己的 `authorizeIndex()`，与 `dsh web` 在 LAN 上的行为完全一致。实测浏览器看到的响应是 `303`、`location: /`，且只有一条 `Set-Cookie`。

这一跳必须用 `node:http` 发，不能用 `fetch`：令牌的校验依据是请求的 `Host`，而 `Host` 在 fetch 规范里是禁止修改的头，undici 会拒绝设置。用 `fetch` 时 Host 会是 `127.0.0.1:<dshPort>`，权威对不上，签出的 Cookie 名字与受众都会是错的。`node:http` 没有这个限制，也不需要引入任何依赖。

`ctx.connection` 通过 `ctx.inject(['connection'], (c) => ...)` 获取，不放进顶层 `inject`（那会与 `connection` 行注入 `webRelay` 形成等待环），与 `@deepseek-ai/dsh-client-connection` 自己用 `ctx.inject(['webServer'], ...)` 的写法一致。

`/relay/ca.crt` 读 `$DSH_HOME/dsh-web-relay/ca/root.crt`（引导第 10 步取回，`0644`），以 `application/x-x509-ca-cert` 与 `Content-Disposition: attachment; filename="dsh-web-relay-ca.crt"` 返回。引导还没产出证书时它回答 `404`。公网上的这一条在网关口令之后，与其他路径一样要先通过 `basic_auth`；它与 `/relay/enter` 的可用性无关，因此不受 `entry.enabled` 影响。第一台设备因此不能靠"信任一个自己还不信任的 TLS 端点"取到根证书：要么从服务器本机取（`http://127.0.0.1:<dshPort>/relay/ca.crt`，或直接复制 `$DSH_HOME/dsh-web-relay/ca/root.crt`）再经本地复制、AirDrop、聊天软件等不依赖 TLS 信任的渠道送到设备，要么在设备上用 `curl -k -u me:<password> https://<publicAuthority>/relay/ca.crt` 取。

直接打开 `https://<publicAuthority>/`（不带 `/relay/enter`）不会进入入口：浏览器还没有 DSH 会话 Cookie 时它得到 DSH 自己的 `401` 与 `unauthorized` 响应体，并停在那一页。Caddy 不会把它改写成跳转，也没法改写：`handle_errors` 只处理 Caddy 自己的处理错误（502 一类），不改变上游透传的 4xx。因此入口地址只能由卡片与引导横幅告诉操作者，不存在"首次访问自动带路"。

## 入口 URL 从哪来

入口 URL 完全由权威决定：`https://<publicAuthority>/relay/enter`。它不含任何秘密，所以可以进收藏夹、进浏览器历史、进 iCloud 同步、进设备备份——这些地方泄漏它都不构成凭据泄漏。真正承担身份的是网关口令与 DSH 的权威绑定 Cookie。

这意味着入口**没有任何需要生成、轮换或保管的东西**：没有 key，没有记录字段，没有轮换按钮。要换凭据就换网关口令，要作废全部会话就删掉 DSH 的会话签名密钥记录，两者都见 [operations.md](operations.md)。

`entry.enabled` 是唯一的开关：关掉后 `/relay/enter` 不再注册，公网入口只能靠已有的 DSH Cookie 进入。它的用途是"临时关掉入口而不停隧道"。

## 两层与一个换票点

| 层 | 位置 | 形态 | 失效后果 |
| --- | --- | --- | --- |
| 第一层：网关口令 | 中继 Caddy `basic_auth` | 操作者手工输入，浏览器会话内缓存 | 没有口令到不了内网主机 |
| 第二层：DSH Cookie | 内网 DSH | 启动令牌换来的权威绑定 HMAC Cookie | 没有它 `/api` 全部 401 |
| `/relay/enter` | 内网 DSH，插件注册 | **换票点，不是一层**：只做令牌交换 | 关掉它则只能靠已有 Cookie 进入 |

第三条不是身份层。这是本设计相对"入口带 key"的简化：入口不再是一个需要保管的秘密，只是一条固定的、非秘密的路径。

## 失败与滥用

- **不校验自家凭据。** 口令校验、失败计数与封禁全在网关口令那一层（Caddy 的 bcrypt 与中继上的 fail2ban）。`/relay/enter` 因此没有可被爆破的秘密，也就不需要进程内的计数与锁定。
- **不记录秘密。** 启动令牌只出现在插件到本机 loopback 的那一次请求里，不进日志、不进 HTTP 响应体、不进浏览器地址栏。
- **`entry.enabled` 为假时路由不存在**，请求落到 SPA 的 fallback，得到与"路径不存在"相同的响应。

## 启动横幅

引导、隧道与自检都就绪后（或自检超时后），插件向 stdout 打印一行入口地址，形如 harness 自己打印的 `dsh web:` 那一行：

```
dsh-web-relay: https://<publicAuthority>/relay/enter
```

之所以直接写 stdout，是因为本构建的日志服务没有 console exporter：逐步引导进度走 harness 日志，持久状态写进 `web-relay-record` 记录，只有入口 URL 需要操作者在终端上直接看到。CA 指纹与下载地址都在记录的 `caFingerprint` / `caUrl` 里，与卡片状态区一致，可在中继上对 `data/pki/authorities/dsh-relay/root.crt` 核对。

这一行不含任何秘密，因此没有"何时打印"的策略开关。它只在启动时打印，不进入浏览器可见面，因此不需要客户端本地化与快照测试；它不写任何 HTTP 响应体。

## 明确不做

- 不做 `/relay/signout`（清 Cookie）。DSH 的 Cookie 是 `HttpOnly`，插件无法替浏览器清除它；浏览器侧清站点数据即可。
- 不做"记住这台设备"。任何按设备免输口令的机制都会把口令重新物化成一条长期凭据，这正是本设计去掉 `?key=` 的原因。
- 不做第三方登录（OIDC / TOTP）。对单用户场景是纯粹的复杂度；中继侧加 TOTP 还会破坏"中继只有 sshd 与 Caddy"这条简化。
