# 配置参考

插件有三份配置，写入者与生命周期都不同：包内的行为旋钮、用户填的部署参数、插件自己写的运行记录。字段在这里集中列出，机制见 [modules/settings.md](modules/settings.md)。

## 插件 `Config`（包内 `cordis.patch.yml`）

行为旋钮随包发布，全部带默认值，用户不改也能运行。部署相关的地址、账号、口令**不在这里**。

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `logLabel` | `string` | `dsh-web-relay` | 所有日志与横幅的前缀 |
| `tunnel.relayPort` | `number` | `18080` | 中继上 loopback 反向转发端点端口；必须与 `permitlisten` 和 Caddy 上游三处一致 |
| `tunnel.backoffMs` | `number[]` | `[1000, 2000, 5000, 15000, 30000]` | 隧道重连退避；用尽后停在最后一项 |
| `tunnel.healthyAfterMs` | `number` | `10000` | 子进程存活超过此时长才把退避重置到第一项 |
| `tunnel.graceMs` | `number` | `3000` | 拆除时先发 `SIGTERM` 再等这么久才 `SIGKILL` |
| `tunnel.extraOptions` | `Record<string,string>` | `{}` | 追加给 `ssh` 的 `-o` 选项；键冲突时以插件自身的安全选项为准 |
| `bootstrap.stepTimeoutMs` | `number` | `120000` | 单个引导步骤的总超时（含 `apt` 安装） |
| `bootstrap.commandTimeoutMs` | `number` | `30000` | 引导里单条远程命令的超时 |
| `bootstrap.connectTimeoutSec` | `number` | `10` | `ssh -o ConnectTimeout` |
| `entry.enabled` | `boolean` | `true` | 关掉后不注册 `/relay/enter`，只剩下依赖 Cookie 的路径 |
| `entry.banner` | `'on-generate' \| 'always' \| 'never'` | `on-generate` | 何时在终端打印书签 |
| `entry.maxFailures` | `number` | `20` | 同一来源 IP 在窗口内允许的 `/relay/enter` 失败次数 |
| `entry.lockoutMs` | `number` | `900000` | 超过上限后的锁定时长 |
| `selfCheck.publicProbe` | `boolean` | `true` | 引导结束后是否真的去请求一次公网权威 |
| `selfCheck.probeTimeoutMs` | `number` | `5000` | 自检请求超时 |

插件不假定 `dsh web` 的端口：它读 `ctx.webServer.port` 作为隧道目标端口，读 `ctx.webServer.host` 判断是否只绑在 loopback。

## `web-relay`（用户填的部署参数）

用户在 设置 ▸ 插件 ▸ Web Relay 卡片里填，落盘在 `$DSH_HOME/settings.yaml`（`0600`）。

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `vps.host` | `string` | 空 | 中继主机地址（IP 或主机名）。为空时插件只做本地准备，不引导 |
| `vps.port` | `number` | `22` | 管理连接的 SSH 端口 |
| `vps.user` | `string` | `root` | 管理账号。非 `root` 时引导的提权步骤会走 `sudo -S` |
| `vps.identityFile` | `string?` | 空 | 管理账号私钥路径。留空则用系统身份解析（`~/.ssh/config`、默认私钥、`SSH_AUTH_SOCK`） |
| `vps.password` | `secret?` | 空 | 管理账号口令。仅用于两处：`sudo -S` 提权；以及管理账号只能用口令登录时作为 SSH 口令（经 `SSH_ASKPASS` 助手提供，不落命令行） |
| `vps.hostKeyFingerprint` | `string?` | 空 | 期望的中继主机公钥指纹，`SHA256:…` 形式。留空时首次连接按 TOFU 记录并打印指纹 |
| `gateway.port` | `number` | `8443` | 公网入口 HTTPS 端口。权威即 `<vps.host>:<gateway.port>` |
| `gateway.password` | `secret?` | 空 | Caddy 网关口令，用户自选。插件只把它交给 `caddy hash-password`，明文不落中继的磁盘 |
| `tunnel.autoStart` | `boolean` | `true` | 参数齐全时是否自动拉起隧道 |
| `bootstrapRequest` | `number` | `0` | 递增即触发一次完整重新引导；保存表单会自动递增 |
| `entryRotateRequest` | `number` | `0` | 递增即轮换入口口令：插件生成新的 `entryKey` 并更新记录 |

