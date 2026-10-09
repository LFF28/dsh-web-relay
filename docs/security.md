# 安全设计

前提：这是**单用户、暴露在公网、语义等价于远程命令执行**的服务。`session.prompt` 会在服务器上执行命令，任何进到 DSH 界面的人就拿到了那台机器的执行能力。本文件说明设计如何在承认这个前提的情况下把它收窄。

## 威胁模型

| 威胁 | 场景 | 设计中的对策 |
| --- | --- | --- |
| 公网扫描 | 攻击者扫到 8443 上的 TLS 服务 | 没有网关口令越不过第二层；DSH 侧还有第三层 |
| 口令爆破 | 对 Caddy 的口令校验反复尝试 | bcrypt 校验成本 + 中继侧 fail2ban 封 IP（只统计带 `Www-Authenticate` 的 `basic_auth` 401，不把 DSH 自身的 401 计入），见 [modules/relay-host.md](modules/relay-host.md) |
| 中间人 | 链路被旁听或篡改 | TLS；内网到中继的 SSH 固定主机密钥 |
| 访问地址泄漏 | 收藏的 `https://<权威>/` 落到他人手里 | 该地址不含任何秘密，单独无效；没有网关口令到不了内网主机，见 [modules/entry.md](modules/entry.md) |
| Cookie 失窃 | 浏览器侧 Cookie 被读走 | `HttpOnly`（脚本读不到）+ `SameSite=Strict`（跨站不发）+ `Secure`（明文不发，由中继补上）+ 权威绑定（换权威即失效） |
| 同主机其他端口的服务 | 中继上还跑了别的 HTTP 服务，读到或写入同一个 Cookie | 中继只开 `gateway.port` 一个 HTTP 端口；Cookie 不按端口隔离（RFC 6265 第 8.5 节），所以唯一可靠的对策是"没有第二个端口" |
| 中继主机被入侵 | VPS 被攻破 | 中继上没有任何 DSH 凭据，但隧道上的明文流量可被读到——这是本架构的固有代价，见下文 |
| 伪造 Host 打本机 | 本机上的恶意页面用 DNS rebinding 打 `127.0.0.1:3080` | DSH 既有围栏；本设计只增加一个必需权威，不扩大到通配 |
| 局域网直连 | 同网段设备直连 DSH | DSH 仍只听 `127.0.0.1`；插件从不请求 `0.0.0.0` |
| 内网主机被入侵 | 攻击者拿到 `dsh web` 的进程 | 该主机本来就存着管理账号的私钥，因此这不是新增的权限。转发前预检把**插件自身失误**的爆炸半径限制成一个 `sshd` / `sshd-session` 进程，见下文"中继侧的最小权限" |
| 引导过程泄漏口令 | 口令出现在命令行或日志里 | 唯一的口令是 `gateway.password`，它只走中继上 `caddy hash-password` 的 stdin；日志与记录里只出现"已设置"。管理登录走密钥，不存在管理口令 |

### 中继主机被入侵这一项要如实说明

中继的 `sshd` 上有一条 `authorized_keys`，允许内网主机建立反向转发。中继被攻破时，攻击者可以监听 `127.0.0.1:18080` 上的明文 HTTP（TLS 已在 Caddy 终止）并读走经过的 Cookie，也可以直接向该端口发请求并把 Host 设成声明的权威。后者还能顺手走一次 `/relay/enter`：这条路由不校验自家凭据，它的安全性来自"中继上只有 Caddy 会把请求交给它"，而这个前提在被攻破的假设下不成立。

这个风险不能靠插件消除，只能靠"中继上只跑 `sshd` 与 Caddy、及时打补丁、安全组只开 8443"来压低。它是选择"自建公网中继"的固有代价，也是把中继当作需要自己维护的机器而非"外部服务"的理由。

## 身份分层

```
第一层  TLS 校验           阻止被动旁听与中间人
第二层  Caddy 网关口令      阻止无口令访问（bcrypt + 网关会话 Cookie）
第三层  DSH 权威绑定 Cookie 阻止无 Cookie 的 RPC；换权威即失效
第四层  DSH Host/Origin 围栏 阻止跨站与 DNS rebinding
```

