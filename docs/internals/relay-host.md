# 实现：中继主机的目标状态

中继主机上跑两个东西：系统自带的 `sshd` 与 Caddy。**不安装本项目的任何代码。**

这一篇描述插件在中继上写下的每一处内容、它的形状与理由。写入过程见 [bootstrap.md](bootstrap.md)；出问题时的手工步骤见 [排障与维护](../troubleshooting.md)。

## 1. 插件在中继上留下的东西

| 位置 | 形态 | 模板 |
| --- | --- | --- |
| 账号 `relay` | `useradd --create-home --shell /usr/sbin/nologin relay` | — |
| `/home/relay/.ssh/authorized_keys` | 带标记的托管块，一行公钥 | `deploy/authorized_keys.snippet` |
| `/etc/ssh/sshd_config.d/60-dsh-web-relay.conf` | 带标记的托管块（无该目录时写主配置的托管块） | `deploy/sshd_config.snippet` |
| `/etc/caddy/Caddyfile` | 带标记的托管块：一份具名上游片段 + 权威站点 + Host 不匹配的兜底站点 | `deploy/Caddyfile.snippet` |
| `/etc/fail2ban/{filter.d,jail.d}/caddy-dsh-relay.conf` | 网关口令的爆破防护，参数由模板填入 | `deploy/fail2ban/` |
| CA 私钥与根证书 | Caddy 自己在 `/var/lib/caddy/.local/share/caddy/pki/authorities/dsh-relay/` 下生成 | — |

块外内容原样保留。**没有** systemd 单元、**没有**插件代码、**没有**证书生成脚本、**没有**额外的对外服务。CA 与证书全部交给 Caddy 内置签发者，所以中继上不需要 `openssl`，也不需要两处同步证书文件。

除了这些写入，插件还会在运行期连进来做一次转发前预检（见 [tunnel.md](tunnel.md)）。它不新增文件、账号或服务，但要求中继上有 `ss`（iproute2）且管理账号能免密提权。

`deploy/fail2ban/jail.d/jail-sshd.local` **不由引导安装**：它的 `ignoreip` 依赖用户才知道的内网出口地址，写错会把隧道一起封掉。它作为模板提供，需要时手工装。

## 2. SSH 侧

### 账号

用独立账号而不是 `root` 或管理账号：`authorized_keys` 的限制作用于**那把钥匙**，专用账号让"隧道这把钥匙能做什么"与"管理钥匙能做什么"彻底分开。`--shell /usr/sbin/nologin` 加上片段里的 `ForceCommand /usr/sbin/nologin` 让这个账号根本执行不了命令。

### `sshd_config` 片段

```sshdconfig
# BEGIN dsh-web-relay
Match User relay
    AllowTcpForwarding remote
    PermitOpen none
    GatewayPorts no
    X11Forwarding no
    AllowAgentForwarding no
    PermitTunnel no
    PermitTTY no
    ForceCommand /usr/sbin/nologin
    ClientAliveInterval 15
    ClientAliveCountMax 3
# END dsh-web-relay
```

- `AllowTcpForwarding remote` 是关键：只允许 `-R`，`-L` 与 `-D` 在这个账号上被拒绝。这把钥匙因此无法拿中继当跳板去连别的主机。
- `PermitOpen none` 与上一行一起，把"能开的东西"收窄到只有一条反向转发。
- `GatewayPorts no` 是 OpenSSH 的默认值，显式写出来作为约束：即使 `permitlisten` 允许通配绑定，转发端点也不会绑到公网接口。
- `ClientAliveInterval 15` 与 `ClientAliveCountMax 3`：主机侧异常消失（断电、休眠、切网）不会发 FIN，中继察觉不到对端已走，`-R` 的监听端点会一直留在那里。这两行让 sshd 在约 45 秒内丢掉这种会话。
- `UnusedConnectionTimeout` **保持不设**。它是全局选项，不能写进 `Match` 块；而空闲的隧道连接在很长时间里没有任何打开的 channel，设了它会把这条件正常工作的隧道拆掉。引导只读取它的生效值并报告。
- 片段**只放 `Match User relay` 段落**，不写 `PasswordAuthentication no` 这类全局项。全局认证策略属于主机管理员的判断，插件改它就有把管理员锁在门外的风险；而 `Match User relay` 加上一行 `restrict` 的 `authorized_keys`，已经让这个账号在协议层面不可能用口令登录。

