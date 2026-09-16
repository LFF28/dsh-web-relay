# 模块：公网入口、CA 分发与登录接续

职责：给操作者一个**可以收藏的固定 URL**，让手机在 Cookie 过期后能一键重新进入，而不必回到服务器终端去抄一个每次启动都变化的令牌 URL；同时把中继 CA 根证书放在一条可核对的地址上。

## 两个问题

DSH 的浏览器认证是"进程启动令牌 → Cookie"：`dsh web` 启动时打印一个带 `?token=` 的 URL，浏览器打开它，`authorizeIndex()` 校验权威与令牌，下发一个权威绑定的 HMAC Cookie（默认 30 天，`connection` 行的 `cookieMaxAgeDays`）。令牌每次启动都变，因此那个 URL 不能收藏。Cookie 过期后需要重新拿令牌。

本模块解决"重新拿令牌"这一段：把一次性的启动令牌，换成一个稳定的、由操作者持有的长期口令。第二个问题是"装不装 CA"——根证书必须能被取到、且能被核对指纹，否则"装 CA"这个选项在手机上无法完成。

## 两条路由

两条都是精确路径注册（`kind: 'exact'`），因此不会与 SPA 的 fallback 或 `/api` 前缀冲突。

```
GET /relay/enter?key=<entryKey>     # entry.enabled 为真时注册
GET /relay/ca.crt                   # 中继 CA 根证书副本
```

`/relay/enter` 的处理逻辑：

```
1. 取 query 里的 key；缺失或多值 → 404
2. 常量时间比较 key 与 entryKey（长度不等也走完整比较路径）
3. 不匹配 → 计数一次失败，返回 404（空响应体）
4. 匹配 → 303，Location = ctx.connection.authenticatedUrl(`https://${authority}`)
```

第 4 步是关键的复用点：`authenticatedUrl(baseUrl)` 是 DSH 的公开方法，它把"本进程当前的启动令牌"拼到给定 URL 上，并重置 path/search/hash，只保留 `token` 这一个 query 参数。插件因此**永远不接触签名密钥**，也不需要知道 Cookie 是怎么生成的。浏览器跟随 303 后走的是 DSH 自己的 `authorizeIndex()`，与 `dsh web` 在 LAN 上的行为完全一致。

`ctx.connection` 通过 `ctx.inject(['connection'], (c) => ...)` 获取，不放进顶层 `inject`（那会与 `connection` 行注入 `webRelay` 形成等待环），与 `@deepseek-ai/dsh-client-connection` 自己用 `ctx.inject(['webServer'], ...)` 的写法一致。

`/relay/ca.crt` 读 `$DSH_HOME/dsh-web-relay/ca/root.crt`（引导第 10 步取回，`0644`），以 `application/x-x509-ca-cert` 与 `Content-Disposition: attachment; filename="dsh-web-relay-ca.crt"` 返回。文件不存在时返回 404 而不是 500——"还没引导"是正常状态。它与 `/relay/enter` 的可用性无关，因此不受 `entry.enabled` 影响；服务器本机的 `http://127.0.0.1:<dshPort>/relay/ca.crt` 同样可取，取证书因而**不必先过一次公网 TLS 握手**。

## 入口口令从哪来

放在插件自己写的 `web-relay-record` 命名空间的 `entryKey` 字段里（见 [configuration.md](../configuration.md)），形状是 32 字节 `base64url`。

- **首次激活时自动生成**：插件读到 `entryKey` 为空就生成一个、`scope.replace` 写回记录，并在启动横幅里打印。
- **重新打印**用 `entry.banner: 'on-generate' | 'always' | 'never'`（默认 `on-generate`）。设为 `always` 后重启 profile 或重新引导，横幅就会再打印一次当前口令；看完改回即可。
- **轮换**用卡片上的"轮换书签"按钮：它递增 `web-relay` 的 `entryRotateRequest`，插件随即清空记录里的 `entryKey` 并生成新的。轮换不依赖远程访问是否可用——这一点很重要，因为"需要轮换"的场景往往就是"远程访问出了问题"。命令行路径见 [operations.md](operations.md)。
- 插件不自带可执行文件（bin）。管理动作全部由"改设置 + 重启 profile"完成，这也让它与"只有 `dsh` profile 启动应用"的既有约定一致。

为什么不放进 `Config`：配置文件是"部署参数"的载体，会被提交、被复制、被贴进 issue。口令属于运行记录，放进 settings 才符合 DSH 的既有分工，也才复用了它已有的权限与落盘规则。

