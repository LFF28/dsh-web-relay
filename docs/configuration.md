# 配置参考

插件有三份配置，写入者与生命周期都不同：包内的行为旋钮、用户填的部署参数、插件自己写的运行记录。字段在这里集中列出，机制见 [modules/settings.md](modules/settings.md)。

## 插件 `Config`（包内 `cordis.patch.yml`）

行为旋钮随包发布，全部带默认值，用户不改也能运行。部署相关的地址、账号、网关口令**不在这里**。

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
| `entry.enabled` | `boolean` | `true` | 关掉后换票点 `/relay/enter` 只回 `403` 说明，公网入口只剩依赖已有 Cookie 的路径；中继侧的改写与跳转不变 |
| `selfCheck.publicProbe` | `boolean` | `true` | 引导结束后是否真的去请求一次公网权威 |
| `selfCheck.probeTimeoutMs` | `number` | `5000` | 自检请求超时 |

插件不假定 `dsh web` 的端口：它读 `ctx.webServer.port` 作为隧道目标端口，读 `ctx.webServer.host` 判断是否只绑在 loopback。

转发前预检没有对应字段。它只在 `tunnel.relayPort` 确实被占、且持有者是本部署残留的 `sshd` / `sshd-session` 进程时才动手，因此不提供开关，理由见 [modules/tunnel.md](modules/tunnel.md)。

## `deployment`（用户填的部署参数）

用户在 **设置 ▸ 远程访问** 页里填，点「部署」才写下去。它是插件 `Config` 里的一棵 volatile 子树，落盘在 profile 的 `cordis.patch.yml`（`0600`，不是 git 仓库的一部分）。

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `vps.host` | `string` | 空 | 中继主机地址（IP 或主机名）。为空时插件只做本地准备，不引导 |
| `vps.port` | `number` | `22` | 管理连接的 SSH 端口 |
| `vps.user` | `string` | `root` | 管理账号。引导的提权步骤与转发前预检连中继都用它；非 `root` 时调用 `sudo`，该账号必须免密 sudo |
| `vps.identityFile` | `string?` | 空 | 管理账号私钥路径。留空则用系统身份解析（`~/.ssh/config`、默认私钥、`SSH_AUTH_SOCK`） |
| `vps.hostKeyFingerprint` | `string?` | 空 | 期望的中继主机公钥指纹，`SHA256:…` 形式。留空时首次连接按 TOFU 记录并打印指纹 |
| `gateway.port` | `number` | `8443` | 公网入口 HTTPS 端口，也是中继上唯一的 HTTP 端口。权威即 `<vps.host>:<gateway.port>` |
| `gateway.password` | `secret?` | 空 | 网关口令，用户自选，手机每次进入时在浏览器口令框里输入；账号名固定为 `me`，不是配置项，口令弹窗也不会提示它（设置页「公网入口」一节有文本提示）。**每次部署都要重填**：它是 `secret` 字段，从不回传浏览器。填了地址却没有口令时写入被拒。插件只把它交给 `caddy hash-password`，明文不落中继的磁盘 |
| `deploy.request` | `number` | `0` | 部署计数：点一次部署加一。它让"一个字都没改也要重来一遍"成为一次真实的文档变更；宿主不读它 |
| `deploy.autoDeploy` | `boolean` | `false` | 这次部署是否要求随 DSH 启动自动部署。只是请求：启动时还要看记录里上次部署是不是成功，见下面的"每次启动会做什么"。设置页上就是这个开关 |

标记为 `secret` 的字段在发给浏览器时被替换成"已设置 / 未设置"，值本身不出宿主进程；profile 补丁里仍是明文，文件权限是 `0600`。

### SSH 压缩

`tunnel.extraOptions.Compression: "yes"` 打开 SSH 压缩（`ssh -C`）。它写在 profile 补丁的这一行里，不在包自己的 `cordis.patch.yml`——patch 的 `config` 是**整体替换**而不是深合并，而设置页写部署参数时会往 profile 层写同一行的 `config`；两个地方都写就等于谁后生效谁说了算。

它压的是 **本机 → 中继** 那条快腿（实测约 3.3 MB/s），中继上的 sshd 在写进 `127.0.0.1:18080` 之前就已解压，所以 **中继 → 手机** 那条慢腿（约 0.35 MB/s）的字节数一个都不减。**它不是「手机上点会话就重连」的解**，理由与实测数据见 [modules/settings.md](modules/settings.md) 的「传输与心跳」。

### 连接复用（无需配置）

管理路径（引导、预检、观测）默认用 `ControlMaster=auto` 复用一条 TCP 连接，套接字放在 `$DSH_HOME/dsh-web-relay/ssh/cm/`，空闲 60 秒后自行清理。它没有对应的配置字段：引导要开约 12 条短命令，而到中继的路径有丢包，独立握手会让整轮成功率低到不可用，所以这不是一个可选优化。隧道不共用（它有自己的重连语义）。实测数据、`%C` 的账号隔离与长度上限的处理见 [modules/bootstrap.md](modules/bootstrap.md) 的「为什么复用连接」。

### 配置前的前提

插件不配置中继的管理登录，它假定那一步已经由用户完成：

- **公钥登录可用。** `vps.user` 能用密钥登录（`vps.identityFile` 指定，或系统身份解析能找到）。插件不做口令登录，也没有"管理账号口令"这个字段。
- **该账号免密 sudo。** 非 `root` 账号执行 `sudo` 时不提示输入口令。插件只调用 `sudo -n`（非交互），需要口令时立即失败并如实报出，不会挂起等待输入。