四层互相独立，任一层失效不连带其他层。第一、二层在中继主机，第三、四层在内网主机。

`/relay/enter` 不是一层。它不接受查询参数，也没有自家凭据，只把"已经过了第二层"的请求换成一份 DSH Cookie；它之所以安全，是因为中继的站点块在结构上让没有口令的请求到不了它——包括中继把裸地址上的文档导航内部改写到它这一条：改写发生在 `basic_auth` 之后，因此改写本身不会把请求送进一个没有口令的路径。见 [modules/entry.md](modules/entry.md)。

**为什么第二层是必需的，而不是可选加固。** DSH 自身的认证是单操作者的：一个启动令牌、一个长期 Cookie，没有多用户、没有吊销列表、没有频率限制。把它直接挂到公网等于把一个 RCE 级界面挂到公网。

**DSH 自己不给 Cookie 加 `Secure`，由中继补上。** DSH 下发的是 `Max-Age; Path=/; Expires; HttpOnly; SameSite=Strict`，没有 `Secure`。缺了这一位，同一个权威上的任何一次明文请求都会把 Cookie 送出去，RFC 6265 第 8.3 节对这种情况的结论是"安全信道提供的保护基本是空的"。插件不修改 DSH 源码，所以补这一位发生在上游定义里的 `header_down Set-Cookie "$" "; Secure"`：它把每个 `Set-Cookie` 的值整体匹配并在末尾追加，与 Cookie 的属性顺序无关，也不会给本来就带 `Secure` 的响应对出重复属性。这一位如今由引导第 13 步的自检盯着（换票拿到的 Cookie 必须带 `Secure`），不再是人工核对项；按 `dsh-auth-` 前缀定点匹配的写法能过校验、今天也能工作，但 DSH 一旦调整属性顺序就会静默失效，届时自检会当场失败。

**中继上只有一个 HTTP 端口，这是 Cookie 的要求而不只是收缩攻击面。** RFC 6265 第 8.5 节的结论是 Cookie 不提供端口隔离：同一台主机上另一个端口上的服务既读得到也写得到同一个 Cookie。DSH 的 Cookie 名只由权威的 host 决定，所以中继上多开一个能吃 Cookie 的端口就等于多一条绕开第三层的路。因此"权威只以 HTTPS 提供服务"加上"中继上不存在第二个 HTTP 服务端口"是同一件事的两半，插件在这两条上都不提供配置项。这条要求由插件与操作者共同兑现：apt 装出的发行版默认 Caddyfile 末尾有一个 `:80` 静态站点，插件按约不碰托管块之外的内容，[modules/relay-host.md](modules/relay-host.md) 第 3 节给出了删掉它并重载 Caddy 的步骤，引导第 13 步的"中继对外监听"列表是发现它的方式。

IP 字面量权威无法使用 HSTS（RFC 6797 明确排除 IP 字面量），所以无域名方案里没有"靠浏览器强制升级"这条退路。

## 证书与 CA

中继用 Caddy 内置的本地 CA（`pki` 里的 `dsh-relay`）为 IP 权威签发证书。根证书有效期 10 年，中间证书与叶子证书都要显式设置：Caddy 的中间证书默认只有 7 天，而**叶子的有效期会被中间证书的上限截断**，所以只覆盖叶子没有用——两者一起设成 365 天与 90 天，"接受一次就不再弹"才成立。Caddy 自己负责续签，不需要 cron。

**这是这条通路上唯一需要你拍板的选项。** 用户有两条路：

