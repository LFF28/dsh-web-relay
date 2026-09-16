# deploy 模板

引导把这里的模板写到中继主机上。模板本身不带逻辑，只有占位符；替换、写入与回滚都由 [../docs/modules/bootstrap.md](../docs/modules/bootstrap.md) 描述的过程完成。

| 模板 | 安装到 | 占位符 |
| --- | --- | --- |
| `authorized_keys.snippet` | `/home/relay/.ssh/authorized_keys`（托管块） | `@@PUBLIC_KEY@@`、`@@RELAY_PORT@@` |
| `sshd_config.snippet` | `/etc/ssh/sshd_config.d/60-dsh-web-relay.conf`（托管块） | 无 |
| `Caddyfile.snippet` | `/etc/caddy/Caddyfile`（托管块） | `@@AUTHORITY@@`、`@@GATEWAY_PORT@@`、`@@SESSION_SECRET@@`、`@@BCRYPT_HASH@@`、`@@RELAY_PORT@@` |
| `fail2ban/filter.d/caddy-dsh-relay.conf` | `/etc/fail2ban/filter.d/` | 无 |
| `fail2ban/jail.d/caddy-dsh-relay.conf` | `/etc/fail2ban/jail.d/` | `@@GATEWAY_PORT@@` |
| `fail2ban/jail.d/jail-sshd.local` | 手工安装，插件不写 | `@@ADMIN_SOURCES@@`、`@@HOME_EGRESS_IP@@` |

两种所有权约定：

- **托管块**（前三个）：模板里的 `# BEGIN dsh-web-relay` / `# END dsh-web-relay` 之间是插件拥有的内容，标记之外原样保留。重写时先删掉旧块再追加新块，因此可以重复执行。
- **整文件**（fail2ban 的两个）：文件首行的 `dsh-web-relay` 标记用于识别所有权。目标路径上已经存在同名文件而首行没有该标记时停下，不覆盖用户自己写的内容。

`Caddyfile.snippet` 里的全局选项块（`auto_https`、`pki`）在整个 Caddyfile 里只能出现一次。写入前检查块外是否已经声明过，命中就停下并报出那一行。

占位符在替换后不应残留 `@@`：写入完成后回读一次，发现残留按失败处理。

模板改动后按 [../docs/modules/relay-host.md](../docs/modules/relay-host.md) 第 7 节的清单核对，其中"未认证请求不得带 `set-cookie`"与 `intermediate_lifetime` 两项最容易在改动中被破坏。