### `authorized_keys`

```text
# BEGIN dsh-web-relay
restrict,port-forwarding,permitlisten="127.0.0.1:18080" ssh-ed25519 AAAA... dsh-web-relay
# END dsh-web-relay
```

- `restrict` 一次关掉 pty、exec、agent 转发、X11 与全部端口转发。
- `port-forwarding` 把端口转发能力还回来（实际只有 `-R` 可用，因为 `sshd_config` 里限定了 `remote`）。
- `permitlisten="127.0.0.1:18080"` 把这把钥匙能监听的远端地址锁死为一个。这是整份配置里最有价值的一条限制：即便私钥泄漏，持钥者也只能在中继的 loopback 上开这一个端口。

端口必须与包内 `tunnel.relayPort` 和 Caddy 上游地址一致。三处不一致时表现为隧道"连上了但转发失败"。

### 手工验证

```
# 内网主机
ssh -N -R 127.0.0.1:18080:127.0.0.1:<dshPort> \
    -i "$DSH_HOME/dsh-web-relay/ssh/relay_ed25519" \
    -o IdentitiesOnly=yes -o BatchMode=yes \
    -o StrictHostKeyChecking=yes \
    -o UserKnownHostsFile="$DSH_HOME/dsh-web-relay/ssh/known_hosts" \
    relay@<中继地址>

# 另一个终端（中继主机）
ss -ltnp | grep 18080        # 必须是 127.0.0.1:18080，不是 0.0.0.0:18080
```

第二条是必查项：看到 `0.0.0.0` 说明配置没生效，此时隧道端点直接暴露在公网且**没有 TLS**。要看属主还得有 root，不带 `sudo` 时 `users:(...)` 整列不会出现。

## 3. Caddy 侧

版本要求：Caddy ≥ 2.9（`basic_auth` 指令名；更早版本用 `basicauth`）。上游是明文 HTTP 时，Caddy 默认**原样透传包括 `Host` 在内的请求头**，只额外设置 `X-Forwarded-*`；"自动把 Host 改成上游地址"的行为只发生在 HTTPS 上游。

### 两段式认证

浏览器在 WebSocket 握手时是否携带 HTTP Basic 凭据并非规范强制，而 DSH 的界面依赖一个 WebSocket。因此站点块在口令校验之后另行下发一个会话 Cookie，并把后续请求的判据改成"有会话 Cookie 或再次通过 Basic"：

```caddyfile
	@session header Cookie *relay_session=<会话密钥>*
	handle @session {
		import dsh-relay-upstream
	}

	handle {
		route {
			basic_auth {
				me <bcrypt 哈希>
			}
			header Set-Cookie "relay_session=<会话密钥>; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200"
			import dsh-relay-upstream
		}
	}
```

- **`route` 是必需的，不是风格选择。** Caddy 的指令执行顺序由内置指令表决定，而 `header` 在默认顺序里排在 `basic_auth` 之前。不套 `route` 时未认证的 401 响应也会带上 `Set-Cookie`，任何人访问一次域名就能领到会话密钥并凭它绕开口令。这是整份配置里最需要守住的一条。
- `header Cookie *relay_session=...*` 两侧的 `*` 是必要的：`Cookie` 是把多个 Cookie 拼在一起的单个头字段，不加 `*` 会按整串精确匹配，只要 DSH 自己的 Cookie 也在里面就匹配不上。
- **账号名固定为 `me`，而它在口令弹窗里没有展示位。** 账号名必填且参与校验，所以它当常量用而不是部署参数。曾用 realm 把它显示在弹窗里，但 Safari 与 Chrome 都已不再显示 realm——服务器可写的文字不该出现在受信任的浏览器 UI 里。它只用文本提示两处：设置页与文档。
- 会话 Cookie 有效期 `Max-Age=43200`（12 小时），这就是"每次进入输一次口令"的节奏。要改频率就改这一处。
- 用 `SameSite=Lax` 而不是 `Strict`：DSH 自己的 Cookie 已经是 `Strict`，网关 Cookie 只需要在顶层导航时带上。
- 这一层不替代 DSH 的 Cookie，只是让"握手必须携带凭据"不依赖浏览器行为。