- **安装 CA 根证书**（推荐）。根证书只有公钥，可以公开分发。它不经过公网 HTTP 面：引导第 10 步把它取到 `$DSH_HOME/dsh-web-relay/ca/root.crt`，也可在设置页状态区点「下载根证书」存成本地文件（那份 PEM 存在运行记录的 `caPem` 里；读它要先过网关口令与 DSH 认证，而这个标签页只在 loopback 页面上注册），再经本地复制、AirDrop、聊天软件等不依赖 TLS 信任的渠道送到设备；设置页与记录里的 `caFingerprint` 是核对它的 SHA256 指纹，可与 VPS 上 `data/pki/authorities/dsh-relay/root.crt` 逐字核对。iOS 上要先装描述文件，再到 设置 ▸ 通用 ▸ 关于本机 ▸ 证书信任设置 里手动开启完全信任。
- **不安装**，每次访问手动点过浏览器的证书警告。这时 TLS 仍然加密流量，但**没有身份验证**：你无法察觉中间人，攻击者只要能劫持到中继 IP 的流量就能读走 Cookie 与口令。这是明确要接受的风险，不是"等价但更省事"的选项。

装好 CA 之前，中间人风险与"完全明文"的差别只在于被动旁听需要主动介入连接；把这一条写在这里，是为了让"不装 CA"是一个被看见的决定。

## 网关口令与会话 Cookie

第二层由 Caddy 的 `basic_auth`（bcrypt）与它下发的一个静态会话 Cookie 共同构成。网关会话 Cookie 的有效期是 12 小时，这就是"每次进入输一次口令"的节奏：有效期内浏览器不再询问，过期后重新询问。这里有一条**必须成立的不变量**：会话 Cookie 只在认证成功之后下发，未认证请求绝不能拿到它。

原因是 Cookie 的值是一个静态秘密，持有它就直接通过 `@session` 匹配。而 Caddyfile 里的指令执行顺序由 Caddy 自己的指令表决定，不由书写顺序决定——`header` 在默认顺序里排在 `basic_auth` 之前，所以直接写

```caddyfile
handle {
	basic_auth { ... }
	header Set-Cookie "..."
	...
}
```

会让**未认证的 401 响应也带上 `Set-Cookie`**，任何人在浏览器地址栏敲一次域名就能领到会话密钥，然后凭这个 Cookie 绕开口令。实测确认过：401 响应上出现 `set-cookie: relay_session=…`，用该 Cookie 直接请求即得到 200。

站点块因此把这一段放进 `route`：`route` 按书写顺序执行，`basic_auth` 拒绝时短路，后面的 `header` 不会执行，401 上没有 `Set-Cookie`。这是站点模板里唯一必须用 `route` 的地方，改动那一块时要连带重跑"未认证请求不返回 `Set-Cookie`"这条自检。

账号名固定为 `me`，但**口令弹窗不会提示它**：`basic_auth` 的 realm 字段在 Safari 与 Chrome 上都不显示，因为服务器控制的一段文字不该出现在受信任的浏览器 UI 里——这正是浏览器为防钓鱼拿掉它的理由。所以这个固定的公开名字既不是秘密也不带来任何安全收益，它只是必须由人记住的一次性输入，插件只在设置页「公网入口」一节与 README 里以文本提示它，不去改动浏览器弹窗。口令才是秘密：它不进 realm，也不落中继磁盘，落盘的只有 bcrypt 哈希。

## 中继侧的最小权限

隧道本身用的不是管理账号。引导在中继上创建一个专用账号 `relay`：无有效 shell（`/usr/sbin/nologin`），`authorized_keys` 上的公钥带 `restrict,port-forwarding,permitlisten="127.0.0.1:18080"`，`sshd` 里再加 `Match User relay` 段落收紧到 `AllowTcpForwarding remote` 与 `PermitOpen none`。

结果：即使内网主机的私钥泄漏，持有者也只能在中继的 loopback 上开一个 `18080` 监听，不能执行命令、不能连别的端口、不能把端点绑到公网接口（`GatewayPorts no`）。

**转发前预检是这条最小权限之外的一个例外，要如实记下来。** 它用管理账号连中继，端口探测与清掉持有者都经 `sudo -n` 执行——也就是说，内网主机这一侧除了那把只能开转发的钥匙之外，还持有一份能对中继执行提权命令的能力，动机是清掉上一轮异常中断留下的监听端点，见 [modules/tunnel.md](modules/tunnel.md)。

