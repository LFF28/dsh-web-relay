# 模块：中继主机

职责：在中继主机上建立唯一的公网入口，并把流量交给隧道。中继上运行两个东西：系统自带的 `sshd` 与 Caddy。**不安装本项目的任何代码。**

本文件描述中继的**目标状态**：插件在中继上写下的每一处内容、它的形状与理由。写入过程见 [bootstrap.md](bootstrap.md)，出问题时的手工步骤见 [operations.md](operations.md)。

## 1. 插件在中继上留下的东西

| 位置 | 形态 | 模板 |
| --- | --- | --- |
| 账号 `relay` | `useradd --create-home --shell /usr/sbin/nologin relay` | — |
| `/home/relay/.ssh/authorized_keys` | 带标记的托管块，一行公钥 | `deploy/authorized_keys.snippet` |
| `/etc/ssh/sshd_config.d/60-dsh-web-relay.conf` | 带标记的托管块（无该目录时写主配置的托管块） | `deploy/sshd_config.snippet` |
| `/etc/caddy/Caddyfile` | 带标记的托管块，一份具名上游片段（`dsh-relay-upstream`）加两个站点（权威站点 + Host 不匹配的兜底） | `deploy/Caddyfile.snippet` |
| `/etc/fail2ban/jail.d/caddy-dsh-relay.conf` + `/etc/fail2ban/filter.d/caddy-dsh-relay.conf` | 8443 网关的爆破防护，参数由模板填入 | `deploy/fail2ban/` |
| CA 私钥与根证书 | Caddy 自己在 `/var/lib/caddy/.local/share/caddy/pki/authorities/dsh-relay/` 下生成 | — |

块外内容原样保留。插件只碰这五处，卸载后中继上不会剩别的：**没有** systemd 单元、**没有**插件代码、**没有**证书生成脚本、**没有**额外的对外服务。CA 与证书全部交给 Caddy 内置签发者（见第 3 节），所以中继上不需要 `openssl`，也不需要在两处同步证书文件。

除了这五处写入，插件还会在**运行期**连进来做一次转发前预检：用管理账号的 `sudo -n` 看 `tunnel.relayPort` 是否被占，被占且持有者是本部署残留的 `sshd` / `sshd-session` 进程时以 `sudo` 杀掉它，见 [tunnel.md](tunnel.md)。它不新增文件、账号或服务，但确实要求中继上有 `ss`（iproute2）、且管理账号能免密提权——这两条因此是部署的前置条件。

`deploy/fail2ban/` 里的 sshd jail **不由引导安装**（它的 `ignoreip` 依赖用户才知道的内网出口地址，写错会把隧道一起封掉）；它作为模板提供，需要时手工装，见第 5 节。

托管块由同一段脚本模板写入：`awk` 过滤旧块得到临时文件，用引号定界的 heredoc 追加新块，`install` 到目标路径，写回后立刻读回比对。每一处都可重复写入，因此重新部署没有游标。

## 2. SSH 侧

### 账号

用独立用户而不是 `root` 或管理账号：`authorized_keys` 的限制作用于**那把钥匙**，专用用户让"这把钥匙能做什么"与"我的管理钥匙"彻底分开。`--shell /usr/sbin/nologin` 加上片段里的 `ForceCommand /usr/sbin/nologin` 让这个账号根本执行不了命令：登录只会打印 `This account is currently not available.`。

### `sshd_config` 片段

`deploy/sshd_config.snippet`：

```sshdconfig
# dsh-web-relay — managed block; edits outside these markers are preserved.
# BEGIN dsh-web-relay
Match User relay
    AllowTcpForwarding remote
    PermitOpen none
    GatewayPorts no
    X11Forwarding no
    AllowAgentForwarding no
    PermitTunnel no
    PermitTTY no
    ClientAliveInterval 15
    ClientAliveCountMax 3
    ForceCommand /usr/sbin/nologin
# END dsh-web-relay
```

- `AllowTcpForwarding remote` 是关键：只允许 `-R`（远程转发），`-L` 与 `-D` 在这个用户上被拒绝。这把钥匙因此无法拿中继当跳板去连别的主机。
- `PermitOpen none` 与上一行一起，把"能开的东西"收窄到只有一条反向转发。
- `GatewayPorts no` 是 OpenSSH 的默认值，显式写出来作为约束：即使 `permitlisten` 允许通配绑定，转发端点也不会绑到公网接口。
- `ClientAliveInterval 15` 与 `ClientAliveCountMax 3`：主机侧异常消失（断电、休眠、切网）不会发 FIN，中继察觉不到对端已走，`-R` 的监听端点会一直留在那里。这两行让 sshd 在约 45 秒内丢掉这种会话，监听端点随之释放。
- `UnusedConnectionTimeout` **保持不设**。它是全局选项，不能写进 `Match` 块；而 `ssh -N -R` 的隧道连接在很长一段时间里没有任何打开的 channel，设了它会把这条件正常工作的空闲隧道拆掉。引导只读取它的生效值（`none`）并报告，不改动它。
- 这个片段**只放 `Match User relay` 段落**，不写 `PasswordAuthentication no` 这类全局项。全局认证策略属于主机管理员的判断，插件改它就有把管理员锁在门外的风险；而 `Match User relay` 加上一行 `restrict` 的 `authorized_keys`，已经让 `relay` 账号在协议层面不可能用口令登录。