### 站点块

```caddyfile
# BEGIN dsh-web-relay
{
	auto_https disable_redirects
	default_sni @@HOST@@
	pki {
		ca dsh-relay {
			name "DSH Web Relay"
			intermediate_lifetime 8760h
		}
	}
}

(dsh-relay-upstream) {
	@noDsh {
		method GET
		header Accept *text/html*
		not header Cookie *dsh-auth-*
	}
	rewrite @noDsh /relay/enter
	reverse_proxy 127.0.0.1:@@RELAY_PORT@@ {
		header_down Set-Cookie "$" "; Secure"
		@unauth status 401
		handle_response @unauth {
			@doc {
				method GET
				header Accept *text/html*
			}
			redir @doc /relay/enter 302
			copy_response
		}
		stream_timeout 24h
		stream_close_delay 5m
	}
}

:@@GATEWAY_PORT@@ {
	respond "dsh-web-relay: Host 与权威不匹配" 421
}

@@AUTHORITY@@ {
	tls {
		issuer internal {
			ca dsh-relay
			lifetime 2160h
		}
	}

	handle_errors {
		@down `{err.status_code} == 502`
		handle @down {
			respond "dsh-web-relay: 无法连接内网主机（隧道未连接，或内网 dsh web 未响应）" 502
		}
	}

	@session header Cookie *relay_session=@@SESSION_SECRET@@*
	handle @session {
		import dsh-relay-upstream
	}

	handle {
		route {
			basic_auth {
				@@GATEWAY_USER@@ @@BCRYPT_HASH@@
			}
			header Set-Cookie "relay_session=@@SESSION_SECRET@@; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200"
			import dsh-relay-upstream
		}
	}

	log {
		output file /var/log/caddy/dsh-relay-access.log {
			mode 0600
			roll_size 20MiB
			roll_keep 5
		}
		format filter {
			wrap json
			request>uri query {
				replace key REDACTED
				replace token REDACTED
			}
			request>headers>X-Forwarded-For delete
		}
	}
}
# END dsh-web-relay
```

要点逐条：