这个例外不扩大"内网主机被入侵"的后果：中继上的免密 `sudo` 本来就是靠 `vps.identityFile` 指向的那把私钥取得的，而私钥存在内网主机上，被入侵的主机早就能以管理身份对中继做任何事。预检改变的是这把钥匙被**自动、反复地使用**，因此它自己必须足够窄：只杀 `/proc/<pid>/exe` 是 `sshd` 或 `sshd-session`、且属主是 `relay` 的进程，其余一律停手并如实记下。这道核对限制的是**插件自己的 bug 与误判**，不是攻击者——攻击者不需要经过它。

## 明文与 Host 透传

Caddy 到 DSH 这一段是 loopback 上的明文 HTTP，Host 原样透传。**绝不 `header_up Host`**：围栏唯一信任的信号是"Host 由浏览器真实给出"。把它改写成 `127.0.0.1:18080` 会让围栏恒真，等于拆掉第四层，然后必须在代理侧把这道门重新实现一遍。

## 凭据落盘位置

| 材料 | 位置 | 权限 |
| --- | --- | --- |
| 用户的部署参数（含 `gateway.password`） | profile 的 `cordis.patch.yml` | 文件 `0600`；管理登录走密钥，插件不存管理口令。该文件不在 git 仓库里 |
| 插件运行记录（含 `gateway.sessionSecret`） | `$DSH_HOME/dsh-web-relay/record.json` | 文件 `0600`，目录 `0700`。`sessionSecret` 不经过记录接口出去：`recordView()` 的白名单把 `gateway` 整节挡下 |
| 本机专用中继私钥 | `$DSH_HOME/dsh-web-relay/ssh/relay_ed25519` | `0600`，父目录 `0700` |
| 中继主机公钥记录 | `$DSH_HOME/dsh-web-relay/ssh/known_hosts` | `0600`，只含中继一条 |
| 中继 CA 根证书副本 | `$DSH_HOME/dsh-web-relay/ca/root.crt` | `0644`（公开信息） |
| DSH 会话签名密钥 | `$DSH_HOME/.credentials.yaml` 的 `client-connection/browser-session` | 由 DSH 管理 |

中继上的对应物：`/etc/dsh-web-relay/authorized_keys` 的托管块、`/etc/ssh/sshd_config.d/60-dsh-web-relay.conf`、`/etc/caddy/Caddyfile` 的托管块、`/var/lib/caddy/.local/share/caddy/pki/authorities/dsh-relay/root.crt`。网关口令的明文在引导结束后不存在于中继磁盘上，只有 bcrypt 哈希进 Caddyfile。

## 吊销

| 目标 | 动作 | 影响 |
| --- | --- | --- |
| 换掉网关口令 | 在设置页重新填 `gateway.password` 并部署 | 口令重新哈希，同时重置 `gateway.sessionSecret`，所有设备下次进入重新输口令 |
| 作废全部 DSH 会话 | 删除 `$DSH_HOME/.credentials.yaml` 里的 `client-connection/browser-session` 记录并重启 profile | 全部旧 Cookie 校验失败，所有设备下次打开裸地址时由中继自动带回换票点 |
| 收回隧道权限 | 从 `/etc/dsh-web-relay/authorized_keys` 删掉那一行并 `systemctl reload ssh` | 中继不再接受该反向转发 |

重启 profile **不会**吊销 Cookie：签名密钥是复用的持久化凭据，重启后旧 Cookie 继续有效。重启也不会让公网入口重新可用——隧道只在一次部署（人工点击或随启动自动部署）里建立，开关关着或上次部署失败时，重启之后公网入口返回中继那行"隧道未连接"。

Cookie 名是 `dsh-auth-` 拼接 `base64url(sha256(authority))`，所以换 `publicAuthority` 也会让旧 Cookie 立刻失效——这是一条设计内的副作用，变更权威时要预期到。

## 远程页面的功能边界