## 三层入口

| 层 | 位置 | 形态 | 失效后果 |
| --- | --- | --- | --- |
| 第一层：网关口令 | 中继 Caddy `basic_auth` | 操作者手工输入，Safari 会话内缓存 | 攻击者仍进不到 DSH |
| 第二层：DSH Cookie | 内网 DSH | 启动令牌换来的权威绑定 HMAC Cookie | 入口口令单独泄漏也无法拿到会话 |
| 稳定入口口令 | `/relay/enter` 的 `key` | 书签里的长期口令 | **单独泄漏无用**，仍需第一层口令 |

第三层"单独泄漏无用"这一点是本设计的核心性质：`/relay/enter?key=...` 本身什么都不做，它必须先过 Caddy 的第一层。因此一个泄漏的书签 URL 不构成单独可利用的凭据，它才可以被允许显示在卡片里。

## 失败与滥用

- **常量时间比较**：直接复用 Node 的 `crypto.timingSafeEqual`，长度不等时先对固定长度的摘要比较，避免早退泄漏长度。
- **404 而不是 403 / 401**：不匹配时返回与"路径不存在"相同的响应，不给出任何区分信息。这条路径的存在是公开的（在仓库文档里），隐藏它没有价值；隐藏口令才有价值。
- **进程内失败计数**：`entry.maxFailures`（默认 20）与 `entry.lockoutMs`（默认 15 分钟），按 `X-Forwarded-For` 的最左项分桶。这一层的作用是**限制误触与低成本穷举**，不是完整的爆破防护：中继上没有配置 `trusted_proxies`，因此 Caddy 会丢弃客户端自带的 `X-Forwarded-For` 并把它写成真实对端地址，计数依据的 IP 是可信的；但攻击者换 IP 就能重置计数。真正的防护是"每个请求都要先过一次 bcrypt 校验的第一层口令"，加上中继侧的 fail2ban，见 [operations.md](operations.md)。
- **不记录 key**：日志里只记 `match` / `mismatch` 与来源 IP，永不记录口令本身。同时中继侧的访问日志要过滤掉 `key` 参数，见 [relay-host.md](relay-host.md)。

## 启动横幅

引导、隧道与自检都就绪后（或自检超时后），打印一次：

```
dsh-web-relay: 远程入口已就绪
  稳定书签   https://<publicAuthority>/relay/enter?key=<32 字节 base64url>
  本次令牌   https://<publicAuthority>/?token=<launch token>
  中继 CA    指纹 SHA256:… ，下载 https://<publicAuthority>/relay/ca.crt
  隧道       running (since 12:04:31, 连接成功 1 次)
```

- 第一行的完整口令只在生成了新口令时打印（`entry.banner: 'on-generate'`，默认）；`always` 每次都打印，`never` 不打印。
- 第二行直接来自 `ctx.connection.authenticatedUrl(...)`，插件不自己拼。横幅是异步打印的，若此时 `connection` 尚未注入就略过这一行并记一条说明——它是便利信息，不是必需信息。
- 第三行给出的是"装不装 CA"这个决定所需的全部材料：指纹与下载地址都在，用户可以自己去中继上 `data/pki/authorities/dsh-relay/root.crt` 核对。
- 两行 URL 用途不同：稳定书签进收藏夹（Cookie 过期后用它重新进入），本次令牌用于"现在就要进"的场景（例如复制到已经在用的设备上）。
- 隧道状态那一行来自 `ctx.webRelay.status()`，自检细节见 [trust.md](trust.md)。

横幅只在启动时打印，不进入浏览器可见面，因此不需要客户端本地化与快照测试。横幅内容会经过一次检查：只写日志，不写任何 HTTP 响应体。

## 明确不做

- 不做 `/relay/signout`（清 Cookie）。DSH 的 Cookie 是 `HttpOnly`，插件无法替浏览器清除它；浏览器侧清站点数据即可。
- 不做 `/relay/rotate`（通过 HTTP 轮换入口口令）。轮换必须能在**不需要**远程访问的前提下完成（远程访问坏了才最需要轮换），因此它由卡片按钮或本地文件操作 + 重启完成。
- 不做第三方登录（OIDC / TOTP）。对单用户场景是纯粹的复杂度；中继侧加 TOTP 还会破坏"中继只有 sshd 与 Caddy"这条简化。