- **不写 `header_up Host`。** 这是本设计的核心约束：默认的透传行为正是我们需要的，DSH 必须看到真实的公网权威。改写成上游地址会让围栏恒真，等于拆掉第四层。
- **`default_sni` 写成权威里不带端口的主机名。** 客户端连接 IP 字面量时不发 SNI，没有这一项时 Caddy 在裸 IP 访问下挑不到证书。
- **全局选项块只能有一个。** `auto_https`、`default_sni` 与 `pki` 都是全局选项，用户已经有别的全局块时托管块必然冲突。引导因此在写入前检查，命中就停下并说明原因，而不是写出一份校验通不过的 Caddyfile。
- **`auto_https disable_redirects`**：站点地址是高位端口上的 IP 字面量，Caddy 的自动 HTTPS 会试图起一个 80 端口的跳转，与"不监听 80/443"冲突。只关掉跳转，不关 TLS。
- **`tls { issuer internal { ca dsh-relay } }`**：用 `pki` 里定义的本地签发者，与其他内网站点隔离。
- **`lifetime` 与 `intermediate_lifetime` 必须成对出现。** 叶子的有效期会被中间证书的上限截断：只写前者时叶子仍只有 Caddy 的中间证书默认有效期那么长。少了这一对，未安装 CA 的客户端每隔几天就要重新点一次证书警告。
- **不写 `trusted_proxies`。** 前面没有别的代理；配置它会引入 XFF 伪造面。
- **`request>uri query` 里两个字段都打码，作为兜底。** 入口不接受任何查询参数，当前没有任何秘密会走到这里；保留这两条替换是为了挡住将来有人把秘密重新放回查询串。Caddy 默认已把 `Cookie`、`Set-Cookie`、`Authorization` 记成 `REDACTED`，查询串不在默认范围内。
- **删除日志里的 `X-Forwarded-For`**：前面没有 CDN 时 `remote_ip` 就是真实客户端 IP，XFF 只是冗余，删掉它让 fail2ban 规则更简单。这只影响日志字段，`reverse_proxy` 仍然给上游写一个可信的 XFF。
- **日志轮转显式设小。** Caddy 的默认值是 100MiB × 10 个文件，对小磁盘的中继太大。
- **`handle_errors` + `{err.status_code} == 502`，不是 `handle_response`。** 上游连不上时 Caddy 合成的 502 不经过 `handle_response`，走的是 `handle_errors`。这段文本同时覆盖两种情形（隧道没连上、隧道通了但内网 `dsh web` 没响应），因此措辞不写死为"隧道未连接"。
- **`@noDsh` 改写把裸地址的首次访问带进换票点。** 没有 DSH 会话 Cookie 的文档导航在服务端被改写成换票路径，地址栏里因此始终只有裸权威。`rewrite` 不需要 `route` 包一层——内置指令顺序表里它排在 `reverse_proxy` 之前。`not header Cookie *dsh-auth-*` 让已经登录的请求不被改写，没有这条判据就会每次取界面都换一次票。
- **`@unauth` 恢复跳转处理"Cookie 在但已失效"。** 那种请求不会被改写，上游回 401；只有文档导航该被送回换票点，所以判据拆成两层：`handle_response` 自己的匹配器是**响应**匹配器（`status 401`），写在它里面的 `@doc` 是请求匹配器。其余 401（例如接口调用）走 `copy_response` 原样透传——漏了它时那些 401 会变成空响应。
- **尾部那个兜底站点是必要的。** 站点地址做主机匹配，Host 与权威不一致的请求不进入本站点；而 Caddy 对"监听地址上没有站点匹配"的请求返回 **200 空响应**——不是 403、不是 404，浏览器上是一片空白。这条空白页极难归因，因此显式给一个能读懂原因的答案。兜底站点不带 `log` 段，因此 421 请求不进访问日志。
- **`stream_timeout 24h`**：给长连接一个上限，避免陈旧连接永久占用；客户端会在被切断后自动重连。
- **上游写成一个具名片段，两个分支各 `import` 一次。** 两个分支必须给出完全相同的响应，重复一份 `reverse_proxy` 时最容易只改一处。`default_sni` 与兜底站点共用同一个网关端口。
- 写入后跑一次 `caddy fmt --overwrite`：不格式化时 `caddy validate` 每次都会打出格式警告，把真正的错误淹掉。

### Cookie 的 `Secure` 由中继补上

DSH 自己下发的浏览器 Cookie 是 `Max-Age; Path=/; Expires; HttpOnly; SameSite=Strict`，**没有 `Secure`**。插件不修改 DSH 源码，因此补这一位只能在中继上做。上游定义里的 `header_down Set-Cookie "$" "; Secure"` 把每个 `Set-Cookie` 的值整体匹配并在末尾追加：

- **匹配整个值而不是按 Cookie 名前缀定点匹配**，是为了与 DSH 的属性顺序无关。定点写法能过校验也确实工作，但它把正确性绑在"某个属性恰好是最后一个"上；一旦属性顺序变化，Cookie 会**静默地**失去 `Secure`——不报错、页面照常工作，只是保护没了。这是唯一不能接受的失败模式。
- **这一行必须留在 `reverse_proxy` 内，不能换成站点级 `header`。** 站点级 `header` 不延迟执行时对代理响应完全不生效；延迟执行时它面对的是最终头集合，会把 Caddy 自己写的会话 Cookie 也一起改写，于是又需要一层锚定、又回到顺序依赖。`header_down` 只看上游那一份响应，Caddy 自己写的 Cookie 不在其中。
- Cookie 的值里不能出现 `;`（RFC 6265 第 4.1.1 节），所以追加上的 `; Secure` 不可能被并进值里。