校验顺序是硬的：先 `sshd -t`，通过才 `systemctl reload ssh`。`sshd -t` 不通过就不重载并回滚该文件——一台把自己锁在门外的中继比没配置好的中继糟得多。重载后再用 `sshd -T -C user=relay,host=relay,addr=127.0.0.1` 读生效值，确认 `gatewayports no`、`permitopen none`、`allowtcpforwarding remote`、`permittty no`、`clientaliveinterval 15`、`clientalivecountmax 3` 与 `unusedconnectiontimeout none` 都在。验证过的中继（Ubuntu 26.04，`OpenSSH_10.2p1 Ubuntu-2ubuntu3.2`）上读到的就是这一组。

### `authorized_keys`

`deploy/authorized_keys.snippet` 的块内容只有一行：

```text
# BEGIN dsh-web-relay
restrict,port-forwarding,permitlisten="127.0.0.1:18080" ssh-ed25519 AAAA... dsh-web-relay
# END dsh-web-relay
```

- `restrict` 一次关掉 pty、exec、agent 转发、X11 与全部端口转发。
- `port-forwarding` 把端口转发能力还回来（实际只有 `-R` 可用，因为 `sshd_config` 里限定了 `remote`）。
- `permitlisten="127.0.0.1:18080"` 把这把钥匙能监听的远端地址锁死为一个。这是整份配置里最有价值的一条限制：即便私钥泄漏，持钥者也只能在中继的 loopback 上开这一个端口，不能执行命令、不能连别的端口、不能绑到公网接口。

端口必须与插件包内 `tunnel.relayPort`（默认 `18080`）和 Caddy 上游地址一致。三处不一致时表现为隧道"连上了但转发失败"：客户端退出并打印 `remote port forwarding failed for listen port 18080`。

### 手工验证

```
# 内网主机
ssh -N -R 127.0.0.1:18080:127.0.0.1:3080 \
    -i "$DSH_HOME/dsh-web-relay/ssh/relay_ed25519" \
    -o IdentitiesOnly=yes -o BatchMode=yes \
    -o StrictHostKeyChecking=yes \
    -o UserKnownHostsFile="$DSH_HOME/dsh-web-relay/ssh/known_hosts" \
    relay@<vps.host>

# 另一个终端（中继主机）
ss -ltnp | grep 18080        # 必须是 127.0.0.1:18080，不是 0.0.0.0:18080
```

第二条是必查项：看到 `0.0.0.0` 说明配置没生效，此时隧道端点直接暴露在公网且**没有 TLS**。要看属主还得有 root：`sudo -n ss -ltnpH` 才给出 `users:(("sshd-session",pid=N,fd=12))`，不带 `sudo` 时 `users:(...)` 整列不会出现。

## 3. Caddy 侧

版本要求：Caddy ≥ 2.9（`basic_auth` 指令名；更早版本用 `basicauth`）；设计期在 loopback 上用 v2.10.0 验证过这份模板，部署的中继在 Ubuntu 26.04 上装到 2.11.4 并同样验证通过。上游是明文 HTTP 时，Caddy 默认**原样透传包括 `Host` 在内的请求头**，只额外设置 `X-Forwarded-*`；"自动把 Host 改成上游地址"的行为只发生在 HTTPS 上游。

### 两段式认证

`basic_auth` 有一个需要本设计处理的边界：浏览器在 WebSocket 握手时**是否携带 HTTP Basic 凭据**。凭据由浏览器缓存在会话内，普通请求上必然携带，但握手请求由浏览器自行发起，这不是规范强制的行为，而 DSH 的 Web 界面依赖 `/api/remote.mux` 这个 WebSocket。

因此站点块在 `basic_auth` 之后另行下发一个 `HttpOnly` 会话 Cookie，并把后续请求的判定改成"有会话 Cookie 或再次通过 Basic"：

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