这两条是**前置条件而不是待配置项**：中继上没有本插件的任何代码，管理登录属于主机管理员的既有设置，插件不该在别人的机器上改 SSH 认证策略。引导第 3 步实地探测这两条，报告 `id -u`、`sudo -n true` 的退出码与 `ss` 是否可用，缺失时停在那里并给出原文。

因此 `deployment` 这一节里唯一的秘密是 `gateway.password`。

## 运行记录（插件写的宿主状态）

它不在配置文档里，因为 0.2 的设置文档只接受 volatile 字段的写入——记录是插件写的状态，不是用户配置。它落成 `$DSH_HOME/dsh-web-relay/record.json`（`0600`），只读出口是 `GET /api/web-relay.record`（挂在 DSH 共享 API 通道下，因此在认证围栏之后）。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `state` | `'unconfigured' \| 'bootstrapping' \| 'ready' \| 'failed'` | 引导状态 |
| `tunnelState` | `'stopped' \| 'starting' \| 'running' \| 'backing-off'` | 隧道状态；页面直接读这一条，不走宿主 RPC |
| `updatedAt` | `string` | 最近一次记录更新的 ISO 时间 |
| `publicAuthority` | `string` | 已生效的权威，空字符串表示尚未生效 |
| `observedHostKeyFingerprint` | `string` | 首次连接时实地观察到（或按固定值校验通过）的中继主机公钥指纹 |
| `caFingerprint` | `string` | 中继 CA 根证书的 `SHA256:…` 指纹，供用户与 VPS 上 `data/pki/authorities/dsh-relay/root.crt` 核对 |
| `caPem` | `string` | 根证书 PEM 全文（约 810 字节），供设置页的「下载根证书」按钮存成本地文件。刻意**不**剔除：它只有公钥材料，本来就要装到设备上。没走到第 10 步的部署里是空串 |
| `gateway.sessionSecret` | `secret` | 网关会话 Cookie 的比对值；每次部署用 `randomBytes(24)` 的 base64url 重新生成。**它绝不离开宿主**：`recordView()` 的白名单把整个 `gateway` 一节挡在响应之外 |
| `steps` | `{ id, title, status, detail }[]` | 最近一次引导的逐步结果，`status` 为 `ok`、`failed` 或 `skipped`；第 13 步的 `detail` 另带 `中继对外监听：…` |
| `lastError` | `string` | 最近一次失败的原文摘要，成功时为空 |
| `lastPreflight` | `{ outcome, message }` | 最近一次转发前预检的结果 |

访问地址完全由 `publicAuthority` 决定：`https://<publicAuthority>/`。它不含任何秘密，因此可以放心收藏、同步与备份；承担身份的是网关口令与 DSH 的权威绑定 Cookie，首次访问时由中继在内部带路到换票点，见 [modules/entry.md](modules/entry.md)。

记录里的 `gateway.sessionSecret` 与 `caPem` 是这份文件里唯一的敏感与非敏感特例，`recordView()` 的白名单逐字段决定谁能出网，见 [modules/settings.md](modules/settings.md)。

## 一次部署做了什么

改动不在写入的那一刻生效——除**点部署**（或手工改 profile 补丁里的 `deployment`）之外，插件不会重新配置中继。每次部署都是一遍完整的引导第 0–13 步，没有"只重做变了的那一半"这种逻辑；下面列出的是这些字段各自带来的后果。

| 改动的字段 | 部署时的动作 | 用户可见后果 |
| --- | --- | --- |
| `vps.host`、`gateway.port` | 权威按新值重算 → 重解析 `connection` 行 → 引导 → 重启隧道 | 权威只保留新的那一个；DSH 的 Cookie 全部失效（Cookie 与权威绑定），手机要用新地址重新进入一次 |
| `gateway.password` | 重新哈希并 reload Caddy，同时重置 `gateway.sessionSecret` | 所有设备的网关会话立刻失效，下次进入重新询问口令 |
| `vps.user`、`vps.port`、`vps.identityFile` | 引导与转发前预检改用新凭据 | 引导步骤用新凭据重跑一遍，已就绪的步骤快速跳过 |
| `vps.hostKeyFingerprint` | 与观察值比对 | 不匹配时引导停止在这一步，不会带着未验证的连接继续 |
| `deploy.autoDeploy` 打开 | 这次部署照常建立并验证隧道；差别只在以后的重启 | 之后每次 DSH 启动都会自动重跑一遍完整部署，因此也会重算口令哈希与会话密钥——手机下次进入要重输一次口令 |
| `deploy.request` 递增 | 本身就是一次部署 | 端口、证书、`authorized_keys` 都已就绪时很快结束 |

部署失败时配置文档留在失败的那一份，权威围栏也只含它，旧地址因此打不开——重新点一次部署即可重来，引导是幂等的。

## 每次启动会做什么

启动 DSH 时插件先把当前权威注册进 Host/Origin 围栏，然后按一个合取式决定动不动手：

```
记录里 state === 'ready'     上次部署成功了
deploy.autoDeploy            这次部署要求随启动自动部署
```

两个都成立 → 自动跑一遍完整部署（第 0–13 步，和点部署完全一样），因此隧道也在那一次部署里被建立。任一不成立 → 什么都不做：不部署、不起隧道，公网入口返回中继那行"隧道未连接"，只在日志里补一行回环自检的结论。

「打开要部署成功才生效」不需要额外字段：引导只在 `ready` 与 `failed` 之间收尾，失败的部署把记录写成 `failed`，开关随之失效，再成功一次又自动生效。**一次启动最多尝试一次，失败不重试**——插件会停在那次失败上，直到下一次重启或有人点一次部署。

换掉 `vps.host` 之后，旧中继上的 `relay` 用户、`sshd` 片段和 Caddyfile 会原样留着。插件不去清理别人的机器；清理步骤见 [modules/operations.md](modules/operations.md)。