两个分支共用同一份上游定义，就是为了让这条改写只有一处。

### 只有一个 HTTP 入口

中继上对外只有网关端口一个 HTTP 服务端口（另有管理用的 `sshd`，它不解析 Cookie）。除了缩小攻击面，这里还有一条 Cookie 层面的理由：Cookie 不按端口隔离（RFC 6265 第 8.5 节），同一台主机另一个端口上的服务既读得到也写得到同一个 Cookie。DSH 的 Cookie 名只由权威的 host 决定、不带端口信息，所以中继上只要多开一个能吃 Cookie 的服务端口，它就可能拿到一个能通过 DSH 校验的会话 Cookie。封掉这条路只能靠"不存在第二个端口"，这一条不设配置项。

因此不写 `http://` 站点块，不做 80 到网关端口的跳转，也不为任何别的用途新增监听。IP 字面量下 HSTS 不可用（RFC 6797 排除 IP 字面量），明文入口没有浏览器侧的兜底。

Caddy 主机上还可能有一份**不是插件写入**的明文站点：apt 包安装时会写出发行版自带的 Caddyfile，它底部是一个 `:80` 站点。插件把托管块放在文件顶部，并刻意保持块外内容原样，所以那个站点会继续存在。要收掉这个面，由操作者删掉那段 `:80` 块再 reload。第 13 步记录里的"中继对外监听"是发现它的方式。

## 4. 网络与防火墙

| 位置 | 规则 | 理由 |
| --- | --- | --- |
| 云安全组 | 入站放行网关端口 | 唯一公网入口 |
| 云安全组 | 入站 `tcp/22` 只对管理来源与内网主机的公网出口 | 管理面不应全网开放 |
| 云安全组 | 其余入站全部拒绝 | |
| 主机防火墙 | 允许网关端口与 22；拒绝其余 | 防安全组之外的路径 |
| `sshd` | 不监听额外端口 | 只用 22 |
| Caddy | 只监听网关端口 | 不做跳转；发行版自带的 `:80` 站点由操作者删除 |

**不要开放转发端口。** 它只应在 loopback 上，由 `sshd` 绑定、由 Caddy 连接。

**对外只应有一个 HTTP 端口。** `ss -ltnp` 里除网关端口与 `sshd` 之外的任何监听都要问清来路。

中继所在的云厂商安全组与主机防火墙都是**中继管理员**的职责，插件不改：改防火墙有把管理连接一起关掉的现实风险。

## 5. 防爆破

两个入口分开处理：SSH（管理面与隧道）与 Caddy（网关口令）。

### SSH 侧

隧道用公钥认证，受限账号的 `authorized_keys` 带 `restrict`，**口令爆破在协议层面不可能成功**——没有口令可猜。剩下的真实目标是：全网扫描造成的日志与连接噪声、利用 sshd 自身漏洞的连接洪泛、以及"把自己封掉"。

- **第 0 层：让 22 不可达。** 云安全组把入站 `tcp/22` 收到管理来源与内网主机的公网出口 IP。隧道是内网主机主动外连的，所以白名单里必须有它的出口地址；动态 IP 或 CGNAT 下这条用不了。
- **第 1 层：只认公钥。** 即 `Match User relay` 与 `restrict` 前缀。这一层决定爆破能否成功，其余各层只决定噪声大小。
- **第 2 层：sshd 自带的来源惩罚（OpenSSH ≥ 9.8）。** `PerSourcePenalties` 自 9.8 起默认开启。这里有一条与插件直接相关的相互作用：连续几次认证失败就会触发拒绝，而插件的重连退避从 1 秒开始。公钥配置错误会让内网主机在十几秒内把自家出口 IP 送进惩罚名单，最长 10 分钟连不上，现象是"隧道连不上，手动 `ssh` 也连不上"。这是需要人工介入的故障，加大重试解决不了；出口 IP 固定时可用 `PerSourcePenaltyExemptList` 排除它。
- **第 3 层：fail2ban 的 sshd jail（可选）。** 目标发行版没有内置惩罚时才需要补充。模板在 `deploy/fail2ban/jail.d/jail-sshd.local`，`ignoreip` 由使用者自己填：插件不安装这个 jail，也不猜地址。
- **第 4 层：收窄 sshd 自身的暴露面。** 限制未认证并发与登录宽限时间、降低最大认证尝试次数。换非标准端口能挡掉绝大多数全网扫描，但那属于降噪而不是安全措施。
- **第 5 层：保持 openssh 有安全更新。** 连接洪泛不只是噪声问题，历史上出现过需要长时间持续连接才能利用的 sshd 漏洞，限制连接频率直接压缩了这类攻击的可行性。