标记为 `secret` 的字段在发给浏览器时被替换成"已设置 / 未设置"，值本身不出宿主进程；`settings.yaml` 里仍是明文，文件权限是 `0600`，目录 `0700`。

## `web-relay-record`（插件写的运行记录）

插件拥有这个命名空间，卡片只读回显。它是卡片唯一的宿主状态通道：卡片通过客户端 settings 作用域读它，不需要额外的 Remote 命名空间。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `state` | `'idle' \| 'bootstrapping' \| 'ready' \| 'failed'` | 引导与隧道的合并状态 |
| `updatedAt` | `string` | 最近一次记录更新的 ISO 时间 |
| `publicAuthority` | `string` | 已生效的权威，空字符串表示尚未生效 |
| `observedHostKeyFingerprint` | `string` | 首次连接时实地观察到（或按固定值校验通过）的中继主机公钥指纹 |
| `caFingerprint` | `string` | 中继 CA 根证书的 `SHA256:…` 指纹，供用户与 VPS 上 `data/pki/authorities/dsh-relay/root.crt` 核对 |
| `caUrl` | `string` | 根证书下载地址，即 `https://<publicAuthority>/relay/ca.crt` |
| `entryKey` | `string` | 稳定书签的 key 段；它就是书签 URL 的全部可变部分 |
| `gateway.sessionSecret` | `secret` | Caddy 会话 Cookie 的比对值，重新引导时保持不变，避免无谓地让手机重新登录 |
| `steps` | `{ id, title, status, detail }[]` | 最近一次引导的逐步结果，`status` 为 `ok`、`failed` 或 `skipped` |
| `lastError` | `string` | 最近一次失败的原文摘要，成功时为空 |

稳定书签由 `publicAuthority` 与 `entryKey` 组合而成：`https://<publicAuthority>/relay/enter?key=<entryKey>`。key 只是一层便利令牌，承担身份的是网关口令与 DSH 的权威绑定 Cookie，所以它允许在卡片里可见、可复制，见 [modules/entry.md](modules/entry.md)。

## 改动的影响面

| 改动的字段 | 插件动作 | 用户可见后果 |
| --- | --- | --- |
| `vps.host`、`gateway.port` | 重算权威 → 重解析 `connection` 行 → 重新引导 → 重启隧道 | DSH 的 Cookie 全部失效（Cookie 与权威绑定），手机要用新书签重新进入一次 |
| `gateway.password` | 重新哈希并 reload Caddy | 手机上的网关凭据失效，浏览器重新询问 |
| `vps.user`、`vps.port`、`vps.identityFile`、`vps.password` | 下一次引导使用新凭据 | 引导步骤用新凭据重跑一遍，已就绪的步骤快速跳过 |
| `vps.hostKeyFingerprint` | 与观察值比对 | 不匹配时引导停止在这一步，不会带着未验证的连接继续 |
| `tunnel.autoStart` 置为 `false` | 停隧道且不再自动拉起 | 公网入口返回隧道不可达页面 |
| `bootstrapRequest` 递增 | 完整重跑一遍引导 | 端口、证书、`authorized_keys` 都已就绪时很快结束 |
| `entryRotateRequest` 递增 | 生成新的 `entryKey` 并更新记录 | 旧书签立刻 404，需要用新书签重新收藏 |

换掉 `vps.host` 之后，旧中继上的 `relay` 用户、`sshd` 片段和 Caddyfile 会原样留着。插件不去清理别人的机器；清理步骤见 [modules/operations.md](modules/operations.md)。
