# deploy 模板

引导把这里的模板写到中继主机上。模板本身不带逻辑，只有占位符；替换、写入与回滚都由 [../docs/internals/bootstrap.md](../docs/internals/bootstrap.md) 描述的过程完成。

| 模板 | 安装到 | 占位符 |
| --- | --- | --- |
| `authorized_keys.snippet` | `/home/relay/.ssh/authorized_keys`（托管块） | `@@PUBLIC_KEY@@`、`@@RELAY_PORT@@` |
| `sshd_config.snippet` | `/etc/ssh/sshd_config.d/60-dsh-web-relay.conf`（托管块） | 无 |
| `Caddyfile.snippet` | `/etc/caddy/Caddyfile`（托管块） | `@@AUTHORITY@@`、`@@GATEWAY_PORT@@`、`@@SESSION_SECRET@@`、`@@BCRYPT_HASH@@`、`@@RELAY_PORT@@`、`@@GATEWAY_USER@@`（固定账号名） |
| `fail2ban/filter.d/caddy-dsh-relay.conf` | `/etc/fail2ban/filter.d/` | 无 |
| `fail2ban/jail.d/caddy-dsh-relay.conf` | `/etc/fail2ban/jail.d/` | `@@GATEWAY_PORT@@`、`@@HOME_EGRESS_IP@@`（引导从 `SSH_CONNECTION` 现取，取不到则为空串） |
| `fail2ban/jail.d/jail-sshd.local` | 手工安装，插件不写 | `@@ADMIN_SOURCES@@`、`@@HOME_EGRESS_IP@@` |

两种所有权约定：

- **托管块**（前三个）：模板里的 `# BEGIN dsh-web-relay` / `# END dsh-web-relay` 之间是插件拥有的内容，标记之外原样保留。重写时先删掉旧块再追加新块，因此可以重复执行。
- **整文件**（fail2ban 的两个）：文件首行的 `dsh-web-relay` 标记用于识别所有权。目标路径上已经存在同名文件而首行没有该标记时停下，不覆盖用户自己写的内容。

`Caddyfile.snippet` 里的全局选项块（`auto_https`、`pki`）在整个 Caddyfile 里只能出现一次。写入前检查块外是否已经声明过，命中就停下并报出那一行。具名片段 `(dsh-relay-upstream)` 的名字同样必须唯一，一并检查。

模板里的两个站点共用 `@@GATEWAY_PORT@@`，具名片段被两个分支各 `import` 一次。改动这份模板时，`header_down Set-Cookie "$" "; Secure"` 那一行是唯一给 DSH 的 Cookie 补 `Secure` 的地方，必须留在 `reverse_proxy` 内：站点级 `header` 不延迟时对代理响应不生效，延迟后又会连 Caddy 自己写的 `relay_session` 一起改写；按 `dsh-auth-` 前缀定点匹配则会在 DSH 调整属性顺序时静默失效。三种写法的结论见 [../docs/internals/relay-host.md](../docs/internals/relay-host.md) 第 3 节。

占位符在替换后不应残留 `@@`：写入完成后回读一次，发现残留按失败处理。

模板改动后按 [../docs/internals/relay-host.md](../docs/internals/relay-host.md) 第 7 节的清单核对，其中"未认证请求不得带 `set-cookie`"、"认证成功的每条 `set-cookie` 都带 `Secure`"与 `intermediate_lifetime` 三项最容易在改动中被破坏。