### Caddy 侧

口令校验用 bcrypt，单次尝试成本已很高，但没有内置锁定。用系统自带的 fail2ban 读 Caddy 的 JSON 访问日志，`deploy/fail2ban/` 下两个文件：

```ini
# filter.d/caddy-dsh-relay.conf
[Definition]
failregex = ^.*"logger":"http\.log".*"remote_ip":"<HOST>".*"status":401.*"Www-Authenticate".*$
ignoreregex =
```

```ini
# jail.d/caddy-dsh-relay.conf
[DEFAULTS]
bantime.increment = true

[caddy-dsh-relay]
enabled  = true
port     = <网关端口>
filter   = caddy-dsh-relay
logpath  = /var/log/caddy/dsh-relay-access.log
ignoreip = 127.0.0.1/8 <内网主机的公网出口 IP>
maxretry = 5
findtime = 600
bantime  = 3600
```

- 日志是 JSON 单行，`failregex` 按行匹配即可；`remote_ip` 与 `status` 在同一条行里，因此"取地址 + 判状态"可以写成一条正则。
- `port` 由引导按网关端口替换；`logpath` 与 Caddyfile 的 `output file` 出自同一份模板，两者必须一致。
- `ignoreip` 里的出口地址由引导自动填，不需要手工维护：探测脚本在**提权之前**读一次 `SSH_CONNECTION`，写 jail 时填进去。取不到就是空串，jail 退回默认封禁规则。这一条是必须的：部署的公网自检会发出不带口令的请求，被记成一次口令失败，而开启随启动自动部署时每次重启都会跑一遍，反复重启就可能把操作者自己封掉。
- `bantime.increment` 值得开启：攻击者会被指数推开。代价是操作者自己也可能触发它——反复发出不带口令的诊断请求会把操作者自己的出口 IP 封掉，症状是公网端口直接 `Connection refused`，而中继上 Caddy 仍在监听、隧道也活着。
- 规则只统计口令失败：Caddy 拒绝请求时返回 401 并带上 `Www-Authenticate`。DSH 在浏览器还没有会话 Cookie 时也回 401，但那条日志行带非空的 `user_id` 且没有 `Www-Authenticate`——首访时这是正常现象，把它计入会在正常使用中把操作者自己封掉。
- Caddy 侧的 jail 由引导安装，因为它的 `logpath` 与 `port` 与 Caddyfile 出自同一份模板；sshd 侧的 jail 不自动安装。
- fail2ban 的封禁动作默认走 iptables；中继上只有 `nft` 而没有 iptables 兼容层时，要在 `[DEFAULTS]` 里把 `banaction` 换成 `nftables-multiport`，否则 jail 会启动但一条规则都装不上。

## 6. 明确禁止