- **`route` 是必需的，不是风格选择。** Caddy 的指令执行顺序由内置指令表决定，不由书写顺序决定，而 `header` 在默认顺序里排在 `basic_auth` 之前。不套 `route` 时未认证的 401 响应也会带上 `Set-Cookie`，任何人访问一次域名就能领到会话密钥并凭它绕开口令。实测确认过这条绕过路径存在，套上 `route` 后 401 上不再有 `Set-Cookie`。详见 [security.md](../security.md)。
- `header Cookie *relay_session=...*` 两侧的 `*` 是必要的：`Cookie` 是把多个 Cookie 拼在一起的单个头字段，不加 `*` 会按整串精确匹配，只要 DSH 自己的 Cookie 也在里面就匹配不上。实测：`Cookie: dsh-auth-…=…; relay_session=…; other=1` 能匹配。
- **账号名固定为 `me`，而它在口令弹窗里没有展示位。** `basic_auth` 的账号名必填且和口令一样参与校验（实测：口令正确、账号名不对仍是 401），所以它当常量用而不是部署参数：做成可配置只会多一个要记住、且没有任何区分度的字段。曾用 realm 把它显示在弹窗里，实测 Safari 的口令框只写主机名、不理会 realm——服务器可写的文字不该出现在受信任的浏览器 UI 里，Safari 与 Chrome 都因此不再显示它（[httpd 也据此修订了文档](https://bz.apache.org/bugzilla/show_bug.cgi?id=69326)）。所以这个名字不以任何形式进弹窗，只用文本提示两处：设置页「公网入口」一节的口令输入框下方，以及 [README](../README.md)。
- 会话密钥是一个静态随机串，等价于"把口令物化成一个 Cookie"。它存在记录的 `gateway.sessionSecret` 里，`gateway.password` 每次变化时一并重置，因此换口令会立刻作废所有网关会话。轮换路径见 [operations.md](operations.md)。
- 有效期是 `Max-Age=43200`（12 小时），这就是"每次进入输一次口令"的节奏：有效期内浏览器不再询问，过期后重新询问。要改频率就改这一处的 `Max-Age`，没有别的开关。
- 用 `SameSite=Lax` 而不是 `Strict`：DSH 自己的 Cookie 已经是 `Strict`，网关 Cookie 只需要在顶层导航时带上，`Lax` 足够且不会在从外部直接粘贴链接进入时缺失。
- 这一层不替代 DSH 的 Cookie，只是让"WS 握手必须携带凭据"不依赖浏览器行为。DSH 的权威绑定 Cookie 仍是第二道门。实测：HTTP/1.1 的升级请求带 Basic 凭据或带会话 Cookie 都得到 `101`，不带凭据得到 `401`。

`basic_auth` 的明文口令只在引导时存在：它经 stdin 交给 `caddy hash-password`，落进 Caddyfile 的只有 `$2a$14$…`。

### 站点块

`deploy/Caddyfile.snippet`。权威、端口、哈希与会话密钥是仅有的几个变量：

```caddyfile
# dsh-web-relay — managed block; keep other site blocks outside these markers.
# BEGIN dsh-web-relay
{
	auto_https disable_redirects
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

- **不写 `header_up Host`。** 这是本设计的核心约束，默认的透传行为正是我们需要的：DSH 看到真实的公网权威，权威绑定 Cookie 与 Host/Origin 围栏才有意义。站点块里出现 `header_up Host` 就是把设计改回了被否定的方案。实测：上游看到的是 `host: <authority>`，不是 `127.0.0.1:<relayPort>`。见 [security.md](../security.md)。
- **全局选项块只能有一个。** `auto_https disable_redirects` 与 `pki` 都是全局选项，Caddy 只允许一个全局选项块。用户在这台机器上已经有别的站点时，托管块里的全局块会与之冲突。引导因此在写入前检查 `auto_https` / `pki` 是否已被块外内容声明，命中就停下并说明原因，而不是写出一份 `caddy validate` 通不过的 Caddyfile。同样的检查也适用于 `:@@GATEWAY_PORT@@` 兜底站点：这台机器上已经有监听同一端口的站点时停下。具名片段 `(dsh-relay-upstream)` 的名字在整个 Caddyfile 里也必须唯一，写入前一并检查。
- **`auto_https disable_redirects`**：站点地址是高位端口上的 IP 字面量，Caddy 的自动 HTTPS 会试图起一个 80 端口的跳转，与"不监听 80/443"冲突。只关掉跳转，不关 TLS。
- **`tls { issuer internal { ca dsh-relay } }`**：用 `pki` 里定义的本地签发者，与其他内网站点隔离。根证书落在 `/var/lib/caddy/.local/share/caddy/pki/authorities/dsh-relay/root.crt`。
- **`lifetime` 与 `intermediate_lifetime` 必须成对出现。** 叶子的有效期会被中间证书的上限截断：只写 `lifetime 2160h` 时实测叶子仍只有 **7 天**（Caddy 2.10 的中间证书默认有效期），加上 `intermediate_lifetime 8760h` 之后叶子才真的是 90 天。不设这一对时，未安装 CA 的客户端每 7 天要重新点一次证书警告。
- **不写 `default_sni`。** 客户端连接 IP 字面量时不发 SNI，Caddy 按监听地址选站点；实测单站点场景下不发 SNI 也能正常握手并返回 200，多写一个 `default_sni` 只会引入一个需要与 `vps.host` 保持同步的冗余值。
- **`request>uri query` 里两个字段都打码，作为兜底。** 入口不接受任何查询参数，DSH 的启动令牌也只出现在插件到本机 loopback 的那一跳里，因此当前没有任何秘密会走到这里；保留这两条替换是为了挡住将来有人把秘密重新放回查询串。Caddy 默认把 `Cookie`、`Set-Cookie`、`Authorization` 记成 `REDACTED`，查询串不在默认范围内。实测：`/relay/enter?key=ABC&token=DEF` 记成 `key=REDACTED&token=REDACTED`。
- **删除日志里的 `X-Forwarded-For`**：前面没有 CDN 时 Caddy 的 `remote_ip` 就是真实客户端 IP，XFF 只是冗余；删掉它让 fail2ban 的规则更简单（只看 `remote_ip`）。注意这只影响**日志字段**，`reverse_proxy` 仍然给上游写一个可信的 XFF，入口路由读到的左端值仍是真实对端。实测：客户端伪造 `X-Forwarded-For: 9.9.9.9` 时上游看到的是 `127.0.0.1`。
- **日志轮转显式设小。** `/var/log/caddy/dsh-relay-access.log` 以 `mode 0600`、`roll_size 20MiB`、`roll_keep 5` 写入：Caddy 的默认值是 100MiB × 10 个文件，对小磁盘的中继太大。
- **`handle_errors` + `{err.status_code} == 502`，不是 `handle_response`。** 上游连不上时 Caddy 合成的 502 不经过 `handle_response`，走的是 `handle_errors`；写成 `handle_response @down status 502` 时实测返回的是 `content-length: 0` 的空 502。这段文本同时覆盖两种情形（隧道没连上、隧道通了但内网 `dsh web` 没响应），因此措辞不写死为"隧道未连接"。
- **`@noDsh` 改写把裸地址的首次访问带进换票点。** 没有 DSH 会话 Cookie 的文档导航（`Accept` 带 `text/html`）在服务端被改写成 `/relay/enter`，地址栏里因此始终只有裸权威。`rewrite` 不需要 `route` 包一层：内置指令顺序表里它排在 `reverse_proxy` 之前，`caddy adapt` 产出的处理器顺序就是 `rewrite`、`reverse_proxy`。`not header Cookie *dsh-auth-*` 让已经登录的请求不被改写——没有这条判据就会每次取界面都换一次票。`not` 写在字段名前而不是在值上写 `!`：Caddyfile 文档里 `!` 的用法是"字段不存在"，值上的取反没有文档。
- **`@unauth` 恢复跳转处理"Cookie 在但已失效"。** 那种请求不会被改写，上游回 `401`；只有文档导航该被送回换票点，所以判据拆成两层：`handle_response` 自己的匹配器是**响应**匹配器（`status 401`），写在它里面的 `@doc` 是请求匹配器（`GET` + `Accept: text/html`）。其余 `401`（例如 `/api`）走 `copy_response` 原样透传。实测：失效 Cookie + `Accept: text/html` 得到 `302`/`location: /relay/enter`，跟完两跳回到 `200`；`/api/` + `Accept: application/json` 得到 `401` 与 DSH 原文 `unauthorized`。
- **`copy_response` 是那个不透传之外的出口。** `handle_response` 的块必须给出响应，`copy_response` 就是"把上游那条 401 原样写回去"；漏了它时非文档导航的 401 会变成空响应。
- **尾部那个 `:@@GATEWAY_PORT@@` 兜底站点是必要的。** 站点地址做主机匹配，Host 与权威不一致的请求不进入本站点。Caddy 对"监听地址上没有站点匹配"的请求返回 **200 空响应**——不是 403、不是 404，浏览器上是一片空白。这条空白页极难归因，因此显式给一个能读懂原因的答案。实测：`Host: evil.example` 时未加兜底站点得到 200 空响应，加上后得到 421 与提示文本；兜底站点不影响已声明站点的证书签发与握手。兜底站点不带 `log` 段，因此 421 请求不进访问日志：原因已经写在页面上，而把它记进日志只会让两个站点争用同一个日志文件。
- **`stream_timeout 24h`**：给长连接一个上限，避免陈旧连接永久占用；客户端会在被切断后自动重连。
- **上游写成一个具名片段 `(dsh-relay-upstream)`，两个分支各 `import` 一次。** 两个分支必须给出完全相同的响应，重复一份 `reverse_proxy` 时最容易在改动里只动一处；`caddy validate` 对这两条路径不做交叉检查。
- **`header_down Set-Cookie "$" "; Secure"` 按整个值匹配再追加**：与 DSH 的属性顺序无关，也不会给本来就带 `Secure` 的响应留下重复属性。换成 `dsh-auth-` 前缀的定点写法会在 DSH 调整属性顺序时静默失效，换成站点级 `header` 则要么不生效（未延迟）、要么连带改写 Caddy 自己写的 `relay_session`；理由与实测结论见上一节。
- 写入后跑一次 `caddy fmt --overwrite`：不格式化时 `caddy validate` 每次都会打出 `Caddyfile input is not formatted` 警告，把真正的错误淹掉。

### 内网证书的续签

Caddy 的内网签发者自己负责续签，中继上不需要 cron 也不需要 `openssl`：根证书 10 年，中间证书 1 年，叶子 90 天。

### Cookie 的 `Secure` 由中继补上

DSH 自己下发的浏览器 Cookie 是 `Max-Age; Path=/; Expires; HttpOnly; SameSite=Strict`，**没有 `Secure`**（`packages/client/connection/src/browser-auth.ts` 的 `sessionCookie()`，也是整个 DSH 里唯一的 `set-cookie`）。插件不修改 DSH 源码，因此补这一位只能在中继上做。

RFC 6265 第 8.3 节把这件事说得很直白：走安全信道时服务器应当给每个 Cookie 加 `Secure`，否则"安全信道提供的保护基本是空的"。上游定义里的 `header_down Set-Cookie "$" "; Secure"` 把每个 `Set-Cookie` 的值整体匹配并在末尾追加：`header_down` 的匹配操作数是正则（RE2），`$` 命中任意值的末尾，替换值按字面写入。Cookie 的值里不能出现 `;`（RFC 6265 第 4.1.1 节），所以追加上的 `; Secure` 不可能被并进值里。

匹配整个值而不是 `dsh-auth-` 前缀，是为了与 DSH 的属性顺序无关。定点写法能过校验也确实工作——实测 `header_down Set-Cookie "(^dsh-auth-.*SameSite=Strict)$" "$1; Secure"` 对 DSH 当前发出的 Cookie 追加成功——但它把正确性绑在"`SameSite=Strict` 恰好是最后一个属性"上。实测四种 Cookie 下它的行为：属性顺序不变时追加成功；`SameSite=Strict` 不在末尾时不追加，Cookie 静默地失去 `Secure`；本来就带 `Secure` 时变成 `Secure; Secure`；非 `dsh-auth-` 的 Cookie 不碰。第二种是本设计唯一不能接受的失败：不报错、页面照常工作，只是保护没了。`$` 那种写法没有这个失败模式，代价是非 DSH 的 Cookie 也会被追加，而这个代价为零——上游只有 DSH 一个进程，中继自己的 `relay_session` 由 Caddy 写、不经过 `header_down`。

站点级的 `header` 指令也能做到，但必须延迟执行，这是实测出来的差别。`header Set-Cookie "$" "; Secure"`（既不带 `>` 也不带 `defer`）对代理响应完全不生效，Cookie 原样穿过；写成 `header >Set-Cookie "$" "; Secure"` 或在块里加 `defer` 才生效。Caddy 文档说明非延迟的头部操作在代理写出响应头之前就执行完了。延迟之后它面对的是最终的头集合，因此会把 Caddy 自己在同一站点里写的 `relay_session` 一起改写（实测得到 `…SameSite=Lax; Secure`，多出一个 `Secure`）；要用它就得再加一层只认 `dsh-auth-` 的锚定，于是又回到上面那种顺序依赖。`header_down` 只看上游那一份响应，Caddy 自己写的 Cookie 不在其中，因此不需要锚定就能既覆盖 DSH 的 Cookie、又不碰 `relay_session`。

两个分支——会话 Cookie 直通与口令分支——共用同一份上游定义 `(dsh-relay-upstream)`，就是为了让这条改写只有一处，不会只改一边。

### 只有一个 HTTP 入口

中继上对外只有 `gateway.port` 一个 HTTP 服务端口（另有管理用的 `sshd`，它不解析 Cookie）。除了缩小攻击面，这里还有一条 Cookie 层面的理由：RFC 6265 第 8.5 节说明**Cookie 不按端口隔离**，同一台主机另一个端口上的服务既读得到也写得到同一个 Cookie。DSH 的 Cookie 名只由权威的 host 决定、不带端口信息，所以中继上只要多开一个能吃 Cookie 的服务端口——明文 HTTP 的，或另一个 HTTPS 站点——它就可能拿到一个能通过第三层校验的会话 Cookie。封掉这条路只能靠"不存在第二个端口"，这一条不设配置项。

因此不写 `http://` 站点块，不做 80→8443 跳转，也不为任何别的用途在中继上新增监听。IP 字面量下 HSTS 不可用（RFC 6797 排除 IP 字面量），明文入口没有浏览器侧的兜底：DSH 的 Cookie 虽然现在带上了 `Secure`，但那是中继补的，而明文端口上的服务根本不经过 Caddy，也就绕过了这次改写。

Caddy 主机上还可能有一份**不是插件写入**的明文站点：apt 包安装时会写出发行版自带的 `/etc/caddy/Caddyfile`，它底部是一个 `:80` 站点，用 `file_server` 提供 `/usr/share/caddy` 下的 "Caddy works!" 页面。插件把托管块放在文件顶部，并刻意保持块外内容原样，所以那个站点会继续存在，`http://<权威不带端口>/` 对互联网上任何人都返回 200 与那一页。插件既不删除也不改写块外的内容；要收掉这个面，由操作者从 `/etc/caddy/Caddyfile` 里删掉那段 `:80` 块，再 `caddy reload --config /etc/caddy/Caddyfile`。第 13 步记录里的 `中继对外监听：…` 是发现它的方式，见 [bootstrap.md](bootstrap.md) 与 [operations.md](operations.md)。

兜底站点是同一个 Caddy 实例里 `8443` 上的另一个站点，不新增监听端口；`127.0.0.1:@@RELAY_PORT@@` 上的隧道端点只绑在 loopback，不对外。

## 4. 网络与防火墙

| 位置 | 规则 | 理由 |
| --- | --- | --- |
| 云安全组 | 入站 `tcp/8443` 对 `0.0.0.0/0` | 唯一公网入口 |
| 云安全组 | 入站 `tcp/22` 只对管理来源与内网主机的公网出口 | 管理面不应全网开放 |
| 云安全组 | 其余入站全部拒绝 | |
| 主机防火墙 | 允许 8443、22（同上）；拒绝其余 | 防安全组之外的路径 |
| `sshd` | 不监听额外端口 | 只用 22 |
| Caddy | 只监听 8443 | 不做跳转，不加第二个站点；发行版自带的 `:80` 站点按第 3 节由操作者删除 |

**不要开放 18080。** 它只应在 loopback 上，由 `sshd` 绑定、由 Caddy 连接。检查方法见上面的 `ss -ltnp`。

**对外只应有一个 HTTP 端口。** `ss -ltnp` 里除 `gateway.port` 与 `sshd` 之外的任何监听都要问清来路：多一个能吃 Cookie 的端口就多一条绕开第三层的路，理由见第 3 节的"只有一个 HTTP 入口"。插件只在 Caddyfile 里写两个站点，两者共用 `gateway.port`；发行版自带的 `:80` 站点是最常见的那一个额外监听，按第 3 节删除。

中继所在的云厂商安全组与主机防火墙都是**中继管理员**的职责，插件不改（改防火墙有把管理连接一起关掉的现实风险）。因此它是"必须成立的前置条件"之一，见 [security.md](../security.md)。

## 5. 防爆破

两个入口分开处理：SSH（管理面与隧道）与 Caddy（8443 的网关口令）。

### SSH 侧

先界定要防的是什么。隧道用公钥认证，`relay` 账号的 `authorized_keys` 带 `restrict`，**口令爆破在协议层面不可能成功**——没有口令可猜。剩下的三个真实目标是：全网扫描造成的日志与连接噪声、利用 sshd 自身漏洞的连接洪泛、以及最后一小节单说的"把自己封掉"。

**第 0 层：让 22 不可达。** 云安全组把入站 `tcp/22` 收到管理来源与内网主机的公网出口 IP。隧道是内网主机主动外连的，所以白名单里必须有家里的出口地址；家里是动态 IP 或 CGNAT 时这条用不了，CGNAT 下按 IP 封还会误伤同地址的其他用户，只能依靠下面几层。

**第 1 层：只认公钥。** 即第 2 节的 `Match User relay` 与 `restrict` 前缀。这一层决定爆破能否成功，其余各层只决定噪声大小。

**第 2 层：sshd 自带的来源惩罚（OpenSSH ≥ 9.8）。** `PerSourcePenalties` 自 9.8 起默认开启：`authfail:5s`、`invaliduser:5s`、`noauth:1s`、`grace-exceeded:10s`、`crash:90s`，累计到 `min:15s` 才开始拒绝，单一来源最多累计到 `max:10m`；`PerSourceNetBlockSize` 默认 `32:128`，按单个地址计算。用 `ssh -V` 确认版本：Ubuntu 22.04（8.9p1）与 24.04（9.6p1）都**没有**这个功能，而验证过的中继是 Ubuntu 26.04（codename `resolute`）上的 `OpenSSH_10.2p1 Ubuntu-2ubuntu3.2`，`persourcepenalties` 已按默认值生效。

这里有一条与插件直接相关的相互作用：`authfail:5s` 配上 `min:15s` 意味着**连续三次认证失败就会触发拒绝**，而插件的重连退避序列从 1s 起。公钥配置错误（`authorized_keys` 权限不对、路径写错、`permitlisten` 端口与 `tunnel.relayPort` 不符）会让内网主机在十几秒内把自家出口 IP 送进惩罚名单，最长 10 分钟连不上，现象是"隧道连不上，手动 `ssh` 也连不上"。这是需要人工介入的故障，加大重试解决不了；出口 IP 固定时可用 `PerSourcePenaltyExemptList` 排除它，否则应当让它失败并告警。诊断入口见 [operations.md](operations.md)。

**第 3 层：fail2ban 的 sshd jail（可选）。** 目标发行版没有内置惩罚时才需要补充，验证过的 26.04 中继已有第 2 层，因此那里不需要装它。`deploy/fail2ban/jail.d/jail-sshd.local`：

```ini
[sshd]
enabled  = true
maxretry = 3
findtime = 600
bantime  = 3600
ignoreip = 127.0.0.1/8 <管理来源> <内网主机的公网出口 IP>
```

模板里这两个地址写成 `@@ADMIN_SOURCES@@` 与 `@@HOME_EGRESS_IP@@`，由使用者自己填：插件不安装这个 jail，也不猜地址。Caddy 侧的那份 jail 同样用 `@@HOME_EGRESS_IP@@`，但那一份是引导安装并**自动填**的，见 [第 3 节](#caddy-侧8443-网关)。

发行版自带的 `filter.d/sshd.conf` 已覆盖需要匹配的日志行，不必自己写 filter。`ignoreip` 必须包含内网主机的出口地址与管理来源，否则会像上一段那样把隧道一起封掉。插件不自动改动防火墙与 fail2ban——`ignoreip` 依赖用户才知道的出口 IP。

**第 4 层：收窄 sshd 自身的暴露面。** `MaxStartups 10:30:100`（默认）限制未认证并发；`LoginGraceTime` 从默认 120 降到 30；`MaxAuthTries` 从默认 6 降到 3。换非标准端口能挡掉绝大多数全网扫描，但那属于降噪而不是安全措施，只有与安全组白名单一起用才值得。

**第 5 层：保持 openssh 有安全更新。** 这一条比前面几条加起来更重要：连接洪泛不只是噪声问题，2024 年的 regreSSHion（CVE-2024-6387）就是要在 8.5p1–9.7p1 上持续连接 6–8 小时才可能利用成功。限制连接频率直接压缩了这类攻击的可行性。

### Caddy 侧（8443 网关）

`basic_auth` 用 bcrypt 校验，单次尝试成本已很高，但没有内置锁定。用系统自带的 fail2ban 读 Caddy 的 JSON 访问日志，`deploy/fail2ban/` 下两个文件：

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
port     = 8443
filter   = caddy-dsh-relay
logpath  = /var/log/caddy/dsh-relay-access.log
ignoreip = 127.0.0.1/8 <内网主机的公网出口 IP>
maxretry = 5
findtime = 600
bantime  = 3600
```

- 日志是 JSON 单行，`failregex` 按行匹配即可。`remote_ip` 在行里排在 `status` 之前，所以"取地址 + 判状态"可以写成一条正则，不需要 fail2ban 的 JSON 解析。实测这两个字段的顺序与上面一致，`Authorization` 头也已经被 Caddy 记成 `REDACTED`。
- `port` 由引导按 `gateway.port` 替换；`logpath` 与 Caddyfile 的 `output file` 出自同一份模板，两者必须一致。
- `ignoreip` 里的出口地址由引导填，不需要手工维护：第 3 步的探测脚本在**提权之前**读一次 sshd 交给登录 shell 的 `SSH_CONNECTION`（`sudo` 会把它清掉，所以必须先取），第 9 步写 jail 时把它填进 `@@HOME_EGRESS_IP@@`。取不到就是空串，jail 退回默认封禁规则。这一条是必须的：部署第 13 步的公网自检会发出不带网关口令的请求，被记成一次 `basic_auth` 失败，而开着「随 DSH 启动自动部署」时每次重启都会跑一遍，反复重启就可能把操作者自己封掉。
- `bantime.increment` 值得开启：攻击者会被指数推开，它是 `[DEFAULTS]` 段的设置，因此模板把它放在同一个文件里。代价是操作者自己也可能触发它——实测中反复发出不带网关口令的请求（每次诊断都算一次 `basic_auth` 失败）把操作者自己的出口 IP 封掉了，症状是公网端口直接 `Connection refused`，而中继上 Caddy 仍在 `*:8443` 监听、隧道也活着。`sudo fail2ban-client status caddy-dsh-relay` 看 `Banned IP list`，`sudo fail2ban-client set caddy-dsh-relay unbanip <你的 IP>` 解封；`ignoreip` 只兜住本机的出口地址，从别的网络诊断时仍要按这条处理。
- 规则只统计网关口令失败：Caddy 的 `basic_auth` 拒绝请求时返回 `401` 并带上 `Www-Authenticate` 响应头，`failregex` 因此要求同一行同时出现 `"status":401` 与 `Www-Authenticate`。DSH 在浏览器还没有 DSH 会话 Cookie 时也回 `401`，但那条日志行带非空的 `user_id` 且没有 `Www-Authenticate`——首访时这是正常现象，把它计入会在正常使用中把操作者自己封掉。实测：连续六次这种 DSH 401 没有让 jail 的失败计数变化，一次错误口令则让它加一。
- Caddy 侧的 jail 由引导安装（第 9 步的一部分），因为它的 `logpath` 与 `port` 与 Caddyfile 出自同一份模板，手工同步容易错位。sshd 侧的 jail 不自动安装：它的 `ignoreip` 依赖用户才知道的内网出口地址，写错会连同隧道一起封掉，因此只作为模板提供。这两类文件的所有权约定（托管块、整文件标记）见 [deploy/README.md](../../deploy/README.md)。
- fail2ban 的封禁动作默认走 iptables；中继上只有 `nft` 而没有 `iptables` 兼容层时，要在 `[DEFAULTS]` 里把 `banaction` 换成 `nftables-multiport`，否则 jail 会启动但一条规则都装不上。

网关口令是这条通路上唯一可猜的凭据，爆破在这一层就被挡住，不会打到内网主机。

## 6. 明确禁止

1. **不写 `header_up Host` / `header_up Origin`。** 见 [security.md](../security.md)。
2. **不提供明文入口，也不新增第二个 HTTP 端口。** 不写 `http://` 站点块，不做 80→8443 跳转；`gateway.port` 是中继上唯一的 HTTP 服务端口，理由见第 3 节。
3. **不把 18080 暴露到公网。** 隧道端点是明文 HTTP。
4. **不关闭 `StrictHostKeyChecking`。** 内网侧固定为 `yes`；需要换主机密钥时更新 `known_hosts` 并记录指纹。
5. **不在中继上放 DSH 凭据。** 中继只需要 SSH 公钥、TLS 私钥/证书、Caddyfile。
6. **不配置 `trusted_proxies`。** 前面没有别的代理；配置它会引入 XFF 伪造面。
7. **不把 CA 私钥复制出来。** 根证书只有公钥，可以公开分发；私钥留在 Caddy 的数据目录里。
8. **不让插件改防火墙与全局 sshd 认证策略。** 这两处的错误会把管理员锁在门外。
9. **不让转发前预检做第二件事。** 它只查 `tunnel.relayPort`、只杀属主为 `relay`、可执行文件为 `sshd` 或 `sshd-session` 的进程。"顺手重启 Caddy""顺手清日志"之类的动作都不属于它——这是整份设计里唯一一处运行期提权，面越窄越好。

## 7. 部署后自检清单

引导结束时这些都应成立；手工部署或排障时照抄。`<authority>` 是 `vps.host:gateway.port`，`<ca>` 是取回的根证书路径：

```
# 中继主机
ss -ltnp | grep -E '18080|8443'         # 18080 必须是 127.0.0.1
ss -ltnp                                # 对外只应有 8443 与 sshd；出现 :80 说明发行版自带的站点还没删，见第 3 节
sshd -T -C user=relay,host=relay,addr=127.0.0.1 | grep -iE 'gatewayports|permitopen|allowtcpforwarding|permittty|clientaliveinterval|clientalivecountmax|unusedconnectiontimeout'

# 未认证且不是文档导航：期望 401，且响应里没有 set-cookie
curl -sS --cacert <ca> -D- -o /dev/null https://<authority>/ | grep -iE '^HTTP|^set-cookie'

# 首访：裸地址 + 文档导航的 Accept，未带任何 Cookie
# 期望 200、x-dsh-web-relay-handshake: transition、**没有 location**，
# 两条 Cookie（relay_session 与 dsh-auth-…）都带 Secure。
# 200 而不是 303 是这条设计成立的条件，不是风格：Safari 不保存 3xx 上的
# Set-Cookie，回 303 时 iOS 首访会一直跳到「发生了太多重定向」。
curl -sS --cacert <ca> -u me:<pw> -c <jar> -b <jar> -H 'Accept: text/html' -D- -o /dev/null https://<authority>/ | grep -iE '^HTTP|^location|^set-cookie|x-dsh-web-relay-handshake'

# 带着刚拿到的 Cookie 再取一次（浏览器 meta refresh 的那一步）：期望 200 界面，
# 响应体里有 __DSH_BOOT__，且没有换票标记头
curl -sS --cacert <ca> -u me:<pw> -c <jar> -b <jar> -H 'Accept: text/html' https://<authority>/ | grep -c __DSH_BOOT__

# 失效 Cookie 的恢复路径：改坏 dsh-auth-… 的值后跟跳转，期望两跳后 200
curl -sS --cacert <ca> -u me:<pw> -c <jar> -b <jar> -L -H 'Accept: text/html' https://<authority>/

# 隧道未连接：期望 502 且带可读提示，不是空响应
curl -sS --cacert <ca> -u me:<pw> https://<authority>/

# 明文端口不可用
curl -sS -o /dev/null -w '%{http_code}\n' --max-time 3 http://<authority>/
```

三条必查项：

1. **未认证请求不得带 `set-cookie`。** 带上就说明 `handle` 段漏了 `route`，任何人都能领到会话密钥并绕开口令。这是整份清单里最容易在改动中被破坏、又最不显眼的一条。
2. **首访必须被带到换票点，而且那一跳必须是 200。** 第 4 条命令要拿到 `200`、`x-dsh-web-relay-handshake: transition`、**没有 `location`**，且两条 Cookie 都在。拿到 `401` 说明中继上的 Caddyfile 还是旧版（没有 `@noDsh` 改写）；拿到 `303` 说明中继上跑的还是旧版插件——那一版在 Safari 上会无限跳转，重新部署一次即可。引导第 13 步的自检会自己走完这三跳并认这个标记头，失败时直接写在步骤说明里。
3. **认证成功后必须带 `relay_session`。** 缺它时 WebSocket 握手会失败，而普通请求看起来一切正常。
4. **认证成功后每条 `set-cookie` 都要带 `Secure`**，包括 DSH 自己那条 `dsh-auth-…`。缺它就说明 `header_down` 那一行掉了或落到了别处；`dsh-auth-…` 被追加成 `Secure; Secure` 不改变行为（重复的布尔属性浏览器忽略），但说明改写被换成了会重复追加的写法。这一条同样由第 13 步盯着。

另外核对一次证书链与有效期，确认 90 天的覆盖真的生效（少了 `intermediate_lifetime` 时这里会显示 7 天）：

```
openssl s_client -connect <authority> </dev/null 2>/dev/null | openssl x509 -noout -dates
openssl x509 -in /var/lib/caddy/.local/share/caddy/pki/authorities/dsh-relay/intermediate.crt -noout -dates
```