DSH 的客户端在非 loopback 页面上把设置持久化降级为内存（`persistence = isLoopback ? 'host' : 'memory'`），一批功能因此在手机上不可用。

| 类别 | 远程是否可用 | 说明 |
| --- | --- | --- |
| 模型选择器 / 模型设置 | 不可用 | 依赖设置持久化 |
| 通用设置的文档导入/导出/重置 | 不可用 | 同上 |
| 权限的**默认**预设行 | 不可用 | 只是"对未来会话的默认值" |
| 欢迎页确认 | 不可用 | 一次性状态 |
| **本插件的设置页** | 不可用 | 非 loopback 页面读不到插件的设置命名空间，这个标签页因此根本不注册；首次配置与每次部署只能在服务器本机做 |
| 新建/切换工作区、新建会话、对话、文件上传 | 可用 | 会话面不受影响 |
| 全部 `/api` RPC、两个 WebSocket | 可用 | |
| `/permission` 切换当前会话的权限预设 | 可用 | 走会话投影 + `/permission <preset>` 命令 |

插件不能把这条限制改掉，只能把它变成流程的一部分：首次配置必须在本机 loopback 页面完成，改配置同理。列出"必须本地完成的操作"的地方是 [modules/operations.md](modules/operations.md)。

## 已知限制

**目录选择器在远程会选到原生后端。** `directory-picker-auto` 的判定在 `bindHost !== '127.0.0.1'` 或 `facts.ssh` 成立时选 `browse`，否则可能选 `native`。本设计保持 loopback 绑定，因此远程请求目录选择时，原生选择器会在服务器那块屏幕上弹出。这是部署选择，插件不改这一行；要消掉它在部署时用 `directory-picker-browse` 覆盖 `directory-picker` 行。**插件不做检测**：启动自检只判权威，`src/` 里没有 `webServer.host` 或目录选择器那一路由的任何读取。

**隧道断开对攻击者无信息。** 浏览器看到 Caddy 的 502 与一段"隧道未连接"的文案。内网侧的 harness 日志与 `status()` 记录连接次数与最近错误，见 [modules/operations.md](modules/operations.md)。

**无域名带来三项代价**：客户端要信任私建 CA、无法使用 HSTS、不能监听 80/443（未备案域名会被大陆云厂商拦截）。有了备案域名之后切到 ACME 自动证书，三项一起消失。

**`dsh web` 的绑定校验不绕过。** DSH 的启动校验拒绝 `--host 0.0.0.0`；插件从不尝试放宽它。

## 必须成立的前置条件

部署完成后下面每一条都要成立；任何一条不成立，安全性就低于本设计的假设。

1. 中继上只跑 `sshd` 与 Caddy，没有第三个对外服务，也没有第二个 HTTP 端口（`ss -ltnp` 逐个核对；发行版默认 Caddyfile 的 `:80` 站点要按 [modules/relay-host.md](modules/relay-host.md) 第 3 节删掉）。
2. 中继的安全组只开放 `gateway.port`（以及你自己管理用的 SSH 来源）。
3. TLS 证书被客户端真实校验，而不是"永久忽略证书错误"。
4. 认证成功响应里的每一条 `set-cookie` 都带 `Secure`，认证失败的响应里没有 `set-cookie`。
5. `authorized_keys` 上用于隧道的公钥带 `restrict,port-forwarding,permitlisten`，端口与 `tunnel.relayPort` 一致。
6. `sshd` 的 `GatewayPorts` 为 `no`，转发端点不绑到公网接口。
7. `publicAuthority`、Caddy 站点地址、DSH 围栏的受信项三者一致。
8. 中继侧访问日志不记录查询串里的任何秘密（模板已把 `key` 与 `token` 两个字段替换成 `REDACTED`）。
9. 用户已经决定是否安装 CA 根证书，并知道不装时没有身份验证。
10. 中继上 `ss`（iproute2）可用，且管理账号能免密 sudo（或本身就是 `root`）。缺任一项时转发前预检会跳过，端口残留退回人工清理，见 [modules/operations.md](modules/operations.md)。