1. **不写 `header_up Host` / `header_up Origin`。**
2. **不提供明文入口，也不新增第二个 HTTP 端口。**
3. **不把转发端口暴露到公网。** 它是明文 HTTP。
4. **不关闭 `StrictHostKeyChecking`。** 需要换主机密钥时更新 `known_hosts` 并记录指纹。
5. **不在中继上放 DSH 凭据。** 中继只需要 SSH 公钥、TLS 私钥/证书、Caddyfile。
6. **不配置 `trusted_proxies`。**
7. **不把 CA 私钥复制出来。** 根证书只有公钥，可以公开分发；私钥留在 Caddy 的数据目录里。
8. **不让插件改防火墙与全局 sshd 认证策略。** 这两处的错误会把管理员锁在门外。
9. **不让转发前预检做第二件事。** 它只查转发端口、只杀属主为 `relay`、可执行文件是 sshd 的进程。这是整份设计里唯一一处运行期提权，面越窄越好。

## 7. 部署后自检清单

引导结束时这些都应成立；手工部署或排障时照抄。`<权威>` 是 `地址:网关端口`，`<ca>` 是取回的根证书路径：

```
# 中继主机
ss -ltnp | grep -E '18080|<网关端口>'   # 转发端口必须是 127.0.0.1
ss -ltnp                                # 对外只应有网关端口与 sshd；出现 :80 说明发行版自带的站点还没删
sshd -T -C user=relay,host=relay,addr=127.0.0.1 | grep -iE 'gatewayports|permitopen|allowtcpforwarding|permittty|clientaliveinterval|clientalivecountmax|unusedconnectiontimeout'

# 未认证且不是文档导航：期望 401，且响应里没有 set-cookie
curl -sS --cacert <ca> -D- -o /dev/null https://<权威>/ | grep -iE '^HTTP|^set-cookie'

# 首访：裸地址 + 文档导航的 Accept，未带任何 Cookie
# 期望 200、换票标记头、**没有 location**，两条 Cookie 都带 Secure
curl -sS --cacert <ca> -u me:<口令> -c <jar> -b <jar> -H 'Accept: text/html' -D- -o /dev/null https://<权威>/ | grep -iE '^HTTP|^location|^set-cookie|x-dsh-web-relay-handshake'

# 带着刚拿到的 Cookie 再取一次（浏览器过渡页的那一步）：期望 200 界面
curl -sS --cacert <ca> -u me:<口令> -c <jar> -b <jar> -H 'Accept: text/html' https://<权威>/ | grep -c __DSH_BOOT__

# 失效 Cookie 的恢复路径：改坏会话 Cookie 的值后跟跳转，期望两跳后 200
curl -sS --cacert <ca> -u me:<口令> -c <jar> -b <jar> -L -H 'Accept: text/html' https://<权威>/

# 隧道未连接：期望 502 且带可读提示，不是空响应
curl -sS --cacert <ca> -u me:<口令> https://<权威>/

# 明文端口不可用
curl -sS -o /dev/null -w '%{http_code}\n' --max-time 3 http://<权威>/
```

四条必查项：

1. **未认证请求不得带 `set-cookie`。** 带上就说明口令校验没有被短路保护，任何人都能领到会话密钥并绕开口令。这是整份清单里最容易在改动中被破坏、又最不显眼的一条。
2. **首访必须被带到换票点，而且那一跳必须是 200。** 拿到 401 说明中继上的 Caddyfile 还是旧版（没有带路改写）；拿到 3xx 说明中继上跑的是更早的插件版本，那一版在 Safari 上会无限跳转。
3. **认证成功后必须带网关会话 Cookie。** 缺它时 WebSocket 握手会失败，而普通请求看起来一切正常。
4. **认证成功后每条 `set-cookie` 都要带 `Secure`**，包括 DSH 自己那条。缺它就说明补 `Secure` 的那一步掉了或落到了别处。

再核对一次证书链与有效期，确认叶子证书的有效期不是被中间证书截断后的短值：

```
openssl s_client -connect <权威> </dev/null 2>/dev/null | openssl x509 -noout -dates
openssl x509 -in /var/lib/caddy/.local/share/caddy/pki/authorities/dsh-relay/intermediate.crt -noout -dates
```

## 相关

- 写入过程：[bootstrap.md](bootstrap.md)
- 转发前预检的详细行为：[tunnel.md](tunnel.md)
- 这些约束的安全依据：[安全设计](../security.md)
